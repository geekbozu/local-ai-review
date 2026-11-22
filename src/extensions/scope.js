// The review's subject is the checkout at the working directory. Anything else on the runner is tooling.
//
// Saying that in the prompt is not enough: a measured run read ten files out of a copy of the action's own source at
// /tmp/local-ai-review, because the instruction named a path (_work/_actions) and the tooling was somewhere else. An
// instruction that enumerates paths loses to a path nobody thought of. The working directory is a boundary the harness
// can enforce, so it does, and the refusal says what to do instead.

import { resolve, sep } from "node:path";

export default function (pi) {
  const root = resolve(process.cwd()) + sep;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read") return;
    const path = event.input?.path;
    if (typeof path !== "string") return;

    if (resolve(process.cwd(), path).startsWith(root)) return;
    return {
      block: true,
      reason: `${path} is outside the reviewed repository. The subject is the checkout at the working directory; read there instead.`,
    };
  });
}
