import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { watch, resolveExecutable, startKeyProxy } from "../src/review.mjs";

// The line this produces is the only per-run record that survives a rerun — artifacts are replaced by the next
// attempt — so it has to say which finding was found. It said `undefined undefined` twice: first because the
// arguments live on the start event, then because the start/end pair straddled two chunks.
test("a finding's arguments survive the start event arriving in an earlier chunk", () => {
  const seen = [];
  const w = watch({ onFinding: (f) => seen.push(f), onTurn: () => {} });

  const start = JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "abc",
    toolName: "report_finding",
    args: { path: "src/a.ts", severity: "high", quote: "x", body: "It is wrong." },
  });
  const end = JSON.stringify({ type: "tool_execution_end", toolCallId: "abc", toolName: "report_finding", isError: false });

  w(start + "\n");
  w(end + "\n");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].severity, "high");
  assert.equal(seen[0].path, "src/a.ts");
  assert.equal(seen[0].body, "It is wrong.");
  assert.equal(seen[0].findings, 1);
});

test("a failed report_finding is not counted", () => {
  const seen = [];
  const w = watch({ onFinding: (f) => seen.push(f), onTurn: () => {} });
  w(JSON.stringify({ type: "tool_execution_start", toolCallId: "k", toolName: "report_finding", args: { path: "p" } }) + "\n");
  w(JSON.stringify({ type: "tool_execution_end", toolCallId: "k", toolName: "report_finding", isError: true }) + "\n");
  assert.equal(seen.length, 0);
});

// The sandbox sets its own PATH, so a bare "pi" is found by the parent and not by the child. Resolved to an absolute
// path, the same command works in both. Measured on a board as "bwrap: execvp pi: No such file or directory".
test("an executable is resolved against the path it is given", () => {
  const looksAbsolute = resolveExecutable("pi", "/nowhere");
  assert.equal(looksAbsolute, "pi", "nothing on that path, so the name is returned unchanged");

  const found = resolveExecutable(process.execPath.split(/[\/]/).pop(), dirname(process.execPath));
  assert.equal(found, process.execPath, "the first directory carrying an executable wins");
});

// The model host is allowed to hiccup: one failed call gets another turn, and a success resets the count. A run of
// them is an endpoint that is not coming back, and waiting out the budget delays the same answer.
test("a model error is retried, and a run of them fails the run", () => {
  const NL = String.fromCharCode(10);
  const err = (m) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: m } }) + NL;
  const ok = () => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + NL;

  const fatals = [];
  const w = watch({ onFinding: () => {}, onTurn: () => {}, onFatal: (m) => fatals.push(m) });
  w(err("one bad request"));
  assert.equal(fatals.length, 0, "the first failure is a retry, not a verdict");

  w(ok());
  w(err("another"));
  w(ok());
  assert.equal(fatals.length, 0, "a success in between resets the count");

  const dead = [];
  const w2 = watch({ onFinding: () => {}, onTurn: () => {}, onFatal: (m) => dead.push(m) });
  for (let i = 0; i < 3; i += 1) w2(err(`failure ${i}`));
  assert.equal(dead.length, 1, "three in a row is an endpoint that is not coming back");
  assert.match(dead[0], /failure 2/);
});
