# Model testing

Produced by `tools/eval.mjs` against a pinned fixture. Commands at the bottom.

## Fixtures

Two, same six defects, no shared vocabulary:

| fixture | stack | defects |
|---|---|---|
| `vending-supabase` | supabase-js, service-role key | strict single-row read where a tolerant one was used · query builder never awaited · request input into markup unescaped · `pull_request_target` with secrets and a head checkout · comment saying "twenty minutes" above a timeout of 90 · README the change falsified without touching it |
| `vending` | plain TypeScript | the same six |

Numbers are only comparable within one fixture, prompt and preset.

## Method

- Each row is a whole `.ai-review.json`; the harness writes it into the fixture and runs the action in the container, so the sandboxed path is what is measured.
- `tokPerSec` is aggregate throughput — `outputTokens / wall`, prefill and tool time included — not a decode rate.
- `found` = defects reported, of six. `kept` = findings the model left in its list. `wall` = seconds.
- `contextBudget` is **64k for every row**. A row measured at a different budget is not comparable: one model
  measured at 16k scored a defect higher than the same model at 64k with nothing else changed, which is variance,
  not a setting worth tuning per model.
- Two to five runs per row; the run count is in the `found` column. Identical runs of one model span one to two defects, so a single run cannot rank two models.
- Every score on quantised local inference is a floor for that model, not a verdict.
- Wall times move with whatever else the machine is doing: the same settings were measured at 116 s and 326 s.
- A frontier model (GLM-5.3) reviews each fixture as an oracle check: `vending-supabase` 5 of 5, `vending` 5 of 6, no fabrications. A fixture the oracle cannot answer is a broken test, not a bad model.

## Results

`vending-supabase`, six defects, shipped prompt, 64k context, two runs unless stated.

| model | preset | found | mean | wall |
|---|---|---|---|---|
| **Qwen3.6-35B-Turbo** | card instruct: 0.7 / 0.8 / presence 1.5 | 5 · 5 | **5.0** | 222 s |
| **tiel-coder-35b** | backend defaults | 6 · 4 | **5.0** | 204 s |
| inkling-2-mini-96k | `reasoning_effort: low` | 4 · 5 | 4.5 | 256 s |
| Ornith-1.5-35B-Turbo | card row | 3 · 6 | 4.5 | 677 s |
| Qwen3.6-35B (standard) | card instruct: 0.7 / 0.8 / presence 1.5 | 4 · 4 | 4.0 | 236 s |
| Qwen3.6-35B (standard) | 0.6 / 0.95 / presence 0 | 4 · 3 | 3.5 | 236 s |
| GLM-4.7-Flash | card agentic: 0.7 / 1.0 | 3 · 4 | 3.5 | 509 s |
| Qwen3.5-9B-Turbo | thinking, general: 1.0 / 0.95 / 1.5 (3 runs) | 4 · 3 · 3 | 3.33 | 176 s |
| Qwen3.5-9B-Turbo | instruct, general: 0.7 / 0.8 / 1.5 (3 runs) | 4 · 2 · 3 | 3.00 | **136 s** |
| Mellum2.1 | card: temperature 1.0 | 2 · 4 | 3.00 | 141 s |
| Qwen3-Coder-Next (80B, 3B active) | card row | 4 · 2 | 3.00 | 256 s |
| LFM2.5-2.6B | card | 2 · 1 | 1.50 | 124 s |

### What to run

- **A gate that catches the most: `Qwen3.6-35B-Turbo`** on its card's instruct preset. Five of six, ~4 minutes. The
  standard build of the same model is a defect behind at the same speed, so the Turbo build is the one to load.
- **A cheaper gate: `Qwen3.5-9B-Turbo`**, three of six in ~2½ minutes on a tenth of the memory.
- **Not recommended:** `LFM2.5-2.6B` (1.5 of 6) and `GLM-4.7-Flash` (3.5 of 6 in 8 minutes).

### Settings that changed nothing

Measured on this fixture, each with two or more runs:

- **Thinking on vs off** — no recall difference on the 9B, the 35B, Mellum2.1 or Ornith; the 35B and Mellum were
  40–100% slower with it on.
- **`enable_thinking: false` on Ornith is accepted and ignored**: with the flag set it still wrote 52k and 74k characters of
  reasoning, and throughput stayed at ~38 tok/s in every arm. There is no thinking control on this build for that model.
- **`preserve_thinking`** was not tested: it only matters if thinking can be switched, and on this build it cannot.
- **Card preset vs the older sampler on the 35B** — 4.0 against 3.5, inside the run-to-run spread.

## Measuring

```bash
npm run eval -- --fixture vending-supabase --settings tools/eval/settings/qwen36-standard.json --runs 3 --device tiiny --out out/screen.jsonl
```

- A **fixture** holds `base/`, `head/` and `expect.json`; the harness commits both sides so every run sees the same diff, and scores rows against the planted defects by name.
- A **combo** is a whole `.ai-review.json`. `"deviceDefaults": true` fills the sampler block from the device's live `/props`.
- `--device tiiny` loads and polls; `none` does nothing, for an endpoint that manages its own models.
- Rows append with a `sweep` id, their `work` dir, the `prompt` hash and the `limits`, so a sweep can be re-scored from disk instead of re-run.
- One sweep at a time (lock file); orphaned containers are pruned before each sweep.

To see what the client sends, run the proxy:

```bash
UPSTREAM=http://<device>:<model port> HOST=0.0.0.0 PROXY_LOG=out/requests.jsonl node tools/proxy.mjs 8788
```
