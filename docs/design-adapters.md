# Adapters: what loading a model is, and how it becomes a seam

Prework for issue #11. No code here yet — this is the shape of the change, measured against what
`src/review.mjs` does today. The operator's goal, in their words: *"making the model-loading code extensible
but re-useable — we should be able to effectively wrap the loader code to make sure it's good."* The subject is
the loader, not a catalogue of devices.

## What "loading a model" is today

It is four assumptions about the endpoint, checked at three places and discovered nowhere.

- The endpoint is `AI_REVIEW_BASE_URL`, normalised once (`src/review.mjs:65`, `src/lib/url.mjs`): the
  `/v1` that is always missing is the only hardware knowledge the action has.
- The proxy targets it as-is (`review.mjs:80`) and the child is handed `proxy.baseUrl` (`review.mjs:160`) —
  the gateway URL, never a port the device may have named.
- Everything about the model comes from config (`review.mjs:159-167`): `writeAgentDir` copies
  `config.modelSettings` plus an env clamp on `maxTokens`. No field is read from the device.
- Load state is discovered **after the run**. An unloaded model surfaces as a mid-run 404, caught by the
  `answered` guard (`review.mjs:296-300`) and the empty-review guard (`review.mjs:322`), and classified by a
  regex over the error string (`review.mjs:392`, `/is not loaded/i`).

What is not there today, and what each absence costs:

| Not present | What it costs |
|---|---|
| A readiness check before the spawn | The device's own failure modes cost a full review run before they are named |
| Port discovery | A device that serves the model on its own port is only reachable if its gateway forwards |
| A sampler or context read (`/props`) | Every deployment hand-copies a preset that the device would have answered |
| A load call | "Ensure it is loaded" is a manual step documented in `docs/reference/tiiny.md`, re-learned per operator |

One more thing is not there: *wrappability*. There is no loader to wrap. The steps above are inline statements
inside `run()`, so no caller can compose anything around them — not a retry, not a pre-flight, not a test fake.
That is the actual defect issue #11 names.

## The interface, concretely

```js
// A loader answers two questions about one deployment's hardware.
ensure(model, { signal }) -> { baseUrl, port?, samplerDefaults? }
verify(model) -> boolean   // residency only: is the model already loaded? No launch, no side effects
describe() -> string   // one line for the log: what it talked to, what it read
```

- `ensure` is the whole contract: make `model` reachable, then return where to reach it. It may *load* the
  model (poll a management API), it may only *verify* it, and it returns what the device said — not what it
  assumes. `samplerDefaults` is present only if it was **read** from the device (e.g. `/props` on the model's
  own port); a loader that cannot read one returns without the field.
- The rule that keeps this from becoming the mistake the repo keeps catching (D16: *defaults describe a
  reviewer; deployments describe hardware*): **a loader may read device facts and never encode them.** No
  device-specific number may appear in a loader as a default; if the device did not say it, the loader does not
  return it.
- Nothing in the interface knows which repository it is in, matching the header of `review.mjs`. Config
  (`device: none | tiiny | llama-swap` in `.ai-review.json`) selects the loader; `none` is what ships.

Call sites that would change, and the shape of each change — none of this is written yet:

| Site | Change |
|---|---|
| `review.mjs:65` | `baseUrl` resolution moves into the loader selection; `device: none` reproduces `normaliseBaseUrl(env.AI_REVIEW_BASE_URL)` exactly |
| `review.mjs:80` | The proxy targets the loader's returned `baseUrl` (the model's port when the loader names one), not the raw env value |
| `review.mjs:159-167` | `writeAgentDir` settings merge: config `modelSettings` wins over `samplerDefaults`; the loader fills only what config leaves unset |
| `review.mjs:296-322` | The guards stay — pre-flight does not replace them — but a loader failure before the spawn becomes a distinct, named failure instead of a post-run regex match |
| `.ai-review.json` schema (`src/lib/config.mjs`) | `device` field, default `none`, validated so a wrong name fails loudly |

## Two implementations sketched against it

**`none`** — the shipping default, and the constraint the issue states: byte-identical behaviour to today.

```js
// ensure returns the configured base URL and reads nothing.
ensure: async (model, { signal }) => ({ baseUrl: normaliseBaseUrl(env.AI_REVIEW_BASE_URL) })
```

No polling, no management API, no `/props`, no `port`, no `samplerDefaults`. If `none` ever returns a sampler
default, it has encoded a device's numbers, and it has broken its own reason for existing.

**`tiiny`** — a real device, proving the interface is not shaped around `none`. Against the API mapped in
`docs/reference/tiiny.md`: `POST /api/v1/models/{id}/launch` if the model is not resident, poll
`/models/running` until `status === "running"` (one to four minutes; the `{signal}` is what lets a caller bound
that), then read `/props` on the model's own port and return `{ baseUrl: host, port, samplerDefaults: params }`
— every field read off the box, none invented.

