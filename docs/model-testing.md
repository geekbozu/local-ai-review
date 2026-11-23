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

### `zai-org/GLM-4.7-Flash` — measured, and not competitive here

31B, 131k context, tools supported. Its card separates a general row (temp 1.0 / top-p 0.95) from the one it prescribes
for **multi-turn agentic** work (temp 0.7 / top-p 1.0 / 16384), and a review agent is the second kind — so both were run:

| row | run 1 | run 2 | run 3 |
|---|---|---|---|
| card agentic (0.7 / 1.0) | 2/5 · 901 s | 1/5 · 243 s | 3/5 · 468 s |
| card general (1.0 / 0.95) | 2/5 · 327 s | 2/5 · 260 s | 2/5 · 196 s |
| the 80B, for comparison | 3/5 · 170 s | 3/5 · 165 s | 3/5 · 159 s |

Two problems, both fatal for this use:

- **Recall below the 80B on every row**, and never above.
- **The agentic row is not reproducible**: the same configuration found 1, 2 and 3 of the five planted defects in 243,
  468 and 901 seconds. The device's own defaults are stable at 2/5, so the variance is the reasoning, not the sampler.

**It reasons whether or not it is asked to.** `/slots` reports `reasoning_format: deepseek` with a 16384-token ceiling
being spent at ~20 tok/s, which is the whole of its 128 s per turn. The device advertises `supports_preserve_reasoning`
but no `supports_reasoning_effort`, so pi has no per-request switch to pull, and `thinking: "off"` cannot express it.
`modelSettings.chatTemplateKwargs: { "enable_thinking": false }` can — that row is in the queue and is the only
configuration under which GLM is still a candidate.

### `Qwen/Qwen3.8-27B`## The fixture sweep, and what it settled

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

## The screen: five models, one fixture

Every row below is the same pinned fixture — five planted defects, one critical, two high, one medium, one low — with two
runs at each setting, on the same device, through the same container. `found` is how many of the five it reported.

| model | row | found | reports kept | avg wall |
|---|---|---|---|---|
| **Qwen3-Coder-Next** (80B, 3B active) | 0.6 / 0.95 / 20 | **3/5 · 3/5** | **4** | **163 s** |
| Qwen3-Coder-Next | device defaults (= 0.6 / 0.95 / 20) | 3/5 · 1/5 | 3.5 | 180 s |
| GLM-4.7-Flash (31B) | card agentic 0.7 / 1.0 | 1/5 · 3/5 | 3 | 254 s |
| GLM-4.7-Flash | same, `enable_thinking: false` | 2/5 · 1/5 | 3 | 332 s |
| Qwen3.6-35B-A3B | card 0.7 / 0.8 | 2/5 · 1/5 | 2.5 | 157 s |
| Qwen3.6-35B-A3B | device defaults | 0/5 · 1/5 | 1 | 287 s |
| Ornith-1.5-35B-A3B | device defaults | 1/5 · 1/5 | 1.5 | 585 s |
| Ornith-1.5-35B-A3B | same, `enable_thinking: false` | 2/5 · 1/5 | 2.5 | 595 s |
| gemma-4-26B-A4B-it | any | 0/5 | 0 | broken |

Four things this settles:

- **Only one model reviews.** The 80B is the sole configuration that has found three of five, and it did so eight times
  across two harness versions. Everything else tops out at two, once.
- **Nothing is fully reproducible.** The 80B's own device-default row gave 3/5 and then 1/5 — one divergence in seven
  runs, expressed as churn (8 reports, 2 withdrawals) rather than as a model that answered wrongly. The typical result is
  the one to quote; a single run is not.
- **The box's defaults are the right row for the 80B** — they *are* the 0.6 / 0.95 / 20 row this page once presented as a
  discovery, so that "tuning" changed the config not at all. Where device and card disagree (gemma's top_k 64, GLM's
  agentic 0.7 / 1.0) the disagreement is worth a run, not an assumption.
- **gemma cannot be used here at all.** Its stream is truncated at the first special token — the model answers `<termed`
  and stops — which is a chat-template/parser mismatch on the serving side, not something a request can fix.

The two defects *every* model missed are the unescaped interpolation into HTML (medium) and the stale comment above a
changed value (low). Stable across models, samplers and thinking modes: the reviewer reads the critical and high defects
and declines the marginal ones, whoever it is.

## The pile

Models queued for the sweep, and where each one stands:

| model | state |
|---|---|
| `Qwen/Qwen3-Coder-Next` (80B, 3B active) | **measured** — 3/5 planted defects, 4 findings kept, ~2m45, reproducible ×3 |
| `zai-org/GLM-4.7-Flash` (31B) | **measured and behind**: 2/5 typically against the 80B's 3/5, 200–900 s, and not reproducible. Thinking-off row pending |
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
