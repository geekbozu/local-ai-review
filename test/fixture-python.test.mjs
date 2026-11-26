import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture, fixtureDir } from "../tools/eval/fixture.mjs";
import { metrics } from "../tools/eval/metrics.mjs";

// The harness's own git init/commit path against a Python fixture: if this passes, `--fixture vending-python` builds
// the same two-commit history every other fixture is scored from, and the scoring code needs no language branch.
const { work, expect } = buildFixture("vending-python");
const git = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
const numstat = git("diff", "--numstat", "refs/remotes/origin/main").trim().split("\n").map((l) => l.split("\t"));
const changed = numstat.map((n) => n[2]).sort();
const head = (path) => readFileSync(join(fixtureDir("vending-python"), "head", path), "utf8");

test("base and head commit cleanly, and the diff is the Python files", () => {
  assert.equal(git("log", "--oneline").trim().split("\n").length, 2);
  assert.equal(git("status", "--porcelain").trim(), "");
  assert.deepEqual(changed, [
    "README.md",
    "vending/labels.py",
    "vending/ledger.py",
    "vending/machine.py",
    "vending/payouts.py",
    "vending/restock.py",
  ]);
});

test("every expectation names a path that is both in the diff and in head/", () => {
  for (const want of expect) {
    assert.ok(changed.includes(want.path), `${want.id} expects ${want.path}, which is not in the diff`);
    assert.ok(existsSync(join(fixtureDir("vending-python"), "head", want.path)), `${want.id}: head/${want.path} is missing`);
  }
});

test("each expectation has a token present in its head file", () => {
  for (const want of expect) {
    const text = head(want.path).toLowerCase();
    assert.ok(
      want.any.some((t) => text.includes(t.toLowerCase())),
      `${want.id}: none of its tokens appear in ${want.path}`,
    );
  }
});

test("the fixture is not all defect: two changed files carry no expectation", () => {
  const total = numstat.reduce((sum, n) => sum + Number(n[0]) + Number(n[1]), 0);
  assert.ok(total >= 120, `changed lines: ${total}`);
  const covered = new Set(expect.map((w) => w.path));
  assert.deepEqual(changed.filter((path) => !covered.has(path)), ["README.md", "vending/machine.py"]);
});

// A clean checkout has no `out/`, and it is the live sweep directory besides: the test's files go to a temp dir
// that is removed afterwards.
const scratch = mkdtempSync(join(tmpdir(), "eval-python-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// One assistant turn, so `answered` reads true and nothing else distracts.
const eventsPath = join(scratch, "events.jsonl");
writeFileSync(
  eventsPath,
  JSON.stringify({ type: "turn_start" }) + "\n" +
  JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }) + "\n" +
  JSON.stringify({ type: "turn_end" }) + "\n",
);

// Five findings the defects deserve, and three that must not score:
// - a nit on the clean file: the false positive;
// - a nit on a defect file: an extra, not a false positive;
// - the ledger's comment quoted instead of its code: a code defect is not found by quoting the prose about it, and in
//   Python the comment marker is `#`, which the scoring's comment rule has to recognise.
const findings = [
  {
    path: "vending/payouts.py",
    quote: "    except:\n        pass",
    body: "A bare except swallows the post failure and falls through to None, so settle_batch reads receipt_id off None and a failed transfer leaves a hole in the ledger with no traceback anywhere.",
    severity: "high",
  },
  {
    path: "vending/restock.py",
    quote: "def collect_refills(lines, refills=[]):",
    body: "The mutable default argument is one list created at import: the second call returns the previous call's refills on top of its own.",
    severity: "high",
  },
  {
    path: "vending/labels.py",
    quote: 'subprocess.run(f"lp -d {printer} {label}", shell=True, check=True)',
    body: "product_id comes from the supplier feed and lands in an f-string run through shell=True, so a product id containing $(...) is executed on the print host.",
    severity: "high",
  },
  {
    path: "vending/ledger.py",
    quote: '    return sum(row.get("pricing", {}).get("retail", {}).get("unit_cents") for row in machine_rows)',
    body: "Three chained .get() calls return None for a machine with no pricing block, and sum() raises TypeError instead of reporting zero revenue.",
    severity: "high",
  },
  {
    path: "vending/labels.py",
    quote: "        asyncio.create_task(fetch(machine_id))",
    body: "The task is never awaited and its handle is dropped, so a failed fetch raises nowhere and the coroutine can be collected before it runs.",
    severity: "medium",
  },
  {
    path: "vending/restock.py",
    quote: '    return sorted(lines, key=lambda line: line["slot"])',
    body: "Sorting by slot as a string puts 10 before 2, so the prefix claim does not hold.",
    severity: "low",
  },
  {
    path: "vending/machine.py",
    quote: "def sell_many(slots, inserted_cents, price_per_slot_cents):",
    body: "The rename from vend to sell is churn; I would have kept vend.",
    severity: "low",
  },
  {
    path: "vending/ledger.py",
    quote: '    # One revenue figure per machine per day, from the portal\'s stock export. A\n    # machine that has never been priced has no pricing block in the export.',
    body: "The pricing block is optional, so this .get() chain can return None.",
    severity: "low",
  },
];
const findingsPath = join(scratch, "findings.jsonl");
writeFileSync(findingsPath, findings.map((f) => JSON.stringify(f)).join("\n") + "\n");

const row = metrics(eventsPath, findingsPath, 10, expect);

test("the five planted defects are found, none missing", () => {
  assert.equal(row.found, 5);
  assert.deepEqual(row.missing, []);
});

test("a finding that answers no expectation is an extra, and only clean code is a false positive", () => {
  assert.deepEqual(
    row.extras.map((f) => f.quote.trim().slice(0, 20)),
    findings.slice(5).map((f) => f.quote.trim().slice(0, 20)),
  );
  assert.deepEqual(row.falsePositives.map((f) => f.path), ["vending/machine.py"]);
  assert.equal(row.restated, 0, "no expectation is answered twice");
});

test("quoting the Python comment about the defect does not count as finding it", () => {
  // The rule is the scoring's, not the model's: `#` is a comment in Python the way `//` is in TypeScript.
  assert.equal(row.extras.filter((f) => f.quote.trim().startsWith("#")).length, 1, "the comment-only quote is an extra");
  assert.equal(row.found, 5, "found stays at five: the comment quote answered no expectation");
  // Same findings, rule off: the quote would have counted, so the rule is what kept it out.
  const loose = metrics(eventsPath, findingsPath, 10, expect.map((w) => ({ ...w, codeDefect: false })));
  assert.equal(loose.restated, 1, "rule off, the comment quote claims the same expectation: a restatement, not a find");
  assert.equal(loose.extras.length, 2, "and it stops being an extra");
});

test("an expectation naming a path the diff does not have is silently missing", () => {
  // buildFixture copies whatever expect.json says and validates nothing, and metrics can only match paths that appear
  // in findings.jsonl. A typo in a path costs a defect from every run without failing anything.
  const ghost = [...expect, { id: "ghost-path", path: "vending/ghost.py", severity: "high", codeDefect: true, any: ["anything"] }];
  const spoiled = metrics(eventsPath, findingsPath, 10, ghost);
  assert.equal(spoiled.found, 5);
  assert.deepEqual(spoiled.missing, ["ghost-path"]);
});