**`llama-swap` (stub)** — answers with fixed values: `{ baseUrl: env.AI_REVIEW_BASE_URL }` plus a fixed
`samplerDefaults`, and `describe()` says so. A stub proves a different thing than the real device does: the
interface must survive a loader that *cannot* verify residency, and the caller must not require `port`. A real
swap-box loader is issue #11's own done-when, not this document's.

## Wrappability — the point of the document

The operator's goal. A loader is a function value, so a caller can compose around it without touching it. For
each wrapper: whether the current inline code allows it, and what the interface must expose.

| Composition | Today | What the interface must expose |
|---|---|---|
| **Retry** (launch poll is asynchronous; a device mid-download is not ready yet) | Impossible — the "loader" is inline in `run()`, runs once, and its failure mode is a post-run regex | `ensure` as a pure function with an `{signal}` argument, **plus a retryable error**: `ensure` rejects with a typed error — `retryable: true` for "not loaded", a refused connection, a timeout mid-launch; `retryable: false` for a 401 bad key or a 400 malformed model id, which retrying only turns into a 45-minute job. This is a **different** distinction from `environmental()` (`review.mjs:391-399`), which classifies skip-vs-fail for the workflow, not retry-vs-don't for a wrapper. They overlap (most environmental failures are also retryable) but are not the same list — a 401 is neither — and a wrapper must not read one off the other |
| **Pre-flight check** (fail in 5 s with "model not loaded" instead of after a 10-minute run) | Impossible — no code runs between `review.mjs:80` and the spawn that knows anything about the device | A **`verify()`** residency check (above), called before the spawn: is the model already loaded? — no launch, no side effects, cheap to bound at five seconds. It cannot be `ensure` with a short timeout: cold, `ensure` launches and polls for one to four minutes, so a 5-second bound fails exactly on the cold device pre-flight exists to make pleasant. Bounding `ensure` belongs to the caller's load budget (the timeout row), not to the seam |
| **A log line** (`[ai-review] device tiiny: Qwen/… resident on :9097, n_ctx 131072 read from /props`) | Impossible — there is no single place where device knowledge exists to log | `describe()`, called by `run()` after `ensure`, so the log answers "what did it talk to" without a re-run |
| **A fake for tests** | Impossible — the endpoint is env vars and the path is inline; the existing seams (`dry`, `clientArgv`) stop before any device code | `run(options)` gaining a `loader` option, like `sandbox` and `clientArgv` today: a seam is a function argument, never an env var |
| **A timeout** (a hung management API must not hang the job) | Impossible today; the client's `providerTimeoutMs` only bounds the model call, not startup | The `{signal}` argument — a wrapper's `AbortSignal.timeout()` cancels `ensure`, and `run()` treats it as environmental, like a refused connection |

The pattern is the one the repo already states in `design.md`: the seams are **function arguments**, not
environment variables. A loader is one more argument with a default, and the default (`none`) changes nothing.

## What must not happen

| | |
|---|---|
| A device-specific number in a default | The mistake D16 names. A loader returns what the device said; a default is a reviewer, not hardware |
| A wrong `device` silently skipping a check | `device: tiiny` pointed at a swap box must fail with "the management API answered 404", not fall through to `none`'s behaviour and let the run discover it mid-flight |
| A loader returning sampler values it invented | `samplerDefaults` exists because `/props` is the authority; a value the loader made up is a hand-copied preset with worse provenance |
| The guards removed because pre-flight exists | Pre-flight makes the post-run `answered` and empty-review guards rarer, not unnecessary; a model that loads and then dies mid-run still needs them |

## Open questions

1. **What does a *skipped* run mean when the device is down?** Issue #14's taxonomy: a review that could not run
   must not conclude success, and the action already emits `skip=true` with a reason for environmental
   failures. Is "device unreachable at pre-flight" the same outcome as "device refused mid-run" (today: yes,
   via the same `ENVIRONMENTAL` list), and does the consumer's `continue-on-error` — #14's actual defect —
   still swallow it either way? The loader can *name* the failure; #14 decides its colour.
2. **Should a loader override a sampler the config already set?** The sketch says config wins and the loader
   fills only what is unset, because `.ai-review.json` is one repository saying "this one". But the device's
   `/props` is the authority and a stale hand-copied preset is exactly what this change is trying to retire.
   Deciding means choosing between "config is deliberate" and "config goes stale" — not obvious, not decided here.
3. **Does the loader own the per-device request ceiling** (the ~10-minute cut), or is that still
   `providerTimeoutMs` config the deployment sets with the device's docs open? A loader could return a
   `requestCeilingMs` the way it returns `samplerDefaults` — but that is a third kind of fact in the return
   shape, and the interface above deliberately does not have it yet.
4. **Who times the launch poll?** `ensure` takes `{signal}` so a *caller* can bound it, but `run()` must pick a
   bound, and a one-to-four-minute load inside a CI job is a new class of wait the job's own timeout may cut
   first. Unmeasured; needs a real device.
