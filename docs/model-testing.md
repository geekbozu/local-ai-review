# Model testing

What has been tried on the device this was built against, what settings each model needed, and what happened. Every
number here is measured; where a result is unflattering it says so, because the point of the page is that the next person
does not repeat the work.

The action's **defaults** do not contain any of this. A sampler row is a property of a model and a deployment, so it
belongs in that repository's `.ai-review.json`. See the "Defaults and deployments" section of the README.

## The device

One accelerator, one model resident at a time, one request at a time, over Wi-Fi. Q8_0 GGUF through llama.cpp. Ask it
about itself on the model's own port — `GET /api/v1/models/running` gives the port, and `GET :port/props` needs no auth
and is the only trustworthy source for `n_ctx`, the chat template and the server's sampler defaults.

| | |
|---|---|
| prefill | 500–750 tok/s (short prompts) |
| a request is cut at | **about 10 minutes**, `504 "Upstream model server timed out."` |
| 128k prompt | ~5 minutes before the first token; 64k ~2 minutes; 32k under a minute |
| the *client's* own patience | 300 s by default — shorter than the device takes for a large prompt, so the client gives up first unless `providerTimeoutMs` is raised |

That last line cost hours: the failure looks like the device timing out, and it is our client. Raise
`providerTimeoutMs` before shortening a review to fit.

## Models

### `Qwen/Qwen3.6-35B-A3B` — the baseline

MoE, 3B active, 262k context, thinking optional. **~24 tok/s on prose**, 67 on repetitive output (speculative decoding),
prompt ~50–75 tok/s.

- With `thinking: off`: reviews finished in 3–5 minutes over 5–36 turns. On a fixture with one planted defect it caught
  it in 4 of 7 runs — twice as `medium`, twice as `low`. The variance was in the *rating*, not in whether it read the
  file.
- With `thinking: low`: found the same defect in 3 of 4 runs and produced the only `high` any model gave it, for ~35%
  more wall time per turn. On the evidence, thinking-low is the better setting for this model, and it is cheap.
- Samplers: the card's instruct row (0.7 / 0.8 / 1.5 presence) is what its own docs suggest. The presence penalty of
  1.5 is aggressive for a model that has to quote code back exactly, and it complained about that value in every run.

### `huihui-ai/Huihui-Ornith-1.5-35B-A3B-abliterated-Turbo` — not recommended

An abliterated Ornith. It read the diff thinly and reported generic concerns; nothing in the runs suggested it was worth
its time. Only useful as the "before" of the next row.

### `ornith-ai/Ornith-1.5-35B-A3B-Turbo` — tested, not adopted

The same architecture without abliteration, which was the actual question: is the abliteration what made it read badly?
Answer: two readable runs, one caught the planted defect at `low`, the other missed it; runs took 19–23 minutes. It has
no thinking mode to enable (`toggleable: false`), so it cannot be asked to try harder. Not adopted.

### `Qwen/Qwen3-Coder-Next` — the strongest of the small-active models, and it loops

80B total / **3B active**, 262k context, Q8_0 GGUF, **no thinking mode at all**, tool calling via `<tool_call>` and
`<function=>` with the server parsing it as `peg-native`. **19.4 tok/s decode**, flat across prose and repetitive output
(no speculative decoding: `/props` reports `speculative.types: none`), prompt 50–75 tok/s.

Early runs were the best of the night: four identical runs of six turns, ~2.5 minutes each, one finding, the same
finding every time.

Then it started looping, and the loops were the whole problem:

