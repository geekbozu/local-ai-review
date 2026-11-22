import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "../src/review.mjs";

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
