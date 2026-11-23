# Design

Why this is shaped the way it is. Every claim below was measured on real pull requests against real hardware; the
numbers are what decided the shape, and where a decision was later reversed it says so.

The short version: **an agent with tools, bounded by four things it cannot argue with, posting through a second process
that holds the credential.**

## What was measured

| Finding | Consequence |
|---|---|
| The model copies a line well and counts line numbers badly | Findings are anchored by quoted text, never by a number the model supplies |
| A review comment attaches only to lines in the diff | A quote that cannot be placed is dropped, not guessed at |
| Thinking level counts toward the output ceiling | The ceiling is set in both places it can be set; a model that thinks without room returns nothing |
| Decode speed depends on what is generated (67 tok/s counting, ~24 prose on the same model) | Plan on the slow number; wall time is what a review costs |
| A prompt cache survives an append-only transcript but not a mid-conversation *system* message | Governance messages are sent as user messages |
| An agent loop has no step limit, and one turn can cost minutes | Four bounds, below |
| A 66-minute review was a two-file change | Uniform effort, one budget; path class orders attention and never scales it |
| The agent reports nothing, then reports four findings ten turns later | Silence is not evidence of anything; no guard fires on "no findings yet" |
| The client gives up after five minutes of silence by default | `providerTimeoutMs` exists, and the client's timeout — not the device's — is usually the one you hit |
| A 201k-token context made each turn take five minutes and then time out | Result caps per tool; `contextBudget` for deployments that need it |
| Low temperature makes a model re-emit its highest-probability continuation | Samplers are the deployment's, and a looping model needs repetition controls (DRY, frequency penalty) rather than a colder temperature |
| One run reported the same concern 33 times, and another eight times on one file | Findings are a list the agent can see and edit; markers dedupe across runs |

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | An **agent over the whole pull request** with tools, not a prompt per file | A pipeline cannot follow a lead, and following a lead is the value |
| D2 | Findings arrive through a **tool during the run** | Structured by construction, and it lands while the agent still has context to correct itself |
| D3 | A **list the agent can edit**: report, list, update, withdraw | The agent is the only thing that knows two entries are one defect. A report-only tool made every restatement permanent |
| D4 | **Quoted text → diff line**, and ambiguity is dropped rather than guessed | This is the whole guarantee that comments land on lines that exist |
| D5 | **Confidence 0–10 with bands**, and a floor the poster enforces | Severity alone was unstable: one unchanged defect came back high, medium and low. A number with a rubric can be compared to a threshold |
| D6 | One review, `COMMENT`, with all its comments; re-runs skip what a marker says is already posted | One call for N threads, and `COMMENT` cannot approve or block |
| D7 | Advisory (`continue-on-error`), in **its own workflow** | A model's opinion must not stop a merge, and CI's `cancel-in-progress` would kill a long review with the run |
| D8 | The agent runs in **bubblewrap**; a missing sandbox fails the job | A boundary the OS enforces, not one a prompt describes |
| D9 | The endpoint key lives in a **loopback proxy**, never in the child | Anything in the agent's environment is readable by anything it runs |
| D10 | The poster reads the diff and the floors from a **frozen copy resolved against the base ref** | `.git` lives in the tree the agent may write; a policy read from the working tree is a policy the pull request wrote |
| D11 | **Opt-in is a config file**; no file, no review | Legible in a diff, next to the decision being reviewed |
| D12 | Rules are restored from the **base ref** | A pull request must not rewrite what judges it |
| D13 | **Four bounds**: turns, wall clock, context tokens, client patience | Each exists because a measured run escaped the others |
| D14 | The bound that ends a run is **enforced**, not requested | A wrap-up nudge fired at turn 60 and the run continued to 120 |
| D15 | Output is **posted through a sanitiser**: no raw HTML, images, mentions or forged markers, and caps on length | Markdown is not inert, and a dropped finding is still model output |
| D16 | **Defaults describe a reviewer; deployments describe hardware** | A hardware-tuned default silently shortens every other deployment |

## What is not solved

| | |
|---|---|
| The model can be convinced | These decisions bound what a convinced model can *do*, not whether it can be convinced |
| Comments are not context | The agent cannot see what earlier runs already said, so it re-derives findings the poster then suppresses, and the summary reads as a clean run |
| The prompt is one repository's | Sections should be overridable per repository while the facts — diff, files, tools — stay the harness's |
| Repetition is contained, not understood | A loop is now survivable (bounds, dedupe) and less likely (samplers), not impossible |

## Shape

```
action.yml                opt-in → configured → sandbox → review → render → post → artifacts
src/review.mjs            config, base-ref rules, prompt, sandbox, agent run, frozen policy
src/post.mjs              findings → confidence and severity floors → quoted anchoring → one review
src/lib/config.mjs        .ai-review.json: defaults, validation, globs
src/lib/prompt.mjs        prompt assembly — the facts and the policy
src/lib/rules.mjs         rule files, restored from the base ref
src/lib/diff.mjs          diff → per-file line maps; quote → line
src/lib/coverage.mjs      tool stream → which files were opened
src/lib/triage.mjs        risk hints: which changed files deserve attention first
src/lib/trace.mjs         event stream → the run's trace, written as it arrives
src/lib/transcript.mjs    event stream → a readable transcript
src/lib/url.mjs           endpoint normalisation (the /v1 that is always missing)
src/render-transcript.mjs the always-run step that renders a checkable transcript
src/extensions/           report/list/update/withdraw findings, the budget, per-tool result caps
tools/proxy.mjs           dev only: logs what the client puts on the wire
tools/leak-audit.mjs      dev only: what a public copy would leak
```

## Verification

| Check | Result |
|---|---|
| A review runs inside the sandbox, end to end | **Proven** — turns, tool calls, findings reported from inside `bwrap`, posted inline, exited on its own |
| The endpoint key is not in the child | **Proven by construction** — the child's environment is a whitelist holding a per-run proxy token |
| A finished review exits | **Proven** — an `http` server once held the event loop open, leaving completed reviews to be cancelled |
| Quoted anchoring, CRLF and multi-line quotes | **Proven in tests**, and on every posted comment |
| Finding tools dedupe | **Proven** — 15 reports became 7 findings; 33 report/withdraw cycles became 2/1 |
| Confidence gates posting | **Proven in tests**; live distribution not yet characterised |
| The wrap-up is enforced | **Proven** — the nudge alone was ignored for sixty more turns |
| The coverage gate names changed files the agent never opened | **Proven** — in tests, and in every run summary |
