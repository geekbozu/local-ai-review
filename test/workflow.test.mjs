import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The workflow's wiring, exercised for real: config, diff, rules, prompt, frozen policy, agent directory — everything
// up to the model call. Written after a refactor dropped an import that no test touched, so a 20-second review failed
// with `ReferenceError: mkdirSync is not defined` on a board instead of here.
const tempRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "ai-review-dry-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, ".ai-review.json"), JSON.stringify({ rules: [], model: "test/model" }));
  writeFileSync(join(repo, "a.txt"), "one" + String.fromCharCode(10));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
  writeFileSync(join(repo, "changed.txt"), "two" + String.fromCharCode(10));
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
  return repo;
};

const envFor = (repo, extra = {}) => ({
  ...process.env,
  AI_REVIEW_BASE_URL: "http://127.0.0.1:9/v1",
  AI_REVIEW_API_KEY: "test",
  PI_CODING_AGENT_DIR: join(repo, ".pi-cache"),
  RUNNER_TEMP: repo,
  GITHUB_WORKSPACE: repo,
  BASE_REF: "origin/main",
  ...extra,
});

// The half the dry run cannot reach: the spawn, the event stream, the findings file, the report. Three import bugs
// reached a board tonight because nothing executed this path.
test("a whole review runs against a stand-in client", () => {
  const repo = tempRepo();
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "review.mjs")], {
    cwd: repo,
    encoding: "utf8",
    env: envFor(repo, {
      AI_REVIEW_NO_SANDBOX: "1",
      PI_BIN: JSON.stringify([process.execPath, join(import.meta.dirname, "fixtures", "fake-pi.mjs")]),
      FINDINGS_FILE: join(repo, "findings.jsonl"),
      EVENTS_FILE: join(repo, "events.jsonl"),
      NOTES_FILE: join(repo, "notes.txt"),
      PROMPT_FILE: join(repo, "prompt.txt"),
      TRANSCRIPT_FILE: join(repo, "transcript.md"),
      PATH: process.env.PATH,
    }),
  });

  const result = JSON.parse(out.trim().split(String.fromCharCode(10)).pop());
  assert.equal(result.findings, 1, "the finding the client reported reached the summary");
  assert.equal(result.touched, 1, "the diff was read");
  assert.ok(existsSync(join(repo, "transcript.md")), "a transcript was rendered");
});

test("the review workflow wires up end to end without a model", () => {
  const repo = mkdtempSync(join(tmpdir(), "ai-review-dry-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, ".ai-review.json"), JSON.stringify({ rules: [], model: "test/model" }));
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
  writeFileSync(join(repo, "b.txt"), "two\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

  const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "review.mjs")], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      AI_REVIEW_DRY: "1",
      AI_REVIEW_BASE_URL: "http://127.0.0.1:9/v1",
      AI_REVIEW_API_KEY: "test",
      PI_CODING_AGENT_DIR: join(repo, ".pi-cache"),
      RUNNER_TEMP: repo,
      GITHUB_WORKSPACE: repo,
      BASE_REF: "origin/main",
      PATH: process.env.PATH,
    },
  });

  const result = JSON.parse(out.trim().split("\n").pop());
  assert.equal(result.dryRun, true, "the workflow reached the point before the model call");
  assert.ok(result.prompt > 0, "a prompt was assembled");
  assert.ok(result.files >= 1, "the diff was read");
  assert.ok(existsSync(result.frozen), "the frozen policy was written");
  assert.ok(existsSync(join(result.frozen, "meta.json")), "with the floors the poster reads");
});
