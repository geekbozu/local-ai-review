# Model testing

Which model to point the reviewer at, on one device, measured rather than assumed. Everything here was produced by
`tools/eval.mjs` against a pinned fixture; the commands are at the bottom.

Two fixtures, same six defect classes, no shared vocabulary: `vending-supabase` (supabase-js, service-role key) and
`vending` (plain TypeScript). The six are: a strict single-row read where a tolerant one was used, a query builder never
awaited, request input interpolated into markup unescaped, `pull_request_target` with secrets and a head checkout, a
comment saying "twenty minutes" above a timeout of 90, and a README the change falsified without touching it.

The pair exists because supabase-js is common in training data: on the Supabase fixture a model can find the strict-read
defect by recognising `.single()`, which is not review skill. The difference between a model's two scores is how much of
its result was library recognition.

**Numbers are only comparable within one fixture, prompt and preset.** It says what a model does with these six
defects, not what it does with your repository.

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

Only four rows are measured on the current fixture and the shipped prompt. Everything else predates one or both, and is
listed separately rather than mixed in — the earlier table in this document did mix them, which made it wrong.

**`vending-supabase`, six defects, shipped prompt, three runs each:**

| model | preset (from its card) | found | kept | wall |
|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | instruct: 0.7 / 0.8 / presence 1.5 | **5.00** (6 / 5 / 4) | 5.3 | 296 s |
| Qwen3.6-35B-A3B-Turbo | same | 4.33 (4 / 5 / 4) | 5.0 | **224 s** |
| Qwen3.5-9B-Turbo | thinking, general: 1.0 / 0.95 / presence 1.5 | 3.33 (4 / 3 / 3) | 4.0 | 176 s |
| Qwen3.5-9B-Turbo | instruct, general: 0.7 / 0.8 / presence 1.5 | 3.00 (4 / 2 / 3) | 3.0 | **136 s** |

**Earlier measurements — different fixture, different prompt. Not comparable, kept for the record:**

| model | what was measured | why it is here |
|---|---|---|
| Qwen3-Coder-Next (80B, 3B active) | 4 of 5 on the older five-defect fixture, prompt X, 209 s | never re-run on the current fixture |
| Qwen3.6-35B-A3B | 5 of 5 on the older fixture with its own 0.6 / 0.95 sampler, 448 s | the sampler comparison, same fixture as the row above it |
| GLM-4.7-Flash | 3 of 6 in 305 s — **on the GitHub-rubric prompt**, sampler 0.6 / 0.95 | not measured on the shipped prompt |
| Ornith-1.5-35B | 2 of 5 on the older fixture, 868 s | not a reviewer; see below |

- **Qwen3.6-35B on its card's instruct preset** is the recommendation: the only configuration to produce a 6 of 6, five
  on average, about five minutes.
- **Turbo is the same reviewer, faster** — one defect of recall for 72 s and 25% fewer turns.
- **The 9B is the cheap gate** — three of six in two to three minutes, on a tenth of the memory.
- **GLM-4.7 is flat and slow** wherever it has been measured, and has not earned a row on the current settings.
- **Ornith is not a reviewer** at any setting: it reads everything, files one finding, and takes 500-900 s.
- **gemma-4-26B-A4B-it cannot be used here.** A direct non-streaming request calls tools correctly, but under the agent
  five runs in six returned token soup (`<find<|"|>} <thought`, one burning all 8192 output tokens). The device's template
  is gemma's own and parses `<|channel>` correctly, so the prompt is rendered into something gemma cannot parse.

### The sampler is not one lever

Getting the preset wrong cost the **9B** 0.7 defects, doubled its wall time, and produced a single 10,661-token response
where the card's presets stay under 2.5k. On the **35B** the same mistake cost nothing on recall — our earlier setting
found five of six — and only 150 s. Capacity decides which knobs matter, so do not generalise a preset from one model to
another, and do not pick a preset by its label: the one Qwen labels "for reasoning tasks" scored worst of the four.

## A shared box (llama-swap)

A second machine serves models over llama-swap. It is someone's desktop, so it is not a measurement rig: it is idle or it is
busy playing games, and a run that lands during a game measures the game. Treat anything measured there as indicative, and
re-measure on dedicated hardware before it changes a recommendation.

Measured there, two runs each, same fixture and prompt:

| model | found | wall | note |
|---|---|---|---|
| `LFM2.5-2.6B` | 2.5 of 6 | 84 s | drives the tools correctly; the cheapest gate measured anywhere |
| `LFM2-1.2B-tool` | 0 of 6 | 34 s | calls tools, cannot review — its card says not to use it for programming |
| `LFM2.5-8B-A1B` | blocked | - | emits `<|tool_call_start|>[ls(path=...)]<|tool_call_end|>` as prose; needs a tool-call parser on the server |

Probed on the same box and **not** measured, because it is not idle hardware:

| model | tool calls | first response |
|---|---|---|
| `qwen38-27b-unleashed` | yes | 23 s |
| `qwen9b` | yes | 21 s |
| `qwen9b-r.c` | yes | 2 s |
| `tiel-coder-35b` (an Ornith re-tune) | yes | 35 s |
| `ornith15-35b` | yes | 42 s |
| `mellium2-thinking` | untested | - |

All five that answered already call tools, so nothing there needs the LFM parser work. The first response includes the model
load; none of those numbers is generation speed.

**Decision models are not chat models.** `clef-flash` and the `d1-*` entries answer on the decisions protocol
(`/v1/systemone`), not `/v1/chat/completions` — a chat request to one hangs rather than failing, which is what happened when
one was probed as if it were a reviewer. They judge, they do not review, and they belong to `tools like pi-warden`, not to
this action.

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
npm run eval -- --fixture vending-supabase --settings tools/eval/models.json --runs 3 --device tiiny --out out/screen.jsonl
```

- A **fixture** (`tools/eval/fixtures/<name>/`) holds `base/`, `head/` and `expect.json`; the harness commits both sides
  so every run sees the same diff, and scores rows against the planted defects by name (`expect.json`).
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
