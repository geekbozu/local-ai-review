# local-ai-review

Reviews a pull request with a model running on hardware you own, and posts the findings as inline review comments.

A composite GitHub Action. Point it at any OpenAI-compatible endpoint — llama.cpp, vLLM, Ollama, llama-swap, LM
Studio, or a box like the Tiiny Pocket — and give it a repo that has opted in. Advisory: it never blocks a merge.

- **The loop**: an agent with the whole checkout and a shell, so it can follow a suspicion into a caller and prove it.
- **Placement**: findings are anchored by the text they quote, resolved to a diff line afterwards. A model is good at
  copying a line and bad at counting to one.
- **Bounds**: a turn cap, a coverage gate that names any changed file the agent never opened, and no ability to push.
- **Free per run**: your electricity, no per-minute CI and no API bill.

Why it is shaped this way, what was measured, and which choices were close calls: [`docs/design.md`](docs/design.md).

## Using it

Two things in the consuming repo. First, `.ai-review.json` at the root — **this is the opt-in**, and without it the
action prints a notice and exits 0, so adding the workflow everywhere is safe:

```json
{
  "rules": ["AGENTS.md", ".ai-review/rules/**/*.md"],
  "ignore": ["docs/**"],
  "severityFloor": "low",
  "maxTurns": 60,
  "thinking": "low"
}
```

| Key | Default | Meaning |
|---|---|---|
| `rules` | `[]` | Paths or globs, read **from the base ref** so a PR cannot rewrite the rules that judge it. A file with `paths:` frontmatter applies only to matching changed files; one without applies to the whole review |
| `ignore` | `[]` | Paths the review should not comment on |
| `severityFloor` | `low` | `low`, `medium`, `high`, `critical` |
| `maxTurns` | `100` | Turn budget before the agent is steered to wrap up. A turn is not a fixed amount of time |
| `thinking` | `low` | `off`, `minimal`, `low`, `medium`, `high` |
| `enabled` | `true` | `false` opts out without deleting the file |
| `model` | action input | Override the model per repo |

Second, one job:

```yaml
jobs:
  ai-review:
    runs-on: [self-hosted, linux, arm64]     # anything that can reach the endpoint
    timeout-minutes: 90
    continue-on-error: true                  # advisory: never blocks a merge
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false         # the review may not commit or push
      - uses: <owner>/<repo>@v1
        with:
          base-ref: origin/${{ github.base_ref }}
          base-url: ${{ vars.AI_REVIEW_BASE_URL }}   # e.g. http://model-box.example/v1
          model: ${{ vars.AI_REVIEW_MODEL }}
        env:
          AI_REVIEW_API_KEY: ${{ secrets.AI_REVIEW_API_KEY }}
```

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `base-url` | — | OpenAI-compatible base, **including `/v1`** (added for you if missing) |
| `model` | — | Model id as the endpoint knows it |
| `base-ref` | `origin/main` | Ref to diff against |
| `api-key-env` | `AI_REVIEW_API_KEY` | Name of the variable holding the key. The value is never written to disk |
| `max-tokens` | `16384` | Output ceiling per turn. Too small and a thinking model spends it all thinking and reports nothing |
| `post` | `true` | `false` reviews without commenting, for a first look |
| `pr-number` | event's | Override for a manual run |

Anything not in the config file is the deployment's business: endpoint, model, key. Nothing about any particular
repo, endpoint or model is compiled in.

## Running it without GitHub

```bash
export AI_REVIEW_BASE_URL=http://localhost:8080/v1
export AI_REVIEW_MODEL=some-model-id
export AI_REVIEW_API_KEY=...
export BASE_REF=origin/main
node src/review.mjs        # writes findings + events to temp files, prints a summary
```

`tools/proxy.mjs` sits between the client and the endpoint and logs what actually goes over the wire — useful when a
request parameter is in doubt. [`docs/reference/tiiny.md`](docs/reference/tiiny.md) collects the endpoint traps that
cost real time (a missing `/v1`, thinking counting against the ceiling, cache invalidation); the long version is
[`thezolon/tiiny-api-notes`](https://github.com/thezolon/tiiny-api-notes), Apache-2.0, which is worth reading if you
run one of these.

## Development

```bash
npm test                   # tests only: no network, no model
node tools/leak-audit.mjs  # what a public copy of this repo would leak
```

No dependencies. Node 22.19 or newer, for `fetch` and `node --test`.
