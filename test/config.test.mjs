import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, matchesAny, ruleApplies, CONFIG_FILE } from "../src/lib/config.mjs";

const repoWith = (config) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-config-"));
  if (config !== null) {
    writeFileSync(`${dir}/${CONFIG_FILE}`, typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
};

test("no config file means not opted in", () => {
  assert.equal(loadConfig(repoWith(null)), null);
});

test("an empty object is enough to opt in, with defaults", () => {
  const config = loadConfig(repoWith({}));
  assert.ok(config);
  assert.deepEqual(config.rules, []);
  assert.equal(config.severityFloor, "low");
  assert.equal(config.maxTurns, 100);
});

test("enabled: false is an opt-out that keeps the file", () => {
  assert.equal(loadConfig(repoWith({ enabled: false })), null);
});

test("declared values win over defaults", () => {
  const config = loadConfig(repoWith({ rules: ["REVIEW.md"], severityFloor: "high", maxTurns: 40, thinking: "off" }));
  assert.deepEqual(config.rules, ["REVIEW.md"]);
  assert.equal(config.severityFloor, "high");
  assert.equal(config.maxTurns, 40);
  assert.equal(config.thinking, "off");
});

test("bad config fails loudly rather than silently reviewing nothing", () => {
  assert.throws(() => loadConfig(repoWith("{ not json")), /not valid JSON/);
  assert.throws(() => loadConfig(repoWith({ rules: "REVIEW.md" })), /rules must be an array/);
  assert.throws(() => loadConfig(repoWith({ severityFloor: "blocker" })), /severityFloor/);
  assert.throws(() => loadConfig(repoWith({ thinking: "mediumish" })), /thinking/);
  assert.throws(() => loadConfig(repoWith({ maxTurns: 0 })), /maxTurns/);
});

test("globs match the way a rule file expects", () => {
  assert.ok(matchesAny("src/services/scores.ts", ["src/**/*.ts"]));
  assert.ok(matchesAny("src/scores.ts", ["src/**/*.ts"]), "** matches zero directories");
  assert.ok(matchesAny("src/services/scores.ts", ["src/services/*.ts"]));
  assert.ok(!matchesAny("src/services/deep/scores.ts", ["src/services/*.ts"]), "* does not cross a slash");
  assert.ok(matchesAny("Docs/plans/x.md", ["Docs/**"]));
});

test("a literal path matches itself and anything under it", () => {
  assert.ok(matchesAny("AGENTS.md", ["AGENTS.md"]));
  assert.ok(matchesAny(".ai-review/rules/api.md", [".ai-review/rules"]));
  assert.ok(!matchesAny("src/AGENTS.md", ["AGENTS.md"]));
});

test("a rule file with paths frontmatter applies only to matching files", () => {
  const rule = ["---", "description: x", "paths:", '  - "src/**/*.ts"', "---", "", "# Rule", ""].join("\n");
  assert.ok(ruleApplies(rule, "src/services/scores.ts"));
  assert.ok(!ruleApplies(rule, "Docs/plans/thing.md"));
});

test("a rule file without frontmatter applies to everything", () => {
  assert.ok(ruleApplies("# Review rules\n\nBe kind.\n", "src/anything.ts"));
});

test("frontmatter without paths applies to everything", () => {
  const rule = ["---", "description: always", "---", "", "# Rule", ""].join("\n");
  assert.ok(ruleApplies(rule, "src/anything.ts"));
});

test("CRLF frontmatter parses", () => {
  const rule = ["---", "paths:", "  - src/**/*.ts", "---", "", "# Rule"].join("\r\n");
  assert.ok(ruleApplies(rule, "src/a.ts"));
  assert.ok(!ruleApplies(rule, "Docs/a.md"));
});
