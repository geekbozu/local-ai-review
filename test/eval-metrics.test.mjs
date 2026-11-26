import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metrics } from "../tools/eval/metrics.mjs";

// The shapes the client actually emits (verified across saved runs): `message_update` carries top-level `usage`,
// `message_end` carries `message.usage`, and the following `turn_end` repeats the `message_end` record verbatim.
// The metered total is the sum across turns (600, not the largest turn's 300): taking max undercounts by the turn
// count, which once made a device look four times slower than it is.
const events = [];
for (const [turn, output] of [
  [1, 100],
  [2, 200],
  [3, 300],
]) {
  events.push({ type: "turn_start" });
  events.push({ type: "message_start", message: { role: "assistant", content: [] } });
  for (let delta = 0; delta < 3; delta += 1) {
    events.push({ type: "message_update", usage: { input: 500, output, cacheRead: 900, cacheWrite: 0 } });
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
  events.push({
    type: "turn_end",
    message: { role: "assistant", usage: { input: 500, output, cacheRead: 900, cacheWrite: 0 } },
  });
}

const dir = mkdtempSync(join(tmpdir(), "ai-review-eval-metrics-"));
const eventsPath = join(dir, "events.jsonl");
writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const row = metrics(eventsPath, join(dir, "absent.jsonl"), 60, []);

test("outputTokens sums usage.output across turns, not the largest turn", () => {
  assert.equal(row.turns, 3, "every turn parsed");
  assert.equal(row.outputTokens, 600, "sum of 100+200+300; the max alone would read 300");
});

test("usageRecords counts the per-turn records, so zero usage is never silent", () => {
  // Three turns, one record each — the message_end/turn_end duplicate collapsed. If the reader stops seeing usage at
  // all this reads 0, which distinguishes a broken reader/fixture from a model that genuinely emitted 0 tokens.
  assert.equal(row.usageRecords, 3, "one distinct record per turn; 0 means no usage was ever seen");
});

test("tokPerSec is the aggregate rate to one decimal", () => {
  assert.equal(row.tokPerSec, 10, "600 tokens in 60 seconds");
});
