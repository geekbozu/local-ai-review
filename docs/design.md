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
| F16 | **Uniform effort is what cost 66 minutes, and size is the wrong proxy for fixing it.** A two-file change ran 66 minutes because the prompt asked for the same depth everywhere; the first instinct — scale effort by path class and diff size — would have told the agent to skim a rules file, where the smallest change is the most dangerous | measured on the first real pull request |
| F17 | **A turn count is not progress**, and a guard on silence fires in the middle of the work. On the planted-defect run the agent had reported nothing at turn 15 and reported four findings at turns 32–35, the first of them the planted contradiction | measured on the planted defect |
| F18 | A private-address pattern written as `192\.168` followed by three more octets only matches a five-octet address, so `192.168.68.82` and `172.16.4.9` passed the leak audit and only `10.0.0.5` was caught | found by publishing a handoff through it |

## 3. Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | An **agent loop over the whole PR** with tools, not a fixed pipeline of prompt-per-file | F1. A pipeline cannot escalate, cannot test, and cannot chase | One call per file; a fixed multi-stage pipeline |
| D2 | Findings arrive through a **custom tool** during the run, not a JSON block in the final message | A tool call is structured by construction and lands while the agent still has context to correct itself | Parsing a fenced block; scraping the transcript |
| D3 | The poster resolves each finding by **quoted text → diff line**, and drops what it cannot place. A quote spanning two lines anchors on its first line | F2, F3. This is the whole guarantee that comments land on lines. Only the first line can carry the anchor, and the uniqueness rule still refuses to guess | Trusting model-supplied line numbers; a summary with no inline comments; dropping multi-line quotes (it lost a correct medium finding on the planted-defect run) |
| D4 | One review, `event: COMMENT`, with all the comments in it | One API call for N threads, and `COMMENT` cannot approve or block | One call per comment; check annotations |
| D5 | Advisory: `continue-on-error`, never a required check | A model's opinion must not stop a merge. The cost of getting this wrong is a bot people route around | A blocking severity |
| D6 | The whole checkout, `bash` included, inside an **ephemeral** runner — and `persist-credentials: false` | "Review without search is useless". The boundary is the throwaway container; the one prohibition is committing, and that is enforced by stripping the credential rather than by asking nicely | Diff-only; a read-only tool set |
| D7 | Rules are declared per repo and read from the **base ref** | A PR must not rewrite or bootstrap the thing that judges it: `AGENTS.md`, rule files and the client's own settings are all editable in a diff | Rules from the checkout; no rules at all |
| D8 | **Opt-in is a config file** (`.ai-review.json`); no file means no review, a notice and exit 0 | Legible in a diff, next to the decision to be reviewed. Repeating a workflow into a repo is not opt-in — the workflow gets copied by hand and then reviews a repo that never asked | A repository variable (invisible from the repo); a PR label (a bot nobody remembers to label); presence of the job |
| D9 | Advisory (`continue-on-error`), runs on every push to a code PR, docs-only pushes skipped by `paths-ignore`, in **its own workflow** with a 90-minute timeout and a concurrency group that **queues rather than cancels** | Two separate reasons. Advisory because a model's opinion must never stop a merge. Its own workflow because a run-level `cancel-in-progress` takes every job in the run with it, and a job cannot opt out of its own run being cancelled — four pushes produced four cancellations and one completed review, and the one that completed was followed by an hour of silence. Queue rather than cancel because superseded findings are harmless: the poster skips comments it already made, by marker | Label-gated; a required check; living inside the gate's workflow (tried, cancelled every time); `cancel-in-progress: true` (a review that never finishes is one nobody reads) | F16, F23 |
| D10 | Every comment carries one of four severities, forced by the tool schema, and none of them blocks | The vocabulary is data for a reader or a later consumer, not a gate. A schema enum makes self-grading consistent | Free-text severity; a blocking level |
| D11 | Findings on the same line post separately, and each body must read on its own | Two distinct defects are two comments; legibility comes from independence, not from merging | Merging per line |
| D12 | Two budgets steer one wrap-up message — a **turn cap** (60) and a **wall-clock** (`time-budget-minutes`, off by default unless the consumer sets it) — whichever comes first, with the job timeout as backstop. Nothing triggers on "no findings yet" | F10: there is no step limit, and an unbounded agent on local hardware can eat a job. F17: silence is the normal shape of a review following a lead, so a count of turns says nothing about whether it is working. The nudge is sent with `deliverAs: "steer"`, because a bare `sendUserMessage` mid-turn throws | Trusting the model to stop; timeout alone; a quarter-budget silence trigger (it fired at turn 15 on a run that went on to report four findings, which is the run that removed it) | F10, F17 |
| D13 | A **coverage gate** reads the tool-call stream and names any changed file the agent never opened | Answers "did it really look" from events rather than from the model's summary | Trusting the agent's claim |
| D14 | Cost is bounded by pinning thinking to low and setting the ceiling in both places | F4, F5, F6 | Thinking off (cheaper, merges findings); defaults |
| D15 | **Thoroughness is uniform; only the work is bounded.** One budget, the same for every file, and the prompt tells the agent both halves: give every changed line the same attention, and stop when you have either found something or satisfied yourself | A one-line change to a rules file or an RLS policy is the most expensive thing a change can touch, so classifying by path and asking for a skim would skip exactly the dangerous case | Effort scaled by diff size or file class (tried, reversed: the classifier would have told the agent to skim `.pi/rules`); a budget that grows with the diff | geekbozy1011 | F10, F16 |
| D16 | Findings the poster will not place — below the floor, unanchorable, a duplicate — are written to a **notes file** with their body, and the artifact carries it. The posted summary keeps the folded list of reasons | The best finding on the planted-defect run was a correct medium, and it was dropped, and all a reader got was 120 characters of its quote. A body cannot be re-derived from a quote, and the summary is the wrong place for something not posted | Body in the summary; dropping silently, which is what happened | F3 |

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
| A budget nudge actually steers | **Open** — every nudge this extension made threw `Agent is already processing`, so the silence trigger that fired at turn 15 changed nothing. Fixed with `deliverAs: "steer"`; unverified until a run reaches a budget |
| A quote spanning two lines anchors on its first line | **Proven** — unit test, and the planted-defect finding it was written for |
| Coverage gate names an unopened file | **Proven** in tests; a real run covered all changed files |
| One review posts as inline threads, and a re-run posts none | **Proven** — three threads, then `alreadyPresent: 3, posted: 0` |
| Cache stays warm across turns, including after a steer | **Proven** — per-turn cache growth across a capped run |
| Credential stripping blocks a push | **Proven** by mechanism: with no persisted header and no helper, git cannot authenticate |
| A large repo finishes inside the job timeout | **Open** — F10 is the reason, and a wall-clock budget is the fix |

