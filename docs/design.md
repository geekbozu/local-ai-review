# Design

Why this exists, what was measured, and which choices were close calls. The short version is that a code review
is the one part of CI a local model does well, and the parts that make it work are unglamorous: anchor comments by
quoted text rather than line numbers, bound the loop, and check afterwards that the agent actually opened every
changed file.

## 1. Problem

Deterministic gates check **mechanism**: types compile, assertions pass, policies admit and refuse. None of them
reads a diff and asks whether it does what it said it would, and none follows a hunch into the next file. That is
human work, and it is the work that gets skipped when a PR is large.

A model can do it — read the change, follow a suspicion into a caller, run something to prove a claim — provided
three things hold: it is free per run, it has the whole checkout, and its output can be trusted enough to post as
inline comments on the right lines.

## 2. Findings

Measured against one locally hosted box (a 35B MoE, ARM CPU plus an NPU, 80 GB) and a self-hosted runner pool.
Numbers are that hardware's; the shapes generalise.

| # | Fact |
|---|---|
| F1 | Findings are cheap; the value is escalation — following a hunch into a caller and proving it. That needs tools and iteration, not one prompt per file |
| F2 | The model is good at **copying a line** and bad at **counting to a line**. Asking for the text and resolving it afterwards is the difference between a comment on a line and a comment near one |
| F3 | A review comment may only attach to a line present in the diff; one number outside it fails the whole review with `422`. So the poster, not the model, must decide what is anchorable |
| F4 | Thinking is a request parameter, and it **counts toward the output ceiling**. At a ceiling too small for the reasoning it chooses, a model spends the whole budget thinking and returns nothing — which reads as a refusal and is not one |
| F5 | Output ceilings are set in more than one place: the request, and the client's model entry. Raising only one moves nothing |
| F6 | Thinking at low effort produced better-reasoned comments for ~1.5x the wall time and one extra finding that thinking-off had merged away |
| F7 | Prompt caching is real: a repeat of a 10.8k-token prefix answered in ~1.1 s against ~16.8 s cold, and the cache survives an append-only transcript — so a long run is decode-bound, not prefill-bound |
| F8 | A mid-conversation **system** message folds into the leading prompt and invalidates the cache from that point. Steering must be a user message |
| F9 | Decode speed depends on output: ~67 tok/s on a repetitive counting stream, ~24 tok/s on prose, same model and session. Plan on the slow number |
| F10 | An agent loop has **no built-in step limit**, and a turn that reads files and runs commands costs minutes. A turn cap is not a time bound: four turns took 111 s on a two-file fixture and exceeded fifteen minutes in a twenty-file repo |
| F11 | A custom tool that is not named in the client's tool allowlist is **silently absent** — the model has no way to report and simply does not. Runs "succeed" with zero output |
| F12 | Line endings are inconsistent by nature: Windows checkouts, CRLF diffs, mixed files. A trailing CR once silently broke every path match |
| F13 | Model updates on such a device are delete-then-download; there is no update call, and an offline device reports everything as up to date |

