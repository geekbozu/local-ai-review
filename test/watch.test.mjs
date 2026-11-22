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

// An endpoint that is not usable fails on the first turn; nothing later can succeed, and the run would otherwise sit out
// its whole budget. A failure mid-review is a bad request, not a dead endpoint.
test("a failed model call is fatal before the first turn completes, and not after", () => {
  const fatals = [];
  const w = watch({ onFinding: () => {}, onTurn: () => {}, onFatal: (m) => fatals.push(m) });
  w(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: '404: not loaded' } }) + "\n");
  assert.deepEqual(fatals, ["404: not loaded"]);

  const quiet = [];
  const w2 = watch({ onFinding: () => {}, onTurn: () => {}, onFatal: (m) => quiet.push(m) });
  w2(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n");
  assert.equal(quiet.length, 0, "a normal turn is not fatal");
});

// The review finished, printed its summary and hung until cancelled: an http server keeps the event loop alive, which
// is why the proxy is unref'd. It still has to serve, and to refuse anything but the per-run token.
test("the key proxy serves only the per-run token", async () => {
  const proxy = await startKeyProxy({ target: "http://127.0.0.1:9/v1", realKey: "unused" });
  assert.equal(proxy.server.listening, true);

  const denied = await fetch(`${proxy.baseUrl}/v1/models`);
  assert.equal(denied.status, 401, "no token, no forwards");

  const allowed = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${proxy.token}` } });
  assert.equal(allowed.status, 502, "the token is accepted and the dead upstream is reported as one");

  proxy.server.close();
});
