# Security model

This action checks out a pull request and lets a language model run commands inside that checkout. The pull
request is written by someone who may want the model to do something other than review it. Everything below
follows from that one sentence.

The design rule: **a boundary the OS enforces, never a boundary a command string is read for.** An agent that is
argued with can be argued around; a mount that is read-only cannot.

## What a hostile pull request is trying to do

| Goal | Why it is worth doing |
|---|---|
| Reach a credential | the model endpoint key, a runner registration token, `~/.ssh`, `~/.config/gh`, the docker socket |
| Persist past the run | the runner is self-hosted, so its workspace, cache and home survive the job |
| Publish through the bot | a comment carries the repository's trust, and can mention people, embed remote images, or link anywhere |
| Silence the review | whatever decides which findings are posted is worth editing |

## Three properties, and where each is enforced

### 1 · Nothing worth stealing is reachable

- **The endpoint key never enters the agent's process.** A loopback proxy in the review step holds the real key and
  forwards; the child receives a per-run random token that only that proxy accepts. A successful injection can use
  the model it was already using, and cannot take the credential.
- **The environment is cleared.** The child is started with `--clearenv` plus the handful of variables it needs. It
  does not inherit the runner's environment.
- **The filesystem is read-only outside the checkout.** Root is bound read-only, so `$HOME/.ssh`, the docker socket
  and the runner's own configuration can be read but not used to persist.
- **The GitHub token is not in this step at all.** `GITHUB_TOKEN` exists only in the posting step's environment.

### 2 · Writes are confined to the workspace

`bwrap` binds four writable paths: `$GITHUB_WORKSPACE`, the per-job agent directory, and exactly two files in the
runner's temp — the findings file and the notes file. `/tmp` is a fresh tmpfs. The shared agent cache is **never mounted
at all** — each job gets a copy, so a run benefits from a warm cache without being able to poison the next one.

Binding two files rather than their directory matters: the coverage report is computed from the event stream, and a
writable stream would let a review report on files it never opened.

Writes inside the checkout are **allowed on purpose**: a reviewer that suspects a loop is quadratic should be able
to write a benchmark and run it. That work is discarded with the runner, and it cannot influence what is posted
(property 3).

### 3 · What the agent says is untrusted

- **The poster reads what was frozen before the agent ran.** The diff and the severity floor are written to a
  per-job directory outside every writable bind, at the start of the review, and the poster reads those. If they are
  missing, the poster fails rather than falling back to the checkout. This matters because
  `.git` lives inside the writable tree: an agent that moves `origin/main` chooses both the diff its quotes anchor to
  and the floor that decides what posts. Reading the commit *after* the agent has run was only safe against an honest
  agent, which is the same as not being safe.
- **Posting is inert.** Bodies are length-capped, `@` is escaped, and image and raw-HTML syntax is rejected, so a
  steered finding cannot ping a team or beacon a reader.

## The sandbox

Required. If `bwrap` is not on the runner, the review **skips with a notice** — it does not fall back to running
unsandboxed, because an advisory review that silently loses its boundary is worse than no review.

Install it on the runner (once, not per job):

```bash
apt-get update && apt-get install -y bubblewrap   # Debian/Ubuntu, and the Raspberry Pi OS images
bwrap --ro-bind / / true && echo ok               # verify: needs CAP_SYS_ADMIN or unprivileged userns
```

The action does not install it. A step that installs a sandbox before using the sandbox is a step running outside
it, and a runner that cannot provide `bwrap` is a configuration fact worth surfacing rather than papering over.

The invocation, in shape:

```
--ro-bind / /                                 readable, not writable
--bind "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE"  the only writable tree
--ro-bind "$cache" "$cache"                   shared, unpoisonable
--tmpfs /tmp --dev /dev --proc /proc
--tmpfs /_work/_actions                       the action's own source is not visible
--tmpfs /root                                 the runner's own home is empty
--tmpfs /run                                  every container runtime socket, not just docker's
--ro-bind-try /dev/null /var/run/docker.sock  the socket is not connectable
--unshare-pid --die-with-parent --clearenv --cap-drop ALL
```

**No uid drop**, and that is measured rather than preferred. A runner container usually runs as root, and
`--unshare-user` then maps root to root, so `--uid 1000` lands on the overflow uid and can write nowhere. Dropping
privileges needs a non-root runner user, which is the runner's decision, not this action's. What is enforced instead:
every capability dropped — so even as root there is no DAC override, no mount and no ptrace across the pid namespace —
nothing writable but two binds, and the paths worth reading hidden by a mount rather than argued with.

**Network stays.** With no credentials in the child, there is nothing left to exfiltrate that the attacker did not
already write. Unsharing the network would be stronger, and would also mean pi cannot reach anything — including the
proxy on loopback.

## What is deliberately not built

**No command inspection.** There is no guard that reads a `bash` command and decides whether it is allowed. Such a
guard is defeated by `..`, a variable, a subshell, an alias, a relative path, or a program that was not considered,
and it was defeated in practice: an absolute-path check held, and the same file was read through a relative one.
Path hiding is done by the mount instead, where it cannot be talked around.

## Supply chain

- Consumers should pin a **commit SHA**. A tag can move, and a self-hosted runner caches the action under its ref,
  so what a moved tag means in practice is "a change that arrives at a time nobody chose".
- Releases are immutable `vX.Y.Z` tags; `v1` is a moving pointer for convenience, not a guarantee.

## Artifacts

The event stream records tool results, which is to say file contents. `upload-events` defaults to **false**; a
private consumer that wants the trace for triage can turn it on. A public repository should leave it off — the
artifact is as visible as the repository is.

## What the agent cannot reach, and what it can

- **The event stream, findings aside, is not writable.** Exactly two files are bound writable inside the runner's temp
  directory — the findings file and the notes file — because the coverage report is computed from the event stream, and
  a writable stream would let a review forge which files it opened.
- **The network is not unshared.** With no credential in the child the only thing left to send is the pull request's own
  content, which its author already has. What this does not cover is runner-local services on loopback: a self-hosted
  runner exposes an `ACTIONS_RUNTIME_TOKEN` over a metadata socket, and hiding sockets in `/run` does not hide that.
  Unsharing the network would close it, at the cost of pi being unable to reach the proxy.
- **One detection is a string match.** An `Extension error` on the child's stderr ends the run; a program that prints
  exactly that string would end it too. That fails a run rather than hiding anything, but it is a blunt instrument.

## Known limits

- **The model can be convinced.** These properties bound what a convinced model can *do*, not whether it can be
  convinced. A review whose findings are nonsense is a quality failure, not a security one, and the answer to it is
  grading and coverage rather than permissions.
- **A read-only mount still allows reading.** A file that is world-readable on the runner and not hidden by a bind
  remains readable. Only what is bound or hidden is out of reach.
- **The child runs as root inside the sandbox, minus every capability.** No `CAP_DAC_OVERRIDE` follows from that: it
  cannot create a file in a directory owned by another uid. The two files it writes — findings and notes — are therefore
  created by the parent before the spawn, and anything else it needs to write belongs in the checkout.
- **An extension that fails ends the run.** A review that cannot record a finding is not a review, and the alternative was
  measured: a permission error the agent could not fix cost seventy-six turns of attempted mounts and FUSE before the run
  reported success with nothing to post.
- **The posting step holds the token.** It is a separate process with no model in it, which is what makes it safe to
  give one step a credential.