## 3. Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | An **agent loop over the whole PR** with tools, not a fixed pipeline of prompt-per-file | F1. A pipeline cannot escalate, cannot test, and cannot chase | One call per file; a fixed multi-stage pipeline |
| D2 | Findings arrive through a **custom tool** during the run, not a JSON block in the final message | A tool call is structured by construction and lands while the agent still has context to correct itself | Parsing a fenced block; scraping the transcript |
| D3 | The poster resolves each finding by **quoted text → diff line**, and drops what it cannot place | F2, F3. This is the whole guarantee that comments land on lines | Trusting model-supplied line numbers; a summary with no inline comments |
| D4 | One review, `event: COMMENT`, with all the comments in it | One API call for N threads, and `COMMENT` cannot approve or block | One call per comment; check annotations |
| D5 | Advisory: `continue-on-error`, never a required check | A model's opinion must not stop a merge. The cost of getting this wrong is a bot people route around | A blocking severity |
| D6 | The whole checkout, `bash` included, inside an **ephemeral** runner — and `persist-credentials: false` | "Review without search is useless". The boundary is the throwaway container; the one prohibition is committing, and that is enforced by stripping the credential rather than by asking nicely | Diff-only; a read-only tool set |
| D7 | Rules are declared per repo and read from the **base ref** | A PR must not rewrite or bootstrap the thing that judges it: `AGENTS.md`, rule files and the client's own settings are all editable in a diff | Rules from the checkout; no rules at all |
| D8 | **Opt-in is a config file** (`.ai-review.json`); no file means no review, a notice and exit 0 | Legible in a diff, next to the decision to be reviewed. Repeating a workflow into a repo is not opt-in — the workflow gets copied by hand and then reviews a repo that never asked | A repository variable (invisible from the repo); a PR label (a bot nobody remembers to label); presence of the job |
| D9 | Nothing about a repo, endpoint or model is compiled in: inputs and config only | The action answers a question any repo can ask, and anything hardcoded becomes a fork per consumer | A repo-specific action |
| D10 | Every comment carries one of four severities, forced by the tool schema, and none of them blocks | The vocabulary is data for a reader or a later consumer, not a gate. A schema enum makes self-grading consistent | Free-text severity; a blocking level |
| D11 | Findings on the same line post separately, and each body must read on its own | Two distinct defects are two comments; legibility comes from independence, not from merging | Merging per line |
| D12 | A **turn cap** steers a wrap-up message at a budget, with the job timeout as backstop | F10: there is no step limit, and an unbounded agent on local hardware can eat a job | Trusting the model to stop; timeout alone |
| D13 | A **coverage gate** reads the tool-call stream and names any changed file the agent never opened | Answers "did it really look" from events rather than from the model's summary | Trusting the agent's claim |
| D14 | Cost is bounded by pinning thinking to low and setting the ceiling in both places | F4, F5, F6 | Thinking off (cheaper, merges findings); defaults |

## 4. Shape

```
action.yml            opt-in check → install client → review → post
src/review.mjs        config, rules from base, prompt, agent run, event capture
src/post.mjs          findings → anchored comments → one review, deduped by marker
src/lib/config.mjs    .ai-review.json: defaults, validation, globs, rule frontmatter
src/lib/prompt.mjs    rule selection from the base ref, prompt assembly
src/lib/diff.mjs      diff → per-file line maps; quote → line number
src/lib/coverage.mjs  tool stream → which files were opened
src/extensions/       the report_finding tool, the turn cap
tools/proxy.mjs       dev only: logs what the client puts on the wire
tools/leak-audit.mjs  dev only: what a public copy would leak
```

A consuming repo adds `.ai-review.json` and one job. See the README.

## 5. Verification

| Check | Result |
|---|---|
| Reason request parameters are sent as intended | **Proven** — a logging proxy showed the effort parameter and the ceiling on every request |
| The findings tool arrives as a tool call with usable arguments | **Proven** — in two runs, exact quotes, valid severities |
| Quote → line resolution, and dropping what cannot be placed | **Proven** — unit tests plus a real run resolving 3/3 |
| The turn cap stops a loop | **Proven** on a small repo; **F10** is the caveat in a large one |
| Coverage gate names an unopened file | **Proven** in tests; a real run covered all changed files |
| One review posts as inline threads, and a re-run posts none | **Proven** — three threads, then `alreadyPresent: 3, posted: 0` |
| Cache stays warm across turns, including after a steer | **Proven** — per-turn cache growth across a capped run |
| Credential stripping blocks a push | **Proven** by mechanism: with no persisted header and no helper, git cannot authenticate |
| A large repo finishes inside the job timeout | **Open** — F10 is the reason, and a wall-clock budget is the fix |

## 6. Open

| # | Question | Blocks |
|---|---|---|
| Q1 | A wall-clock budget the extensions respect, not just a turn count | Anything with more than a handful of changed files |
| Q2 | Whether a second pass should grade the findings, since self-grading is the weak point | Nothing; deferred |
| Q3 | Reviewing significant changes rather than every push | Noise on small follow-up pushes |

## 7. Implementation log

**2026-11-21 — built and verified on one device.** The findings above came from building it, and four of them
changed the design: the tool allowlist (F11), the two ceilings (F5), the cache invalidation rule (F8), and line
endings (F12). Two numbers were wrong on the way and are corrected here rather than quietly: an output ceiling was
attributed to the hardware before it turned out to be the client's own model entry (F5), and a 67 tok/s decode
figure was measured on a counting stream and reported as general when the same model answers prose at 24 (F9).
