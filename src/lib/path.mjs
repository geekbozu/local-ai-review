// Is this path the repository, or inside it?
//
// The obvious version — `resolve(cwd, p).startsWith(cwd + sep)` — refuses the repository directory itself, because the
// resolved path has no trailing separator. Measured as two blocked commands in the first four turns of a live run: every
// shell command began `cd /_work/FrontEnd/FrontEnd &&`, which is the working directory, and was refused as outside it.

import { resolve, sep } from "node:path";

export function insideRepo(cwd, path) {
  const base = resolve(cwd);
  const target = resolve(base, path);
  return target === base || target.startsWith(base + sep);
}
