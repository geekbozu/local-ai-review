import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { metrics } from "../tools/eval/metrics.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The real expectations, so the arithmetic is proven against the fixture a sweep will score with.
const expectations = JSON.parse(readFileSync(join(root, "tools", "eval", "fixtures", "vending-busy", "expect.json"), "utf8"));

// One assistant turn, so `answered` reads true and nothing else distracts.
const eventsPath = join(root, "out", "eval-falsepositives-events.jsonl");
writeFileSync(
  eventsPath,
  JSON.stringify({ type: "turn_start" }) + "\n" +
  JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }) + "\n" +
  JSON.stringify({ type: "turn_end" }) + "\n",
);

// The three noise shapes the fixture exists to separate:
// - a nit on the clean file: the false positive the metric is for;
// - fiction on the defect file: path is covered, tokens are not — an extra, not a false positive;
// - the real defect, found: neither an extra nor a false positive.
const findings = [
  {
    path: "src/restock.ts",
    quote: "const space = Math.max(0, capacity - item.onHand);",
    body: "Consider naming this `remainingCapacity` for clarity.",
    severity: "low",
  },
  {
    path: "src/vend.ts",
    quote: "export function vend(slot: string,",
    body: "The rename from dispense is churn; I would have kept the old name.",
    severity: "low",
  },
  {
    path: "src/payouts.ts",
    quote: "export const PAYOUT_FLOOR_CENTS = 500;",
    body: "This constant could live in configuration.",
    severity: "medium",
  },
  {
    path: "src/payouts.ts",
    quote: "const first = payable[0];",
    body: "payable[0] is read with no guard, so an empty batch throws on first.id.",
    severity: "high",
  },
];
const findingsPath = join(root, "out", "eval-falsepositives-findings.jsonl");
writeFileSync(findingsPath, findings.map((f) => JSON.stringify(f)).join("\n") + "\n");

const row = metrics(eventsPath, findingsPath, 10, expectations);

test("a nit on the clean file is a false positive, not thoroughness", () => {
  assert.deepEqual(
    row.falsePositives.map((f) => f.path),
    ["src/restock.ts", "src/vend.ts"],
    "both findings sit on paths no expectation covers",
  );
});

test("fiction on the defect file is an extra, not a false positive", () => {
  // extras stays the superset of everything no expectation covers; falsePositives is its clean-code subset.
  assert.deepEqual(row.extras.map((f) => f.path), ["src/restock.ts", "src/vend.ts", "src/payouts.ts"]);
  assert.equal(row.falsePositives.length, 2, "the covered path is excluded even though no token matched");
});

test("the real defect is found and stays out of both noise buckets", () => {
  assert.deepEqual(row.found, 1);
  assert.deepEqual(row.missing, []);
  assert.equal(row.extras.length, 3, "three unmatched findings in total");
  assert.equal(row.falsePositives.length, 2, "two of them on clean code");
});

test("with no expectations the metric stays out of the row", () => {
  const bare = metrics(eventsPath, findingsPath, 10, []);
  assert.equal(bare.falsePositives, undefined);
});
