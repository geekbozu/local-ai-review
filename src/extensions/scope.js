// The review's subject is the checkout at the working directory. Anything else on the runner is tooling.
//
// Measured twice. First, a prompt line that named a path lost to a path nobody thought of — ten files read out of a
// copy of the action's source. Then the enforced version held the `read` door and the agent went round it: `cat
// /_work/_actions/.../url.mjs` through bash, three refusals on read and the same file read anyway.
//
// So both doors are held. A path is allowed if it resolves inside the working directory; anything else is refused with
// the reason, on either tool.

import { resolve, sep, isAbsolute } from "node:path";

const ALLOWED = [/^\/dev\/(null|stdin|stdout|stderr)$/, /^\/dev\/fd\//];

// Absolute-looking tokens in a shell command: after a start, space, quote, `=`, `:`, `(`, or `;`.
const PATHS_IN = /(?:^|[\s'"=:(;|&<>])(\/[^\s'"`;|&<>)]+)/g;

export default function (pi) {
  const cwd = resolve(process.cwd());
  const root = cwd + sep;
  const inside = (path) => resolve(cwd, path).startsWith(root);
  const allowed = (path) => ALLOWED.some((re) => re.test(path));

  const refuse = (path) => ({
    block: true,
    reason: `${path} is outside the reviewed repository. The subject is the checkout at the working directory; read there instead.`,
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "read") {
      const path = event.input?.path;
      if (typeof path !== "string") return;
      if (inside(path) || allowed(path)) return;
      return refuse(path);
    }

    if (event.toolName === "bash") {
      const command = event.input?.command;
      if (typeof command !== "string") return;
      for (const [, path] of command.matchAll(PATHS_IN)) {
        if (inside(path) || allowed(path)) continue;
        // A bare "/" (cd /, ls /) and the usual device paths are not worth a refusal; anything under the runner's own
        // directories is, because that is where the tooling lives.
        if (path === "/") continue;
        return refuse(path);
      }
    }
  });
}
