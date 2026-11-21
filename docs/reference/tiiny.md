# Notes on the Tiiny Pocket API

Not ours. [`thezolon/tiiny-api-notes`](https://github.com/thezolon/tiiny-api-notes) is an unofficial map of the
device's API, Apache-2.0, and it is better than anything else public. Fetch it rather than vendoring it:

```bash
curl -sL https://raw.githubusercontent.com/thezolon/tiiny-api-notes/main/docs/API.md
```

A Tiiny is one OpenAI-compatible endpoint you can point this action at. Everything below is the small part of
those notes that changes how a reviewer has to be written, kept here so a missing `/v1` does not cost an hour.

## What bites

| Thing | What happens |
|---|---|
| **The base URL needs `/v1`** | The OpenAI-compatible base is `http(s)://<device>/v1`. Given the bare host, every request 404s with `{"detail":"Not Found"}` and nothing names the missing segment |
| **Thinking counts toward `max_tokens`** | A thinking model with a small ceiling returns empty `content`, `finish_reason: "length"`, and the whole budget spent in `reasoning_content`. It reads as a refusal. Either raise the ceiling or send `chat_template_kwargs: {"enable_thinking": false}` |
| **`max_tokens` is not the only ceiling** | The client can cap output too — Pi enforces the model entry's `maxTokens`, so the field that matters may not be the one in the request |
| **`thinking` metadata can lie** | Some models report `thinking.supported: false` and think anyway |
| **Models load and unload** | `GET /api/v1/models/running` lists what is loaded; loading is asynchronous, so poll `/v1/models` rather than assuming |
| **`need_update` reads false while offline** | "No updates" can mean "no internet". A model update is `DELETE` then `POST /api/v1/models/{id}/download`; there is no update call in the API or the CLI |
| **Response speed depends on output** | The server reports `timings.predicted_per_second`. Repetitive output (counting, tables) measured ~3x faster than prose on the same model in the same session, which is consistent with speculative decoding. Plan on the slow figure |
| **Prompt caching is real when enabled** | A repeated prefix reports `cached_tokens`, and a repeat of a 10.8k-token prompt answered in ~1 s against ~17 s cold. Do not rewrite the prefix mid-conversation — a mid-conversation *system* message folds into the leading prompt and invalidates everything after it |

## What that means for this action

The last two are why `src/extensions/turn-cap.js` steers with a **user** message rather than a system one, and why
`src/review.mjs` sets the output ceiling in **both** places it can be set. The first is why the base URL is
normalised on the way in.
