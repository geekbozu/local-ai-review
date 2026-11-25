import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixture } from "../tools/eval/fixture.mjs";

// The harness's own git init/commit path, run against the fixture: if this passes, `--fixture vending-busy` builds the
// same two-commit history every other fixture is scored from.
const { work, expect } = buildFixture("vending-busy");
const git = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
const numstat = git("diff", "--numstat", "refs/remotes/origin/main").trim().split("\n").map((l) => l.split("\t"));

test("the diff is the three feature files and nothing else", () => {
  assert.deepEqual(
    numstat.map((n) => n[2]).sort(),
    ["README.md", "src/payouts.ts", "src/restock.ts", "src/vend.ts"],
  );
});

test("the diff is near real-life size: 150-250 changed lines", () => {
  const changed = numstat.reduce((sum, n) => sum + Number(n[0]) + Number(n[1]), 0);
  assert.ok(changed >= 150 && changed <= 250, `changed lines: ${changed}`);
});

test("every expectation names a file the diff actually touches", () => {
  for (const want of expect) {
    assert.ok(numstat.some((n) => n[2] === want.path), `${want.id} expects ${want.path}, which is not in the diff`);
  }
});

test("each expectation has at least one token present in the head file, and the defect line is there", () => {
  for (const want of expect) {
    const head = readFileSync(join(work, want.path), "utf8").toLowerCase();
    assert.ok(
      want.any.some((t) => head.includes(t.toLowerCase())),
      `${want.id}: none of its tokens appear in ${want.path}`,
    );
  }
  assert.ok(readFileSync(join(work, "src/payouts.ts"), "utf8").includes("const first = payable[0];"));
});

test("the clean files carry no expectation: findings there are false positives by construction", () => {
  const covered = new Set(expect.map((w) => w.path));
  for (const path of ["src/restock.ts", "src/vend.ts"]) {
    assert.ok(!covered.has(path), `${path} should have no expectation`);
    assert.ok(numstat.some((n) => n[2] === path), `${path} is part of the diff`);
  }
});
