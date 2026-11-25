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
- `found` = defects reported, of six. `kept` = findings the model left in its list. `wall` = seconds.
- Two to five runs per row; the run count is in the `found` column. Identical runs of one model span one to two defects, so a single run cannot rank two models.
- Every score on quantised local inference is a floor for that model, not a verdict.
- Wall times move with whatever else the machine is doing: the same settings were measured at 116 s and 326 s.
- A frontier model (GLM-5.3) reviews each fixture as an oracle check: `vending-supabase` 5 of 5, `vending` 5 of 6, no fabrications. A fixture the oracle cannot answer is a broken test, not a bad model.

## Results

`vending-supabase`, shipped prompt:

| model | preset | found | kept | wall |
|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | instruct: 0.7 / 0.8 / presence 1.5 | **5.00** (6 / 5 / 4) | 5.3 | 296 s |
| `qwen38-27b-unleashed` | backend defaults | **5.00** (4 / 5) | 5.5 | 310 s |
| `tiel-coder-35b` | backend defaults | 4.60 (5 / 5 / 4 / 5 / 4) | 4.7 | **136 s** |
| `inkling-2-mini-96k` | `reasoning_effort: low`, 16k budget | 4.60 (6 / 4 / 5 / 4 / 4) | 5.0 | 176 s |
| Qwen3.6-35B-A3B-Turbo | instruct: 0.7 / 0.8 / presence 1.5 | 4.33 (4 / 5 / 4) | 5.0 | **224 s** |
| Qwen3.5-9B-Turbo | thinking, general: 1.0 / 0.95 / 1.5 | 3.33 (4 / 3 / 3) | 4.0 | 176 s |
| Qwen3.5-9B-Turbo | instruct, general: 0.7 / 0.8 / 1.5 | 3.00 (4 / 2 / 3) | 3.0 | **136 s** |
| `Mellum2.1` | card: temperature 1.0 | 3.00 (3 / 3) | 3.0 | **70 s** |
| `LFM2.5-2.6B` | card | 2.50 (3 / 2) | 2.0 | 84 s |
| `LFM2-1.2B-tool` | card | 0.00 (0 / 0) | 0.0 | 34 s |

Not on the current fixture or prompt, so not comparable:

| model | measured | note |
|---|---|---|
| Qwen3-Coder-Next (80B, 3B active) | 4 of 5, older fixture, 209 s | never re-run here |
| Qwen3.6-35B-A3B | 5 of 5, older fixture, 0.6 / 0.95, 448 s | sampler comparison |
| GLM-4.7-Flash | 3 of 6, 305 s, GitHub-rubric prompt | different prompt |
| Ornith-1.5-35B | 2 of 5, older fixture, 868 s | see below |

Unusable:

| model | what happens |
|---|---|
| `ornith-ai/Ornith-1.5-35B-A3B-Turbo` | reads everything, files one finding, 500-900 s |

## Per-defect, older five-defect fixture, ~19 runs

| defect | missed | note |
|---|---|---|
| unescaped interpolation into markup | 18 of 19, then 3 of 6 | fixed by naming the class in the prompt |
| stale comment above a changed value | 18 of 19, then 6 of 6 | seen and declined ("not a functional defect") |
| document the change falsified, outside the diff | most runs on both fixtures | needs a step that opens it |
| `pull_request_target` | 5 of 19 | flaky |
| missing `await` | 7 of 19 | — |
| strict single-row read | 3 of 19 | — |

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
