// The sandbox: what the OS enforces around the agent.
//
// Not a guard that reads commands — a mount the agent cannot argue with. Required: a runner without bubblewrap is
// misconfigured, and a green run that quietly dropped its boundary is worse than a red one.

import { execFileSync } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { join, dirname, delimiter } from "node:path";

export function resolveExecutable(name, path = process.env.PATH || "") {
  if (name.includes("/")) return name;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return name;
}

export function bwrapAvailable() {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Root is read-only; the workspace and a per-job directory are writable; the action's own checkout is hidden rather
// than forbidden; the environment is cleared and rebuilt from the whitelist below.
export function sandboxArgv({ argv, workspace, writable = [], envForChild = {} }) {
  // No uid drop, and not by preference. A runner container commonly runs as root, and `--unshare-user` then maps root
  // to root, so `--uid 1000` lands on the overflow uid and can write nowhere — measured. Dropping privileges needs a
  // non-root runner user, which is the runner's decision rather than this action's. What is enforced instead: every
  // capability gone, so even as root there is no DAC override, no mount, no ptrace; nothing writable but two binds;
  // and the places worth reading hidden rather than guarded.
  const args = [
    "--ro-bind", "/", "/",
    "--bind", workspace, workspace,
    "--tmpfs", "/root",
    // /var/run is a symlink to /run, and docker is not the only socket there: containerd, podman and cri-o all live in
    // this tree. Hiding the directory covers the ones nobody thought of.
    "--tmpfs", "/run",
    "--ro-bind-try", "/dev/null", "/var/run/docker.sock",
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "--clearenv",
    "--cap-drop", "ALL",
  ];
  for (const dir of writable) if (dir && existsSync(dir)) args.push("--bind", dir, dir);
  // The runner checks the action out beside the repository. A review that reads the reviewer is reviewing the wrong
  // thing, and this is the version of that rule that holds.
  const actions = join(dirname(dirname(workspace)), "_actions");
  if (existsSync(actions)) args.push("--tmpfs", actions);
  for (const [key, value] of Object.entries(envForChild)) {
    if (value !== undefined) args.push("--setenv", key, String(value));
  }
  args.push("--", ...argv);
  return args;
}

// The endpoint key must not exist inside the sandbox: with `bash` available, anything in the environment is readable by
// whatever the model was talked into running. This holds the key, listens on loopback, and accepts one per-run token.
