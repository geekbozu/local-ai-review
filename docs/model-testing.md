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

Nine settings across five models, same fixture, same box. `found` is how many of the five it reported.

| model | row | found | kept | wall |
|---|---|---|---|---|
| **Qwen3-Coder-Next** (80B, 3B active) | **0.6 / 0.95 / 20, no penalties** | **3.2 of 5** over 6 runs | 3.8 | 174 s |
| Qwen3-Coder-Next | presence 0.3 | 3.4 over 5 | 4.4 | 206 s |
| Qwen3-Coder-Next | top_k 40 / temp 0.4 / temp 0.8 | 3.0 / 3.0 / 2.0 over 2 each | 4.5 / 4.5 / 2.5 | 166–222 s |
| GLM-4.7-Flash (31B) | card agentic, either thinking mode | 2.5 over 4 | 2.8 | 439 s |
| Qwen3.6-35B-A3B | card 0.7 / 0.8 | 2.0 | 2.0 | 144 s |
| Qwen3.6-35B-A3B | device defaults | 1.0 | 1.0 | 433 s |
| Ornith-1.5-35B-A3B | either row | 1.0 | 1.0 | 319–583 s |
| gemma-4-26B-A4B-it | any | 0.4 over 7 | 0.4 | unusable |

- **Use the 80B at `0.6 / 0.95 / 20` with no penalties.** It is the only model that reliably finds three of five, and it
  is the fastest. Those values are also the device's own defaults, so there is nothing to tune — the settings to avoid
  are the card's `1.0 / 0.95 / 40`, which produces nine findings of which two are true.
- **The vendor's defaults are usually right.** Where device and card disagree (qwen3.6 at 0.6/0.95/20 vs 0.7/0.8) the
  card row wins; where they agree, the card's other advice is worth less than the box's own numbers.
- **`presence 0.3` buys coverage and pays in noise.** It is the only setting that has ever filed the stale comment, and
  it keeps 4.4 findings where 3.8 are true. Take it only if duplicate comments are acceptable.
- **GLM is flat across its rows** (2–3 of 5, 250–900 s): its samplers are not the variable, its speed is.
- **Ornith reads everything and files one finding**, in both thinking modes. Thinking off halves its wall time and
  changes nothing else — the same pattern the device's own notes report for other models.
- **gemma cannot be used here, and it is not the model's fault.** A direct, non-streaming request calls tools correctly.
  Under the agent, five runs in six returned token soup (`<find<|"|>} <thought`, one of them burning all 8192 output
  tokens) after 30–250 s. The device's template is gemma's own and knows its `<|channel>` markers, so the prompt is
  being rendered into something the model cannot parse. Direct to the model port and through the gateway behave the
  same, so this is not the proxy layer. Re-test after a firmware change; do not ship it before then.

Nothing is perfectly reproducible. The 80B's identical row has produced 3/5 eight times and 1/5 once, with the 1/5 run
showing churn (eight reports, two withdrawals) rather than a wrong answer. Quote the typical result, and never a single
run.

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
