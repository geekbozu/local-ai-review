import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/review.mjs";

// The workflow's wiring, exercised for real. Written after a refactor dropped imports that no test touched: a
// twenty-second review failed on a board with `ReferenceError: mkdirSync is not defined` while 58 tests passed, because
// nothing executed `run()`.
//
// Everything here goes through `run(options)`. Env is used for *paths* only — there is deliberately no environment
// variable that can switch the sandbox off or swap the client, because such a flag is a flag that eventually gets set.

const NL = String.fromCharCode(10);

const tempRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "ai-review-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, ".ai-review.json"), JSON.stringify({ rules: [], model: "test/model" }));
  writeFileSync(join(repo, "a.txt"), "one" + NL);
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, "changed.txt"), "two" + NL);
  git("add", "-A");
  git("commit", "-qm", "change");
  return repo;
};

// Paths come from the environment in production; here they point at a temporary repository, and are restored afterwards.
const withRepo = async (repo, fn) => {
  const keys = [
    "GITHUB_WORKSPACE",
    "RUNNER_TEMP",
    "BASE_REF",
    "FINDINGS_FILE",
    "EVENTS_FILE",
    "NOTES_FILE",
    "PROMPT_FILE",
    "TRANSCRIPT_FILE",
    "PI_CODING_AGENT_DIR",
    "AI_REVIEW_BASE_URL",
    "AI_REVIEW_API_KEY",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const cwd = process.cwd();
  Object.assign(process.env, {
    GITHUB_WORKSPACE: repo,
    RUNNER_TEMP: repo,
    BASE_REF: "origin/main",
    FINDINGS_FILE: join(repo, "findings.jsonl"),
    EVENTS_FILE: join(repo, "events.jsonl"),
    NOTES_FILE: join(repo, "notes.txt"),
    PROMPT_FILE: join(repo, "prompt.txt"),
    TRANSCRIPT_FILE: join(repo, "transcript.md"),
    PI_CODING_AGENT_DIR: join(repo, ".pi-cache"),
    AI_REVIEW_BASE_URL: "http://127.0.0.1:9/v1",
    AI_REVIEW_API_KEY: "test",
  });
  process.chdir(repo);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("the review workflow wires up end to end", async () => {
  const repo = tempRepo();
  const result = await withRepo(repo, () => run({ dry: true }));

  assert.equal(result.dryRun, true, "the workflow reached the point before the model call");
  assert.ok(existsSync(join(repo, "ai-review-frozen", "meta.json")), "the frozen policy the poster reads was written");
});

// The half a dry run cannot reach: the spawn, the event stream, the findings file, the report. Three import bugs and a
// dangling reference reached a board tonight because nothing executed this path.
test("a whole review runs against a stand-in client", async () => {
  const repo = tempRepo();
  const result = await withRepo(repo, () =>
    run({
      sandbox: false,
      clientArgv: [process.execPath, join(import.meta.dirname, "fixtures", "fake-pi.mjs")],
    }),
  );

  assert.equal(result.findings, 1, "the finding the client reported reached the summary");
  assert.equal(result.touched, 1, "the diff was read");
  assert.ok(existsSync(join(repo, "transcript.md")), "a transcript was rendered");
});

// Measured on gemma: five runs answered with token soup, made no tool call and filed nothing, and passed as a clean
// review because stopReason was "stop" and nothing errored.
test("a model that reads nothing and reports nothing fails the run", async () => {
  const repo = tempRepo();
  await assert.rejects(
    () =>
      withRepo(repo, () =>
        run({
          sandbox: false,
          clientArgv: [process.execPath, join(import.meta.dirname, "fixtures", "fake-pi.mjs"), "silent"],
        }),
      ),
    /read nothing and reported nothing/,
  );
});
