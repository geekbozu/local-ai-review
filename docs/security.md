# Security model

This action checks out a pull request and lets a language model run commands inside that checkout. The pull request is
written by someone who may want the model to do something other than review it. Everything below follows from that.

The design rule: **a boundary the OS enforces, never a boundary a command string is read for.** An agent that is
argued with can be argued around; a mount that is read-only cannot.

## What a hostile pull request is trying to do

| Goal | Why it is worth doing |
|---|---|
| Reach a credential | the endpoint key, a runner registration token, `~/.ssh`, `~/.config/gh`, a container socket |
| Persist past the run | the runner is self-hosted, so its workspace, cache and home survive the job |
| Publish through the bot | a comment carries the repository's trust: mentions, remote images, links |
| Silence the review | whatever decides which findings are posted is worth editing |

## Three properties, and where each is enforced

### 1 · Nothing worth stealing is reachable

- **The endpoint key never enters the agent's process.** A loopback proxy in the review step holds it and forwards; the
  child gets a per-run random token that only that proxy accepts.
- **The environment is cleared.** The child starts with `--clearenv` plus a whitelist: no runner environment, no token.
- **The filesystem is read-only outside the checkout.** Root is bound read-only, so `$HOME/.ssh`, the docker socket and
  the runner's own configuration can be read but not used to persist.
- **`GITHUB_TOKEN` is not in this step at all.** It exists only where posting happens.

### 2 · Writes are confined

`bwrap` binds four writable paths: the workspace, the per-job agent directory, and **two files** in the runner's temp —
findings and notes. `/tmp` is a fresh tmpfs. The shared agent cache is never mounted; each job gets a copy.

Writes inside the checkout are **allowed on purpose**: a reviewer that suspects a quadratic loop should be able to write
a benchmark and run it. Binding two files rather than their directory matters — the coverage report is computed from the
event stream, and a writable stream would let a review report on files it never opened.

### 3 · What the agent says is untrusted

- **The policy is frozen before the agent runs.** The diff, the severity floor, the confidence floor and `ignore` are
  resolved against the **base ref** and written to the per-job temp, which is outside every writable bind. This matters
  because `.git` lives in the tree the agent may write: otherwise a pull request sets its own floors and grades itself.
- **Posting is inert.** Bodies are capped, `@` is escaped, image and raw-HTML syntax is stripped, and our own marker
  comment is removed — a forged marker would otherwise suppress a real finding forever. Dropped findings are sanitised
  and capped too.
- **Markers only count from our own identity.** Anyone who can comment can compute a marker, so a comment that is not
  ours is ignored.

## The sandbox

Required. If `bwrap` is not on the runner the job **fails** — it does not skip, and it does not run unsandboxed.

```bash
apt-get update && apt-get install -y bubblewrap   # once per runner
bwrap --ro-bind / / true && echo ok               # verify: needs CAP_SYS_ADMIN or unprivileged userns
```

This action does not install it: a step that installs a sandbox runs outside the sandbox.

```
--ro-bind / /                                 readable, not writable
--bind "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE"  the one writable tree
--bind findings, notes                        exactly two files, not their directory
--bind "<per-job agent dir>"                  the seeded cache copy and its scratch
--tmpfs /tmp /run /root /_work/_actions       scratch, runtime sockets, the runner's home, the action's own source
--dev /dev --proc /proc
--unshare-pid --die-with-parent --clearenv --cap-drop ALL
```

**No uid drop**, and that is measured rather than preferred: a runner container usually runs as root, and `--unshare-user`
then maps root to root, so `--uid 1000` lands on the overflow uid and can write nowhere. Dropping privileges needs a
non-root runner user, which is the runner's decision. What is enforced instead: every capability dropped — so no DAC
override, no mount, no ptrace across the pid namespace — nothing writable but the binds above, and the paths worth
reading hidden by a mount.

**Network stays.** With no credentials in the child there is nothing left to send that the attacker did not already write.
It does not cover runner-local services: a self-hosted runner exposes an `ACTIONS_RUNTIME_TOKEN` over a metadata socket.

## What is deliberately not built

**No command inspection.** There is no guard that reads a `bash` command and decides whether it is allowed. Such a guard
loses to `..`, a variable, a subshell, an alias, a relative path, or a program nobody considered — and it lost in
practice: an absolute-path check held, and the same file was read through a relative one. Path hiding is done by the
mount.

## Supply chain

- Consumers should pin a **commit SHA**. A tag can move, and a self-hosted runner caches the action under its ref, so what
  a moved tag means is "a change that arrives at a time nobody chose".
- Release tags are for a human reading the list; they are not what a consumer pins.

## Limits, stated rather than implied

- **The model can be convinced.** These properties bound what a convinced model can *do*, not whether it can be.
- **A read-only mount is still readable.** A world-readable file the sandbox does not hide remains readable.
- **The child runs as root inside the sandbox, minus every capability.** No `CAP_DAC_OVERRIDE` follows, so it cannot
  create a file in a directory owned by another uid; the two files it writes are created by the parent first.
- **An extension that fails ends the run.** A review that cannot record a finding is not a review.
- **The posted body is a bounded exfiltration channel.** Nothing stops a convinced agent pasting a file's contents into
  a finding body, up to the cap. What the sandbox removes is the credential worth stealing and the beacon.
- **Rules are restored before the agent runs, not protected from it afterwards.** The rule loader re-reads files as
  tools run, and the checkout is writable.