## 6. Open

| # | Question | Blocks |
|---|---|---|
| Q2 | Whether a second pass should grade the findings, since self-grading is the weak point | Nothing; deferred |
| Q3 | Reviewing significant changes rather than every push | Noise on small follow-up pushes |

## 7. Implementation log

**2026-11-21 — built and verified on one device.** The findings above came from building it, and four of them
changed the design: the tool allowlist (F11), the two ceilings (F5), the cache invalidation rule (F8), and line
endings (F12). Two numbers were wrong on the way and are corrected here rather than quietly: an output ceiling was
attributed to the hardware before it turned out to be the client's own model entry (F5), and a 67 tok/s decode
figure was measured on a counting stream and reported as general when the same model answers prose at 24 (F9).

**2026-11-21 — the first real review worked, and its 66 minutes taught the wrong lesson first.** Two files, one
inline comment, and the comment was correct: it caught a decision number cited from a design doc that had been
superseded. The duration was the problem — a 60-turn budget spent 66 minutes — and the first fix was per-class effort
scaling, which D15 reverses. A path classifier says a rules file is mechanical; a rules file is the case where one
line changes how everything else is judged. The bound is now a single turn budget with an instruction to stop, and
the path list only orders attention.

**2026-11-22 — the planted defect was found and then thrown away, and that was the useful run.** A contradiction was
planted in the consumer's workflow — a comment saying 20 minutes above `timeout-minutes: 90` — and the agent reported
it as a correct medium at turn 32, quoting two lines. The poster could not place a two-line quote and dropped it, so
the PR showed a folded list with 120 characters of the quote and a `presencePenalty` opinion instead. Two fixes came
out of it: the resolver anchors a multi-line quote on its first line (D3), and whatever the poster drops keeps its
body in a notes file the artifact carries (D16).

The same run removed the silence trigger. It fired at turn 15 with nothing reported, and every one of the four
findings arrived between turns 32 and 35 — the guard would have cut the run before the first of them. Turns measure
nothing about progress (F17). Worse, the nudge it sent never arrived: a bare `sendUserMessage` mid-turn throws, so
that guard and the turn cap had been logging an error and doing nothing. The clock the design had been treating as an
optional backstop is now the bound the consumer sets (D12), at 45 minutes against an 80-minute job.

**2026-11-22 — the leak audit was the thing leaking.** Publishing a handoff through `tools/leak-audit.mjs` produced
one finding, for a Windows path, on a document that also named two private addresses, three board hostnames, an
internal hostname and the consumer's pull request. The private-address pattern had two octets in its alternatives and
three more after them, so it matched `10.0.0.5` and nothing in 192.168/16 or 172.16/12 (F18). The document is gone;
this entry stays because the pattern bug is the kind that reads as working.

**2026-11-22 — the review's own workflow, because a run-level cancel is not something a job can survive.** The
`ai-review` job lived inside the CI workflow, whose `cancel-in-progress` is correct for a two-minute gate and lethal
for a 45-minute advisory review: every job in the run was marked cancelled, including ones that take 92 ms. Tuning
job-level concurrency cannot help, because the cancel happens above the job. Moving it to `ai-review.yml` with
`cancel-in-progress: false` is the smallest arrangement where a review finishes, at the cost of wall time on a
two-board pool. The queue semantics themselves are unverified — proving them needs a push while a review runs, which
costs another full cycle — so that is a claim to check rather than trust.
