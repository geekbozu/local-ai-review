# local-ai-review

A GitHub Action that reviews a pull request with a language model on your own hardware, and posts what it finds as
inline comments. Advisory: it never blocks a merge.

It is an agent, not a prompt pipeline. The model gets the diff, tools, and as many turns as it needs to follow a lead —
reading a caller, checking a value, writing a benchmark — and reports findings through tools rather than prose. A
separate step posts them, so the thing that comments never holds a credential the agent could read.

## How it works

```
pull request → own workflow → checkout (fetch-depth: 0, no persisted credentials)
             → pi agent in bubblewrap, model calls via a loopback proxy
             → findings as JSONL → quoted-text anchoring → one PR review, inline comments
```

## Requirements on the runner

**The runner has to be able to reach your model.** This is a local-model action, and the usual GitHub setup cannot help
you: a GitHub-hosted runner is a machine in GitHub's cloud, your model is a box on your network, and there is no route
between them. A workflow built on `runs-on: ubuntu-latest` will time out trying to reach `http://192.168.x.x/v1`.

Three ways to satisfy it, in the order most people should consider them:

| | What it means | Trade |
|---|---|---|
| **Self-hosted runner on the same network** (recommended) | A GitHub Actions runner on a machine that can reach the model. Any spare Linux box, or the model host itself if it runs a container runtime. | You maintain a runner; the model stays private. |
| Tunnel from the model host | `cloudflared`, tailscale, a WireGuard peer — the endpoint becomes reachable from a public runner. | The model is exposed, however narrowly. Put authentication in front of it and keep TLS on. |
| Public endpoint | The model is genuinely internet-facing. | Not recommended for a device that serves one request at a time: you have published an inference endpoint with no rate limit but its own. |

The rest of this document assumes the first. `.github/workflows/ai-review.yml` in this repository is written for it, and
the self-hosted runner is also what makes `providerTimeoutMs` and `contextBudget` meaningful — a slow device needs both,
and a cloud runner would give up first.

**`bubblewrap` must be installed.** The agent runs inside it, and without it the job **fails** rather than running
unsandboxed — a green run that quietly dropped its boundary is worse than a red one.

```bash
apt-get update && apt-get install -y bubblewrap
bwrap --ro-bind / / true && echo ok          # needs CAP_SYS_ADMIN or unprivileged user namespaces
```

`ripgrep` and `fd` are **recommended**, not required: the agent's `grep` and `find` tools use them, and their absence
makes it fall back to shell greps with no output ceiling. `apt-get install ripgrep fd-find` (Debian names the binary
`fdfind`).

The runner must be able to reach your model endpoint. Nothing else outbound is needed.

## Set up

```yaml
jobs:
  ai-review:
    runs-on: [self-hosted, linux, arm64]
    timeout-minutes: 90
    continue-on-error: true                  # advisory
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: geekbozu/local-ai-review@<40-character-sha>   # pin a commit, not a tag
        with:
          base-ref: origin/${{ github.base_ref || 'main' }}
          base-url: ${{ vars.AI_REVIEW_BASE_URL }}          # e.g. http://model-box/v1
        env:
          AI_REVIEW_API_KEY: ${{ secrets.AI_REVIEW_API_KEY }}
```

Then add a `.ai-review.json` at the repository root. No file, no review — that is the opt-in.

## `.ai-review.json`

Everything is optional; the defaults are the tool's opinion about a reviewer, not about your hardware.

| Key | Default | Meaning |
|---|---|---|
| `rules` | `["AGENTS.md", ".pi/rules/**/*.md"]` | Rule files, restored from the **base ref** so a pull request cannot rewrite what judges it |
| `ignore` | `[]` | Paths the review will not comment on |
| `instructions` | `[]` | Lines appended to the prompt verbatim |
| `riskHints` | `[]` | Regexes that order attention; they do not scale effort |
| `severityFloor` | `"low"` | Nothing below this is posted inline |
| `confidenceFloor` | `7` | The agent's own 0–10 certainty; below this a finding is folded, not posted |
| `maxTurns` | `60` | Runaway stop |
| `contextBudget` | `0` (off) | Wrap up past this many tokens of context |
| `providerTimeoutMs` | `300000` | How long the client waits for the model to say anything; `0` for no limit |
| `timeBudgetMinutes` | `0` (off) | Wall clock |
| `resultChars` | `64000` | Cap on one `read` result; `bash` is capped at 16000 in the extension |
| `model` | — | Model id; the action input is the fallback |
| `thinking` | `"low"` | `off` / `minimal` / `low` / `medium` / `high` |
| `modelSettings` | see below | Everything the model call needs |

`modelSettings` defaults: `contextWindow 262144`, `maxTokens 65536`, `temperature 0.6`, `topP 0.95`, `topK 20`,
`minP 0`, `presencePenalty 0`, `frequencyPenalty 0`, `dryMultiplier 0`, `dryAllowedLength 0`, `repeatPenalty 1`,
`reasoning true`, `thinkingFormat "openai"`.

`frequencyPenalty` and `dry*` are sent only when non-zero, because a server that does not know a field may reject the
request. They exist because some models loop; a looping model needs them set, and the model card will not say so.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `base-url` | — | OpenAI-compatible endpoint, **including `/v1`** (added if missing) |
| `model` | — | Optional when `.ai-review.json` names one |
| `base-ref` | `origin/main` | Ref to diff against |
| `api-key-env` | `AI_REVIEW_API_KEY` | Name of the variable holding the key; the value is never written to disk |
| `max-tokens` | — | Optional output ceiling per turn; the config's `maxTokens` applies when unset |
| `time-budget-minutes` | `0` | Wall-clock backstop, `0` for off |
| `upload-events` | `false` | Upload the raw event stream. It records tool results — file contents — so it belongs off in a public repository |
| `pr-number` | event's | For manual runs |
| `post` | `true` | `false` reviews without commenting |

## Defaults and deployments

A default here assumes a system that serves its own context at speed. Numbers that describe *your* hardware belong in
your `.ai-review.json`, not in this repository:

- a device that needs minutes to read a large prompt sets `providerTimeoutMs` and `contextBudget`;
- a model that loops sets `temperature`, `presencePenalty`, `frequencyPenalty` and `dryMultiplier`;
- a model that writes essays sets `maxTokens`.

The defaults are the reviewer's own bounds: turn count, severity floor, confidence floor.

## What the artifact holds

`ai-review-run`: findings, the prompt, the notes (what was dropped and why) and a readable transcript. `ai-review-events`,
as a separate artifact, holds the raw event stream and is **off** unless `upload-events` is `true`: tool results are
file contents, and artifacts are as visible as the repository.

## Versioning

**`1.0.0` is the first release**, and the only tag worth pinning by name. Tags are for a human reading the list;
**pin a commit** — a tag can move, and a self-hosted runner caches the action under its ref, so a moved tag arrives at a
time nobody chose. Earlier `0.0.N` tags recorded commit counts during development and were never releases.

## More

- [`docs/design.md`](docs/design.md) — the measurements behind these choices
- [`docs/security.md`](docs/security.md) — what the sandbox enforces, and what it does not
- [`docs/model-testing.md`](docs/model-testing.md) — what was tried on real hardware, what settings each model needed, and what did not work
- [`docs/reference/tiiny.md`](docs/reference/tiiny.md) — notes on the device this was built against
- `tools/eval/` — the harness and fixtures behind every number in `docs/model-testing.md`: `npm run eval -- --fixture vending-supabase --settings tools/eval/settings/qwen36-standard.json --runs 3`
