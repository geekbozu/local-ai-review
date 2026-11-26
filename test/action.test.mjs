import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

// action.yml is YAML written by hand, and an unquoted `: ` in a plain scalar has already shipped broken once.
// Parsing it here turns that class of regression into a red test instead of a discovery on the runner.
const action = load(readFileSync(join(import.meta.dirname, "..", "action.yml"), "utf8"));

test("action.yml parses and every step if: is a string", () => {
  assert.equal(action.runs.using, "composite");
  for (const step of action.runs.steps) {
    if (step.if === undefined) continue;
    assert.equal(typeof step.if, "string", `step ${step.name ?? step.uses} has a non-string if`);
  }
});
