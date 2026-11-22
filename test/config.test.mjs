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

test("the default risk hints are domain words, not a repo's layout", async () => {
  const { riskHints } = await import("../src/lib/triage.mjs");

  const risky = riskHints(["db/migrations/0001.sql", "auth/session.ts", "billing/refund.ts", "README.md"]);
  assert.deepEqual(risky.highRisk, ["db/migrations/0001.sql", "auth/session.ts", "billing/refund.ts"]);

  // a layout the action has never seen must not be guessed at: this belongs to the repository's config
  assert.deepEqual(riskHints(["src/services/events.ts", "supabase/functions/send/index.ts"]).highRisk, []);
});

test("a repository can add its own risk patterns", async () => {
  const { riskHints } = await import("../src/lib/triage.mjs");
  const files = ["src/services/events.ts", "docs/notes.md"];
  const hints = riskHints(files, ["^src/services/", "\.pi/rules/"]);
  assert.deepEqual(hints.highRisk, ["src/services/events.ts"]);
});

test("a risk hint is a start-here, never a skim", async () => {
  const { riskHints } = await import("../src/lib/triage.mjs");
  const { thoroughBrief } = await import("../src/lib/prompt.mjs");
  const brief = thoroughBrief(riskHints([".pi/rules/frontend.md"], ["^\.pi/rules/"]));
  assert.match(brief, /## Risk/);
  assert.match(brief, /a one-line change carries as/);
  assert.doesNotMatch(brief, /skim/i, "nothing tells the agent to skim");
});

test("no high-risk areas means no brief at all", async () => {
  const { riskHints } = await import("../src/lib/triage.mjs");
  const { thoroughBrief } = await import("../src/lib/prompt.mjs");
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

test("the transcript keeps the whole reasoning and drops the framing", async () => {
  const { renderTranscript } = await import("../src/lib/transcript.mjs");
  const reasoning = "The service filters by judge_id. " + "Then it checks the caller. ".repeat(80);
  const events = [
    { type: "turn_start", timestamp: 1000 },
    {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 30000,
        stopReason: "toolUse",
        usage: { output: 42, cacheRead: 500 },
        content: [
          { type: "thinking", thinking: reasoning },
          { type: "toolCall", name: "read", arguments: { path: "src/services/scores.ts" } },
          { type: "toolCall", name: "report_finding", arguments: { path: "a.ts", severity: "high", body: "boom" } },
        ],
      },
    },
    { type: "tool_execution_end", durationMs: 12, isError: false, result: { content: [{ type: "text", text: "file body" }] } },
    { type: "turn_end" },
  ].map((e) => JSON.stringify(e));

  const md = renderTranscript(events);
  assert.match(md, /--- turn 1 · 29s · 42 out · 500 cached · toolUse/);
  assert.ok(md.includes(reasoning.trim()), "thinking is kept whole, not clipped");
  assert.match(md, /\[thinking\]/);
  assert.match(md, /\[tool\] read path=src\/services\/scores\.ts/);
  assert.match(md, /\[tool\] report_finding/, "findings are visible as tool calls");
  assert.match(md, /\[result\] file body/);
  assert.match(md, /1 turn\(s\) · 42 tokens out · 500 cached · 1 finding\(s\)/);
  assert.ok(!md.includes('"type"'), "no JSON envelopes leak into the transcript");
});

test("a long tool result is clipped and says so", async () => {
  const { renderTranscript } = await import("../src/lib/transcript.mjs");
  const md = renderTranscript([
    JSON.stringify({
      type: "tool_execution_end",
      durationMs: 2,
      result: { content: [{ type: "text", text: "x".repeat(5000) }] },
    }),
  ]);
  assert.match(md, /4200 chars/);
});

test("a torn last line does not lose the transcript", async () => {
  const { renderTranscript } = await import("../src/lib/transcript.mjs");
  const lines = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "kept" }] } }),
    '{"type":"message_end","message":{"role":"assis',
  ];
  assert.match(renderTranscript(lines), /kept/);
});

test("a repository can supply instructions, and they land in the prompt", async () => {
  const { loadConfig } = await import("../src/lib/config.mjs");
  const { buildPrompt } = await import("../src/lib/prompt.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "ai-review-instr-"));
  writeFileSync(join(dir, ".ai-review.json"), JSON.stringify({ instructions: ["Do not review the vendored action."] }));
  const config = loadConfig(dir);
  assert.deepEqual(config.instructions, ["Do not review the vendored action."]);

  const prompt = buildPrompt({ rules: "", baseRef: "origin/main", touched: ["a.ts"], instructions: config.instructions });
  assert.match(prompt, /## Repository/);
  assert.match(prompt, /Do not review the vendored action\./);
});

test("instructions must be non-empty strings", async () => {
  const { loadConfig } = await import("../src/lib/config.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ai-review-instr-bad-"));
  writeFileSync(join(dir, ".ai-review.json"), JSON.stringify({ instructions: ["ok", "  "] }));
  assert.throws(() => loadConfig(dir), /instructions must be an array of non-empty strings/);
});

test("the generic prompt names no runner path", async () => {
  const { buildPrompt } = await import("../src/lib/prompt.mjs");
  const prompt = buildPrompt({ rules: "", baseRef: "origin/main", touched: ["a.ts"] });
  assert.doesNotMatch(prompt, /_work\/_actions/, "runner layout belongs to the repository's config, not here");
  assert.match(prompt, /git diff -U10 origin\/main\.\.\.HEAD/, "the diff is a command, not a payload");
});

test("model settings can be tuned per repo, and the rest of the defaults survive", async () => {
  const { loadConfig } = await import("../src/lib/config.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "ai-review-model-"));
  writeFileSync(
    join(dir, ".ai-review.json"),
    JSON.stringify({ modelSettings: { temperature: 0.2, contextWindow: 131072, reasoning: false, thinkingFormat: "none" }, resultChars: 20000, timeBudgetMinutes: 15 }),
  );

  const config = loadConfig(dir);
  assert.equal(config.modelSettings.temperature, 0.2);
  assert.equal(config.modelSettings.contextWindow, 131072);
  assert.equal(config.modelSettings.reasoning, false);
  assert.equal(config.modelSettings.thinkingFormat, "none");
  assert.equal(config.modelSettings.topK, 20, "an unset field keeps its default");
  assert.equal(config.modelSettings.maxTokens, 65536);
  assert.equal(config.resultChars, 20000);
  assert.equal(config.timeBudgetMinutes, 15);
});

test("a bad model setting fails the run rather than shipping a silent default", async () => {
  const { loadConfig } = await import("../src/lib/config.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const write = (v) => {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-bad-"));
    writeFileSync(join(dir, ".ai-review.json"), JSON.stringify(v));
    return dir;
  };
  assert.throws(() => loadConfig(write({ modelSettings: { temperature: -1 } })), /temperature must be a non-negative number/);
  assert.throws(() => loadConfig(write({ modelSettings: { thinkingFormat: "wat" } })), /thinkingFormat must be/);
  assert.throws(() => loadConfig(write({ modelSettings: { reasoning: "yes" } })), /reasoning must be true or false/);
  assert.throws(() => loadConfig(write({ resultChars: 1.5 })), /resultChars must be a non-negative integer/);
});
