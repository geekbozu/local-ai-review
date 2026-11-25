# A shared llama-swap box

A reference for pointing this action at models served by [llama-swap](https://github.com/mostlygeek/llama-swap) on a machine
you host yourself — in this case a desktop with a single 4060 Ti. The same shape as the Tiiny page, because the traps are
different but the job is the same.

**This is not a measurement rig.** It is someone's computer: idle, or playing games. That single fact shapes everything
below.

## Operating it

llama-swap loads models on demand and unloads them when another is asked for. One model is resident at a time, so two
clients asking for different models will thrash. It speaks the OpenAI API on one port:

```bash
BASE=https://<host>            # not /v1 here — management paths hang off the root
```

**What it serves.**

```bash
curl -s "$BASE/v1/models" | jq -r '.data[].id'
```

**Its real settings, per model.** llama-swap proxies the backend server, so each model's own `/props` is reachable. This is
the only authority for context, template and default samplers — nobody publishes a card for every quant:

```bash
curl -s "$BASE/upstream/<model-id>/props" | jq '{
  n_ctx: .default_generation_settings.n_ctx,
  params: .default_generation_settings.params,
  caps: .chat_template_caps
}'
```

Two things worth reading there before you configure anything:

- `chat_template_caps` says which control surface the model *actually* honours. `reasoning_effort_levels` means it takes
  `reasoning_effort`; `supports_tools` means the server can parse tool calls — not that the model was trained for them.
- `params` is the quant's shipped sampling. Where it disagrees with the model's card, the card is usually right about
  *quality* and the quant about *speed*.

**Talk to it.**

```bash
curl -s "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{
  "model": "<model-id>", "messages": [{"role":"user","content":"ready"}], "max_tokens": 16
}'
```

## What bites

| Thing | What happens |
|---|---|
| **Wall times are not comparable across batches** | The same model and settings took 116 s and 326 s in different batches, because the box was busy. Recall is the column to trust; time is indicative at best |
| **A quant is not the model** | Q4_K_M of a 12B-active expert mix on 8 GB of VRAM measures the quant and the card as much as the weights. Treat every score as a floor for that model |
| **One model at a time** | Two clients on different models unload and reload underneath each other; both runs are garbage and neither errors |
| **First response includes the load** | A 20–40 s first token is a model load, not generation. Do not read it as throughput |
| **A decision model is not a chat model** | `clef-flash` and the `d1-*` entries answer on `/v1/systemone`. A `/v1/chat/completions` request to one **hangs** rather than failing, which looks like a downed model |
| **Some models ignore the thinking toggle entirely** | Inkling has no `enable_thinking`; it takes `reasoning_effort` only. With neither sent it picks its own and ran past twelve minutes on a small diff |
| **Tool-call syntax is per-model** | LFM2.5 writes `[fn(arg="v")]` between `<|tool_call_start|>` tokens. Without a parser for that, a perfectly capable model fails every run because the call arrives as prose |

## Models measured on it

Same fixture and prompt as everywhere else: `vending-supabase`, six planted defects, the shipped review prompt. Recall first,
then time.

| model | preset | found | runs | wall |
|---|---|---|---|---|
| `qwen38-27b-unleashed` | backend defaults | **5.0** | 4 · 6 | 310 s |
| `tiel-coder-35b` (an Ornith re-tune) | backend defaults | 4.6 | 5 · 5 · 4 · 5 · 4 | **136 s** |
| `inkling-2-mini-96k` | `reasoning_effort: low`, 16k budget | 4.6 | 6 · 4 · 5 · 4 · 4 | 176 s |
| `Mellum2.1` | card: temp 1.0, top_p 0.95, top_k 20 | 3.0 | 3 · 3 | **70 s** |
| `LFM2.5-2.6B` | card | 2.5 | 3 · 2 | 84 s |
| `LFM2-1.2B-tool` | card | 0.0 | 0 · 0 | 34 s |
| `LFM2.5-8B-A1B` | - | **blocked** | - | needs a tool-call parser for its Pythonic format |

`Mellum2.1` is worth its own line in the notes: 12B total, 2.5B active, Apache-2.0, and JetBrains evaluated it with **Pi** —
the same client this action uses — at temperature 1.0, 114K context and 16K output. It is the fastest thing here that finds
anything at all.

### Two levers that are not about the model

- **`contextBudget` is a quality lever.** `inkling-2-mini` at a 64k budget scored 4.0; at 16k, on the same effort, 5.0 —
  one more defect, slightly faster, half the turns. A generous allowance invites whole-file reads and drift; a tight one
  forces narrow reads.
- **`reasoning_effort` is not.** `medium` matched `low` on recall for 45% more wall time and 50% more turns.

### Blocked, with the reason

| model | blocker |
|---|---|
| `LFM2.5-8B-A1B` | emits `<|tool_call_start|>[ls(path='/work')]<|tool_call_end|>` as prose; the server needs a parser for LFM2.5's Pythonic call format |

## Notes

- **Nothing here runs in production.** This box exists to measure candidates quickly when it is free. A review that competes
  with a game produces a *bad* review, not a slow one, and it fails silently — that is the reason the deployed device is a
  separate machine.
- The per-model settings used for these runs are in `tools/eval/settings/`, with the preset source named in each row
  (`card` or `backend defaults`).
