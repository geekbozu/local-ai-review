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

### `Qwen/Qwen3.8-27B` — the best model on the device, and the slowest

Dense 27B, 262k context, Q8_0, **thinking with per-request effort** (`supports_reasoning_effort: true`, template has
`enable_thinking`, levels `low` / `medium` / `xhigh`, default `low`). ~9 tok/s, so roughly half the speed of the 3B-active
MoE for far better judgement.

Settings being tested: `thinking: low`, `reasoning: true`, `thinkingFormat: qwen-chat-template`, `contextWindow 262144`,
`maxTokens 8192` (thinking counts against the ceiling), `contextBudget 64000` (its 128k prefill is ~10 minutes here),
samplers at the device defaults (temp 1.0, top_p 0.95, top_k 20, no penalties).

The hypothesis: an instruct model with no capacity for judgement about its own work is the wrong tool for a task that
requires deciding when to stop, and a thinking model fixes the wishy-washiness that dominated the 80B. Not yet
concluded.

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
