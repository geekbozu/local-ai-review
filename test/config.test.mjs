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
  assert.equal(config.maxTurns, 60);
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

test("the endpoint base always ends in /v1", async () => {
  const { normaliseBaseUrl } = await import("../src/lib/url.mjs");
  assert.equal(normaliseBaseUrl("http://box:8080"), "http://box:8080/v1");
  assert.equal(normaliseBaseUrl("http://box:8080/"), "http://box:8080/v1");
  assert.equal(normaliseBaseUrl("http://box:8080/v1"), "http://box:8080/v1");
  assert.equal(normaliseBaseUrl("http://box:8080/v1/"), "http://box:8080/v1");
  assert.equal(normaliseBaseUrl("  http://box:8080  "), "http://box:8080/v1");
  assert.equal(normaliseBaseUrl(""), "");
  assert.equal(normaliseBaseUrl(undefined), "");
});

test("risk hints name the dangerous areas and nothing else", async () => {
  const { riskHints } = await import("../src/lib/triage.mjs");

  const rls = riskHints(["supabase/migrations/0001_x.sql", "src/services/events.ts", "README.md"]);
  assert.deepEqual(rls.highRisk, ["supabase/migrations/0001_x.sql", "src/services/events.ts"], "docs are not a risk area");

  assert.deepEqual(riskHints(["README.md", "docs/notes.md"]).highRisk, []);
});

test("a one-line change to a rules file is a high-risk area, not a skim", async () => {
  const { riskHints, thoroughBrief } = await import("../src/lib/triage.mjs");
  const hints = riskHints([".pi/rules/frontend.md"]);
  assert.deepEqual(hints.highRisk, [".pi/rules/frontend.md"]);

  const brief = thoroughBrief(hints);
  assert.match(brief, /Where risk concentrates/);
  assert.match(brief, /\.pi\/rules\/frontend\.md/);
  assert.match(brief, /a one-line change carries as/);
  assert.doesNotMatch(brief, /skim/i, "nothing tells the agent to skim");
});

test("no high-risk areas means no brief at all", async () => {
  const { riskHints, thoroughBrief } = await import("../src/lib/triage.mjs");
  assert.equal(thoroughBrief(riskHints(["README.md"])), "");
});

test("the trace is on disk before the process ends", async () => {
  const { openTrace } = await import("../src/lib/trace.mjs");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const file = join(mkdtempSync(join(tmpdir(), "trace-")), "events.jsonl");
  const trace = openTrace(file);

  trace.write(Buffer.from('{"type":"turn_end","turn":1}\n'));
  await new Promise((r) => setTimeout(r, 20));
  // read before close on purpose: a killed run gets the chunks written before the kill, not the ones after
  assert.match(readFileSync(file, "utf8"), /turn_end/);

  trace.write(Buffer.from('{"type":"turn_end","turn":2}\n'));
  await trace.close();
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("the transcript keeps the thinking, the tools and what came back", async () => {
  const { renderTranscript } = await import("../src/lib/transcript.mjs");
  const events = [
    { type: "session", id: "s1", cwd: "/repo" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1000,
        stopReason: "toolUse",
        usage: { output: 42, cacheRead: 500 },
        content: [
          { type: "thinking", thinking: "The service filters by judge_id, which is not event-scoped." },
          { type: "toolCall", name: "read", arguments: { path: "src/services/scores.ts" } }, // the shape pi actually emits
        ],
      },
    },
    { type: "tool_execution_end", durationMs: 12, isError: false, result: { content: [{ type: "text", text: "file body" }] } },
    { type: "turn_end" },
    {
      type: "message_end",
      message: { role: "assistant", timestamp: 60000, stopReason: "stop", usage: { output: 8 }, content: [{ type: "text", text: "Nothing else to report." }] },
    },
    { type: "turn_end" },
  ].map((e) => JSON.stringify(e));

  const md = renderTranscript(events);
  assert.match(md, /### Turn 1/);
  assert.match(md, /event-scoped/, "thinking survives");
  assert.match(md, /\*\*→ read\*\*/, "the tool call is shown with its argument");
  assert.match(md, /path=src\/services\/scores\.ts/);
  assert.match(md, /file body/, "the tool result is shown");
  assert.match(md, /cached/, "usage is shown");
  assert.match(md, /Nothing else to report\./);
  assert.match(md, /2 turn\(s\), 59s of model time/);
});

test("a torn last line does not lose the transcript", async () => {
  const { renderTranscript } = await import("../src/lib/transcript.mjs");
  const lines = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "kept" }] } }),
    '{"type":"message_end","message":{"role":"assis',
  ];
  assert.match(renderTranscript(lines), /kept/);
});
