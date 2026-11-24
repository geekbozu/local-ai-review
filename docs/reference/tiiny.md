# The Tiiny Pocket

A reference for pointing this action at a Tiiny Pocket, or at anything that serves models the same way. **One device's
numbers, not the action's defaults**: on hardware like this, these values belong in a deployment's `.ai-review.json`.

The device's own API is mapped by [`thezolon/tiiny-api-notes`](https://github.com/thezolon/tiiny-api-notes)
(Apache-2.0), which is better than anything else public. This page keeps only the parts that change how a reviewer has to
be written and operated, so a missing `/v1` does not cost an hour.

## Operating it

Set two variables once; everything below uses them.

```bash
HOST=http://<device>            # no /v1 here — this is the management API
KEY=<device API key>
API="$HOST/api/v1"
```

**What is on the device.**

```bash
curl -s -H "Authorization: Bearer $KEY" "$API/models/?including_downloading=true" \
  | jq -r '.data[] | "\(.status)\t\(.id)"'
```

`status` is `downloaded`, `downloading`, or `running`. `progress` is a percentage while downloading.

**Load a model.** Loading is asynchronous and takes one to four minutes; the call returns before the model is ready.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model_id":"Qwen/Qwen3.6-35B-A3B"}' \
  "$API/models/Qwen%2FQwen3.6-35B-A3B/launch"      # the id is URL-encoded
```

**Poll what is resident, and on which port.**

```bash
curl -s -H "Authorization: Bearer $KEY" "$API/models/running" | jq '.instances.running[] | {model_id, port}'
```

Wait for `status === "running"` for your model before sending a review. A wrong or unloaded model answers
`404 {"message":"\"<id>\" is not loaded."}` mid-run — the action turns that into a failed job rather than an empty review,
but it still costs the run.

**Talk to the model directly.** Each resident model has its own port; `$HOST/v1` is a gateway that serves whatever is
loaded.

```bash
MODEL_PORT=9097
curl -s "$HOST:$MODEL_PORT/props"        # no auth needed on the model's own port
```

**Unload, or update.** There is no update call: a new build is a delete and a download.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" "$API/models/<id>/stop"
curl -s -X DELETE -H "Authorization: Bearer $KEY" "$API/models/<id>"
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model_id":"<id>"}' "$API/models/<id>/download"
```

**Read the truth from the model, not from a label.** `/props` on the model's port is the only authority for its context,
template and sampler defaults:

```bash
curl -s "$HOST:$MODEL_PORT/props" | jq '{
  n_ctx: .default_generation_settings.n_ctx,
  params: .default_generation_settings.params,
  tools: .chat_template_caps.supports_tools
}'
```

`n_ctx` is fixed by the firmware: the `launch` call accepts no context size and silently ignores one if you send it. The
default sampler values in `params` are what the device ships, which is not always what the model's card recommends —
[`docs/model-testing.md`](../model-testing.md) records where those two disagreed and which one was right.

**Two can be resident, one is the point.** The device will hold two loaded models, and throughput collapses when it does.
Measure with one.

## What bites

| Thing | What happens |
|---|---|
| **The base URL needs `/v1`** | The OpenAI-compatible base is `http(s)://<device>/v1`. Given the bare host, every request 404s with `{"detail":"Not Found"}` and nothing names the missing segment |
| **Thinking counts toward `max_tokens`** | A thinking model with a small ceiling returns empty `content`, `finish_reason: "length"`, and the whole budget spent in `reasoning_content`. It reads as a refusal. Either raise the ceiling or send `chat_template_kwargs: {"enable_thinking": false}` |
| **`max_tokens` is not the only ceiling** | The client can cap output too — Pi enforces the model entry's `maxTokens`, so the field that matters may not be the one in the request |
| **`thinking` metadata can lie** | Some models report `thinking.supported: false` and think anyway |
| **Models load and unload** | `GET /api/v1/models/running` lists what is loaded; loading is asynchronous, so poll rather than assume |
| **`need_update` reads false while offline** | "No updates" can mean "no internet". A model update is `DELETE` then `POST /api/v1/models/{id}/download`; there is no update call in the API or the CLI |
| **Response speed depends on output** | The server reports `timings.predicted_per_second`. Repetitive output (counting, tables) measured ~3x faster than prose on the same model in the same session, which is consistent with speculative decoding. Plan on the slow figure |
| **A request is cut at about ten minutes** | `504 "Upstream model server timed out."` — and prefill is most of it: a 128k prompt costs ~5 minutes before the first token, 64k ~2 minutes, 32k under a minute. A growing chat caches its earlier part, so the cost arrives as turns getting slower and then not arriving at all. Bound the context, not just the turns |
| **Prompt caching is real when enabled** | A repeated prefix reports `cached_tokens`, and a repeat of a 10.8k-token prompt answered in ~1 s against ~17 s cold. Do not rewrite the prefix mid-conversation — a mid-conversation *system* message folds into the leading prompt and invalidates everything after it |
| **A download is not a pause** | Model loads compete with inference for the box. A sweep started during a download measures the download |

## Models measured on it

Code-review measurements only, with the preset each model's own card recommends. The full table, the fixtures and what
each setting bought are in [`docs/model-testing.md`](../model-testing.md).

| model | note |
|---|---|
| `Qwen/Qwen3.6-35B-A3B` | the recommendation: five of six defects, ~300 s |
| `Qwen/Qwen3.6-35B-A3B-Turbo` | same recall shape, ~224 s |
| `Qwen/Qwen3.5-9B-Turbo` | the cheap gate: three of six, ~136-176 s |
| `Qwen/Qwen3-Coder-Next` | 80B total, 3B active; four of five on the older fixture |
| `zai-org/GLM-4.7-Flash` | flat at three of six wherever measured; slow |
| `ornith-ai/Ornith-1.5-35B-A3B-Turbo` | not a reviewer: reads everything, files one finding, 500-900 s |
| `google/gemma-4-26B-A4B-it` | **unusable here**: token soup under the agent, though a direct request calls tools correctly |

### General models: none measured yet

This table is deliberately empty. A general-purpose chat model is not the same instrument as a code-tuned one, and the
honest position is that none has been measured for code review on this hardware. When one is, record:

| model | preset | defects found | wall |
|---|---|---|---|
| _none yet_ | | | |

Two things to check before believing a general model's score: whether it can hold a tool contract at all across many
turns (an instruction-tuned chat model often cannot), and whether its `chat_template` renders tool definitions — the
model's `/props` says whether tools are supported, but supported is not the same as trained.