| settings | result |
|---|---|
| card row: temp 1.0, top_p 0.95, top_k 40 | 61 turns, 8 reports of one file, 12 minutes |
| temp 0.6, top_k 20 (the device's own defaults) | 120 turns, report/withdraw cycles, 15 minutes |
| community loop fix: **temp 0.8, top_p 0.95, min_p 0.01, top_k 40, presence 1.10, frequency 0.5, DRY 0.5 / allowed-length 5** | 17 turns and 4 minutes on one run; 63 turns on the next, same commit |

So the loop fix is the best row found and it is not a cure — the same configuration gave 17 turns and 63 turns on the
same diff. What it did do is make the good case much better than any other row managed.

Notes that matter more than the numbers:

- **Temperature is not the lever.** Both 0.6 and 1.0 looped, differently: a cold model re-emits its highest-probability
  continuation ("Now let me check if there are any issues with the changes", verbatim, for six turns), a hot one
  re-reports the same file. Neither is fixed by the sampler.
- **It cannot tell when it is done.** A definition of done in the prompt did nothing; the run ends when a budget says so.
- **DRY can damage tool calls.** Community reports say so; the mitigation is `dry_sequence_breaker` around `<tool_call>`,
  which is a server flag, not a request field. If findings start arriving malformed, suspect DRY first.
- `repeat_penalty: 1.0` is a no-op — the probability is divided by it. Presence and frequency penalties are the levers.

### `Qwen/Qwen3.8-27B` — the best model on this device, and the one to revisit

Dense 27B, 262k context, thinking with per-request effort (`supports_reasoning_effort: true`, template has
`enable_thinking`, levels `low` / `medium` / `xhigh`). The strongest model here and the slowest.

Measured on this device, on a **warm** model:

| | measured | Tiiny's published report |
|---|---|---|
| decode | **~13 tok/s** | 26.3 tok/s (INT4 build) |
| prefill | **~150 tok/s** | 390 tok/s |
| 120-token request | ~13 s | — |

Both roughly half of the published figures, which is what the quantisation difference would explain: their report
specifies **INT4**, and the file here is named `model.q8_0.gguf`. So the first thing to check before blaming the model
for its speed is which build is installed.

Two measurement traps, both hit on the way to those numbers:

- **The first request after a load is cold.** A probe immediately after `launch` reported 15 tok/s prefill; the same
  probe warm reported 152. Measure warm or you measure the load.
- **Do not divide tokens by wall time.** That produced "9 tok/s" for this model, which included prefill *and* thinking
  tokens and was wrong by half. Use `timings` from the response, or `/slots` while a request is in flight.

Set `maxTokens` from the speed: at 13 tok/s an 8192-token ceiling is a ten-minute turn, and thinking counts against it.
`n_ctx` is fixed at 262144 by the firmware — the `n_ctx` field on `launch` is ignored — so a long prompt on this box
costs minutes of prefill and cannot be avoided by asking for a smaller context.

Not adopted yet: it needs a cheaper build (INT4) or a much shorter review to be worth a 20-minute run, and the 80B
answers in four.

## The fixture sweep, and what it settled

`tools/eval.mjs` runs the real review — in a container, sandbox on — against a pinned fixture with five planted defects,
and scores each row against them by name:

```bash
npm run eval -- --fixture planted --settings tools/eval/samplers.json --runs 3 --device tiiny
```

It talks to any OpenAI-compatible endpoint. The only device-specific part is model loading: a normal endpoint serves every
model it has, while the Tiiny keeps **one** resident and answers 404 for anything else, so it is selected explicitly with
`--device tiiny` (launch, then poll) and the default does nothing at all. Nothing else in the harness knows what hardware
it is pointed at. Two sampler rows, three runs each, on a Qwen3-Coder-Next at 3B active:

| combo | turns | wall | reports | kept | found | precision |
|---|---|---|---|---|---|---|
| **0.6 / top_k 20 / no penalties** | 14 · 14 · 14 | 170 · 165 · 159 s | 4 | 4 | **3/5** | 3 of 4 |
| 1.0 / top_k 40 / no penalties | 17 · 17 · 17 | 177 · 169 · 165 s | 11 | 9 | 2/5 | 2 of 9 |

Three runs each and **every run within a combo is identical** — same turns, same findings, same defects found, same two
missed, within eleven seconds. So:

- **The sampler is not a consistency knob.** Both rows reproduce exactly. The 120-turn degeneration that dominated one
  evening was fixed by tooling — the definition of done, the editable finding list, the duplicate and per-path refusals,
  the enforced wrap-up — and not by temperature, DRY or a frequency penalty. Those were adopted because a community post
  blamed temperature, and the fixture says temperature was never the variable.
- **What the sampler does control is volume.** 1.0 emits eleven findings where 0.6 emits four, reproducibly, and is wrong
  about seven of nine. Precision, not recall, is what separates them: 3 of 4 against 2 of 9.
- **The same two defects are missed by everything**: an unescaped interpolation into HTML (medium) and a stale comment
  above a changed value (low). Stable across settings, across models, across prompts. That is a prompt-priority problem
  or a model-capability one, and it is now a specific thing to attack rather than a fog.
- **Wall time is ~2m45**, on a five-file change with the 20-turn budget. Usable on every push.

The chosen row is 0.6 with no penalties, because it reports four things of which three are true. It is not more
consistent — both are — and it is not faster. It is simply the one whose output a person would accept.

## The pile

Models queued for the sweep, and where each one stands:

| model | state |
|---|---|
| `Qwen/Qwen3-Coder-Next` (80B, 3B active) | **measured** — 3/5 planted defects, 4 findings kept, ~2m45, reproducible ×3 |
| `zai-org/GLM-4.7-Flash` (31B) | **in the sweep** — its card's agentic row vs its general row |
| `google/gemma-4-26B-A4B-it` (26B) | downloading |
| `ornith-ai/Ornith-1.5-35B-A3B-Turbo` | queued for update, then test |
| `Qwen/Qwen3.5-*` | queued for update, then test |
| `Qwen/Qwen3.8-27B` (27B dense, thinking) | measured and parked: half of Tiiny's published speed at its fixed 262K context |

Adding one is an entry in `tools/eval/models.json` — `{ "name": …, "config": { model, thinking, modelSettings } }` — and
nothing else. A sweep can be narrowed with `--only glm`.

**Each model gets its settings from its own card, not from our defaults.** Qwen3-Coder-Next has no agentic row, so its
row came from a sweep. GLM-4.7-Flash does have one — temp 0.7 / top-p 1.0 / 16384, separate from its general 1.0 / 0.95 —
and a review agent is that kind of task. Assuming either one's defaults suit another is the mistake this page exists to
prevent.

## What the guards had to do, because no model did it

Independently of the model, the harness had to stop certain behaviours, and each exists because a measured run did the
thing:

| guard | what it stops |
|---|---|
| four budgets: turns, wall clock, context tokens, client patience | a run that will not end |
| the wrap-up is enforced (hard stop after a grace period) | a model that ignores the instruction to wrap up — one ran 60 more turns |
| findings are a list the model can see and edit | restating one defect as new findings — 33 report/withdraw cycles once |
| a duplicate finding already in the list is refused | the same defect reported five times |
| a fourth finding on one path at one severity is refused | one file generating a page of comments |
| confidence 0–10 with a floor | a confident-sounding guess being posted as a defect |

## Unflattering conclusions, kept on purpose

- **No model here reliably knows when a review is finished.** The bound is always external.
- **The loop fix is a better configuration, not a fix.**
- **Severity is the least stable thing any of them produce** — one unchanged defect came back `high`, `medium` and `low`
  across runs, which is why confidence exists and why the floor matters.
