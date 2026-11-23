// A stand-in for the client, so the whole review can run without a model or a device.
//
// It emits the event stream the workflow actually reads — turns, tool calls, a reported finding — and writes the finding
// the way the real extension does. That makes the *wiring* testable: everything after the spawn, which is where three
// separate `ReferenceError`s reached a board tonight because no test executed it.
//
// Used with AI_REVIEW_NO_SANDBOX=1 and PI_BIN pointing here.

import { appendFileSync } from "node:fs";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const now = Date.now();

// `silent` as argv[2] reproduces the failure that made the empty-review guard necessary: one assistant turn, token soup
// for a message, no tool call, no finding, stopReason "stop". Everything except the guard reads that as a clean review.
if (process.argv[2] === "silent") {
  emit({ type: "session", version: 3, id: "fake", timestamp: new Date(now).toISOString(), cwd: process.cwd() });
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: '<find<|"|>} <thought' }] },
  });
  emit({ type: "turn_end", toolResults: [] });
  emit({ type: "agent_end", messages: [] });
  process.exit(0);
}

emit({ type: "session", version: 3, id: "fake", timestamp: new Date(now).toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });

for (const turn of [1, 2]) {
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `turn ${turn}` }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    },
  });

  if (turn === 2) {
    const args = {
      path: "changed.txt",
      quote: "two",
      severity: "high",
      confidence: 8,
      body: "A stand-in finding, to prove the pipeline carries one to the summary.",
    };
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "report_finding", args });
    if (process.env.AI_REVIEW_FINDINGS) appendFileSync(process.env.AI_REVIEW_FINDINGS, JSON.stringify(args) + "\n");
    emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "report_finding", isError: false, result: { content: [] } });
  }

  emit({ type: "turn_end", toolResults: [] });
}

emit({ type: "agent_end", messages: [] });
process.exit(0);
