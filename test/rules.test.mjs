import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { restoreRulesFromBase } from "../src/lib/rules.mjs";

// A throwaway repository: base branch with one rule, then a branch that edits it and plants another.
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "ai-review-rules-"));
  const run = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  return { repo, run };
}

const write = (repo, path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

test("a rule the PR rewrote is restored, and one the PR added is removed", () => {
  const { repo, run } = fixture();
  write(repo, ".pi/rules/base.md", "the base rule applies here");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("checkout", "-qb", "pr");

  write(repo, ".pi/rules/base.md", "a rule the PR rewrote");
  write(repo, ".pi/rules/planted.md", "a rule the PR added");
  run("add", "-A");
  run("commit", "-qm", "pr");

  const result = restoreRulesFromBase(repo, "main", { rules: [".pi/rules/**"] });

  assert.deepEqual(result.restored, [".pi/rules/base.md"]);
  assert.deepEqual(result.removed, [".pi/rules/planted.md"]);
  assert.match(readFileSync(join(repo, ".pi/rules/base.md"), "utf8"), /the base rule applies here/);
  assert.equal(existsSync(join(repo, ".pi/rules/planted.md")), false, "a rule the PR added must not load");
});

test("a rule the PR added in a new directory is removed too", () => {
  const { repo, run } = fixture();
  write(repo, "AGENTS.md", "base agent guide");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("checkout", "-qb", "pr");
  write(repo, ".pi/rules/nested/new.md", "planted deep");
  run("add", "-A");
  run("commit", "-qm", "pr");

  const result = restoreRulesFromBase(repo, "main", { rules: [".pi/rules/**"] });
  assert.equal(result.restored.length, 0);
  assert.deepEqual(result.removed, [".pi/rules/nested/new.md"]);
});

test("nothing configured means nothing touched", () => {
  const { repo } = fixture();
  assert.deepEqual(restoreRulesFromBase(repo, "main", { rules: [] }), { restored: [], removed: [] });
});

test("the repository directory itself is inside the repository", async () => {
  const { insideRepo } = await import("../src/lib/path.mjs");
  const cwd = "/work/repo/repo";
  assert.equal(insideRepo(cwd, "/work/repo/repo"), true, "the cwd has no trailing separator to match");
  assert.equal(insideRepo(cwd, "/work/repo/repo/src/a.ts"), true);
  assert.equal(insideRepo(cwd, "./src/a.ts"), true);
  assert.equal(insideRepo(cwd, "/work/repo/repo2/x"), false);
  assert.equal(insideRepo(cwd, "/work/repo/repo/../other"), false);
  assert.equal(insideRepo(cwd, "/work/_actions/x"), false);
  assert.equal(insideRepo(cwd, "/etc/passwd"), false);
});

test("an absolute read path counts as the file the diff names", async () => {
  const { openedFiles, uncovered } = await import("../src/lib/coverage.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "ai-review-cov-"));
  const file = join(dir, "events.jsonl");
  const lines = [
    { type: "tool_execution_start", toolName: "read", args: { path: "/work/repo/repo/src/a.ts" } },
    { type: "tool_execution_start", toolName: "read", args: { path: "src/b.ts" } },
    { type: "tool_execution_start", toolName: "bash", args: { command: "cat src/c.ts" } },
    { type: "turn_end" },
  ].map((e) => JSON.stringify(e));
  writeFileSync(file, lines.join("\n"));

  const { opened, turns } = openedFiles(file, { root: "/work/repo/repo" });
  assert.equal(turns, 1);
  assert.deepEqual([...opened].sort(), ["src/a.ts", "src/b.ts"], "an absolute path resolves against the root");
  assert.deepEqual(uncovered(["src/a.ts", "src/c.ts"], opened), ["src/c.ts"], "bash is not a read, and says so");
});
