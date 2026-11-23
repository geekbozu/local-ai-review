# Model testing

Which model to point the reviewer at, on one device, measured rather than assumed. Everything here was produced by
`tools/eval.mjs` against a pinned fixture; the commands are at the bottom.

The fixture is five planted defects in a small diff: a `.single()` that throws where `.maybeSingle()` was used, a query
builder never awaited, a user-supplied name interpolated into HTML unescaped, `pull_request_target` with secrets and a
head checkout, and a comment saying "twenty minutes" above a timeout of 90. Two are loud, one is subtle, one is policy,
one is cosmetic.

**Numbers are only comparable within this fixture.** It says what a model does with these five, not what it does with
your repository.

## The device

| | |
|---|---|
| one model resident at a time | a second `launch` unloads the first; two *can* be resident, but throughput collapses |
| a request is cut at | **about 10 minutes**, `504 "Upstream model server timed out."` |
| the client's own patience | 300 s by default — shorter than the device takes for a large prompt, so raise `providerTimeoutMs` |
| sampler defaults | read them from `GET :port/props`, never transcribe them into a config |
| `n_ctx` | fixed by the firmware; `launch` ignores it |

Measure warm. The first request after a load reported 15 tok/s prefill; the same probe once warm reported 152. Never
divide tokens by wall time either — read `timings` from the response or `n_done`/`n_remain` from `/slots`.

## The models

Every model on the **sampler its own card recommends, 3 runs each**, same fixture, same box. `found` is how many of the
five planted defects it reported.

| model | sampler | found (3 runs) | mean | kept | avg wall |
|---|---|---|---|---|---|
| **Ornith-1.5-35B-A3B-Turbo** | 0.6 / 0.95 / 20 / no penalties | 3 / 4 / 3 | **3.3** | 4.3 | **1084 s** |
| **Qwen3-Coder-Next** | same | 3 / 2 / 4 | **3.0** | 3.0 | **216 s** |
| Qwen3.6-35B-A3B | same | 2 / 2 / 3 | 2.3 | 2.3 | 138 s |
| GLM-4.7-Flash | same | 2 / 2 / 2 | 2.0 | 2.3 | 354 s |
| Ornith, `preserve_thinking` on | same + preserve | 3 / 2 / 1 | 2.0 | 2.3 | 387 s |

Read it with the variance in view: identical runs of one model span two defects, so **a single run cannot rank two
models**, and no difference below about 1.5 defects means anything.

- **Use the 80B for a PR gate.** 3.0 findings in 216 s.
- **Ornith is the better reviewer and the worse gate.** 3.3 findings, 1084 s mean, one run at **1971 s** — 33 minutes for
  a single review. Fit is a nightly or pre-merge deep pass, not a queue.
- **The device's defaults are not the model's recommendation.** Ornith ships `temperature 1.0` (its card's
  *benchmark-reproduction* row) and an invented `presence_penalty 1.5`; on those it scored **1/5 in five runs**. On the
  card's `0.6 / 0.95 / 20` it scored 3.3. Qwen3.6 behaves the same way (1.0 to 2.3). The 80B is unaffected only because
  its defaults already are the recommended row, which is why one model's defaults must never be generalised to another.
- **`preserve_thinking` is a loss here** (3.3 to 2.0), even though GLM's card recommends the equivalent for agentic work.
  Vendor advice is a hypothesis, not a setting.
- **GLM is stable and the weakest**: 2, 2, 2. It never varies and never improves.
- **Qwen3.6 is the fastest** (138 s) and mid-pack; its card row beats its device defaults on both axes.
- **gemma-4-26B-A4B-it cannot be used here.** A direct, non-streaming request calls tools correctly, but under the agent
  five runs in six returned token soup (`<find<|"|>} <thought`, one burning all 8192 output tokens) after 30-250 s. The
  device's template is gemma's own and parses `<|channel>` correctly, and no raw `<think>` or `<tool_call>` tags leak for
  the other models, so the prompt is rendered into something gemma cannot parse. Not reachable by config.

## What every model misses, and why

Across 70+ runs, two defects were missed far more than the other three:

| defect | missed in | mechanism |
|---|---|---|
| unescaped HTML interpolation | 18 of 19 before the prompt fix, 3 of 6 after | not recognised as a defect class until the prompt named escaping |
| stale comment above a changed value | 18 of 19, then 6 of 6 | **seen and declined**: the model calls it "not a functional defect" |
| `pull_request_target` | 5 of 19 | flaky, unrelated to the model |
| missing `await` | 7 of 19 | — |
| `.single()` throws | 3 of 19 | — |

The second is a judgement, not a blind spot: transcripts say things like *"the comment is clearly outdated and not a
functional defect"*. A prompt that overrides that judgement will start filing comment-only nits; whether that is wanted
is a product decision, not a tuning one.

The first was fixable and was fixed: the prompt now names "user-controlled data reaching markup, a query, a shell or a
path without escaping" among the defect classes, which took that defect from 1-in-19 to 3-of-6 with no rise in
findings kept.

Two prompt rules were measured against each other:

- **"Stop at the first category this change actually has"** made models drop the stale comment whenever a runtime defect
  was found first. It is now a priority order, not a limit.
- **Restatement, not hallucination, is the output defect.** One run spent the whole per-path cap of three on a single
  concern, phrased three ways. `report_finding` now names the other findings on that path at that severity, so the model
  can see it is repeating itself.

## Configuring a model

Send **no thinking parameter** unless the device documents the spelling for that model. With `reasoning: true` and pi's
default format, the request carries no `reasoning_effort`, no `chat_template_kwargs` and no `max_tokens` — and that is
the configuration gemma's one good run and every 80B run used. `chat_template_kwargs: { "enable_thinking": false }` is
the documented lever for chat models that answer with a refusal-like loop; it is not a default, and for gemma it
produced an empty answer rather than a better one.

`thinkingFormat` exists because models disagree about the spelling (`openai`, `qwen-chat-template`, `chat-template`,
`none`). Set it only when a run shows the wire format is wrong; each value is a claim about the server.

## Measuring

```bash
npm run eval -- --fixture planted --settings tools/eval/models.json --runs 3 --device tiiny --out out/screen.jsonl
```

- A **fixture** (`tools/eval/fixtures/<name>/`) holds `base/`, `head/` and `expect.json`; the harness commits both sides
  so every run sees the same diff, and scores rows against the planted defects by name.
- A **combo** is a whole `.ai-review.json`. `"deviceDefaults": true` fills the sampler block from the device's live
  `/props`.
- Rows append with a `sweep` id and their `work` dir, so a sweep can be re-scored from disk instead of re-run.
- `--device none` runs against an endpoint that manages its own models; `tiiny` loads and polls.
- One sweep at a time (lock file). Prune orphaned containers — a killed sweep leaves them hammering the box, and their
  rows look like results.

To see what the client actually puts on the wire, run the proxy:

```bash
UPSTREAM=http://<device>:<model port> HOST=0.0.0.0 PROXY_LOG=out/requests.jsonl node tools/proxy.mjs 8788
```

Point `AI_REVIEW_BASE_URL` at it and read the logged body. That is how the "no thinking parameter" claim above was
checked, and how field names like `max_completion_tokens` were caught.
