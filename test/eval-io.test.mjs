// The agent's cwd is the work tree, so anything the harness writes inside it is something the model can read. A run read
// its predecessor's events.jsonl — which carries the previous review of the same diff — and concluded the change was
// "already reviewed by someone else (or I am in a simulation)" before reporting nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the eval writes its own files beside the work tree, never inside it", () => {
  const source = readFileSync(new URL("../tools/eval.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\/work\/\.eval/, "no harness file may live under /work");
  assert.match(source, /"-e", "EVENTS_FILE=\/io\/events\.jsonl"/, "events go to the io mount");
  assert.match(source, /RUNNER_TEMP=\/io"/, "the agent's own directory is outside the tree it reviews");
  assert.match(source, /`\$\{host\(io\)\}:\/io`/, "the io directory is mounted");
});
