import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metrics } from "../tools/eval/metrics.mjs";

// Three turns writing 100/200/300 output tokens, each usage record repeated across `message_update` deltas the way the
// real stream repeats it, and once more at `message_end`. The metered total is the sum (600), not the largest turn
// (300): taking max undercounts by the turn count, which once made a device look four times slower than it is.
const events = [];
for (const [turn, output] of [
  [1, 100],
  [2, 200],
  [3, 300],
]) {
  events.push({ type: "turn_start" });
  events.push({ type: "message_start", message: { role: "assistant", content: [] } });
  for (let delta = 0; delta < 3; delta += 1) {
    events.push({
      type: "message_update",
      message: { role: "assistant", usage: { input: 500, output, cacheRead: 900, cacheWrite: 0 } },
    });
  }
  events.push({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: { input: 500, output, cacheRead: 900, cacheWrite: 0 },
      content: [{ type: "text", text: `turn ${turn}` }],
    },
  });
  events.push({ type: "turn_end" });
}

const dir = mkdtempSync(join(tmpdir(), "ai-review-eval-metrics-"));
const eventsPath = join(dir, "events.jsonl");
writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const row = metrics(eventsPath, join(dir, "absent.jsonl"), 60, []);

test("outputTokens sums usage.output across turns, not the largest turn", () => {
  assert.equal(row.turns, 3, "every turn parsed");
  assert.equal(row.outputTokens, 600, "sum of 100+200+300; the max alone would read 300");
});

test("tokPerSec is the aggregate rate to one decimal", () => {
  assert.equal(row.tokPerSec, 10, "600 tokens in 60 seconds");
});
