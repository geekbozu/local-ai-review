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

Pin a commit. A review bot that changes under you is one you stop reading, and a tag can move — a self-hosted
runner even caches the action under its ref, so a moved tag arrives at a time nobody chose.

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
| `maxTurns` | `60` | Runaway stop. The agent is steered to wrap up and report at this many turns; it is not a tuning knob, so pick a number that is obviously too high and leave it |
| `thinking` | `low` | `off`, `minimal`, `low`, `medium`, `high` |
| `enabled` | `true` | `false` opts out without deleting the file |
| `model` | action input | Override the model per repo |
| `modelSettings` | see below | What the model call needs: sampling, budgets, whether it thinks at all |
| `resultChars` | `64000` | Cap on one tool result. A backstop against a whole-file read owning the run, not a reading policy |
| `timeBudgetMinutes` | `0` | Wall clock, 0 = off. Effort is allocated by turns; this is for a wedged run |

`modelSettings` is where the things that change when the model changes live, so they can be edited without a release:

```json
"modelSettings": {
  "contextWindow": 262144,
  "maxTokens": 65536,
  "temperature": 0.6,
  "topP": 0.95,
  "topK": 20,
  "minP": 0,
  "presencePenalty": 0,
  "repeatPenalty": 1,
  "reasoning": true,
  "thinkingFormat": "openai"
}
```

- **`reasoning` / `thinkingFormat`** — a model with no thinking parameter sets `reasoning: false` and `thinkingFormat: "none"`, and no compatibility shim is sent. `openai` sends `reasoning_effort`; `qwen-chat-template` sends `chat_template_kwargs.enable_thinking`.
- **`maxTokens`** is the client's output budget, not a review budget: below the size of the model's thinking it truncates a turn mid-thought and returns no tool call at all.
- **`temperature`** follows the serving card. Too cold on a reasoning model makes it restate an angle instead of converging.

Second, one job:

### Requirements on the runner

**`bubblewrap` must be installed.** The review runs inside it, and without it the job **fails** rather than running
unsandboxed — a green run that quietly dropped its boundary is worse than a red one.

```bash
apt-get update && apt-get install -y bubblewrap   # once per runner, not per job
bwrap --ro-bind / / true && echo ok               # verify: needs CAP_SYS_ADMIN or unprivileged user namespaces
```

The action does not install it. The threat model, what the sandbox does and does not prevent, and why no guard reads
a command string: [`docs/security.md`](docs/security.md).

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
      # Pin a commit, not the tag. A tag moves; a self-hosted runner caches the action by its ref, so what a moved tag
      # means in practice is a change that arrives at a time nobody chose.
      - uses: geekbozu/local-ai-review@<40-character-sha>
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
| `upload-events` | `false` | Upload the raw event stream as an artifact. It records tool results — file contents — so it is off by default; a private repository that wants the trace for triage can turn it on |
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
