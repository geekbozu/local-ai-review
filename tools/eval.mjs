#!/usr/bin/env node
// A local sweep: run the review against a real repository, with a matrix of sampler settings, without GitHub.
//
// The GitHub loop costs a queue, a checkout, an artifact round-trip and a 90-minute timeout per data point. This runs the
// same code — inside a container with bubblewrap, git and node, so it is the sandboxed path and not a bypass — and reads
// its numbers from the event stream the review already writes.
//
//   node tools/eval.mjs --repo ../HonorAuditions --base origin/main \
//     --settings tools/eval/samplers.json --runs 2 --out out/eval.jsonl
//
// `samplers.json` is an array of { "name": "…", "modelSettings": { … } }, applied through AI_REVIEW_SETTINGS_JSON.
// Requires a reachable endpoint: AI_REVIEW_BASE_URL and AI_REVIEW_API_KEY in the environment, and Docker.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const fixture = arg("fixture", null);
const repo = fixture ? null : resolve(arg("repo", process.cwd()));
const base = arg("base", "origin/main");
const settingsFile = arg("settings");
const runs = Number(arg("runs", "1"));
const out = resolve(arg("out", "out/eval.jsonl"));
const image = arg("image", "ai-review-eval");

if (!settingsFile) {
  console.error("--settings <file.json> is required: an array of { name, modelSettings }");
  process.exit(2);
}
for (const key of ["AI_REVIEW_BASE_URL", "AI_REVIEW_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} must be set: the container needs an endpoint to talk to`);
    process.exit(2);
  }
}

const combos = JSON.parse(readFileSync(settingsFile, "utf8"));

// A fixture is `base/` and `head/` plus `expect.json`: the harness commits base, then head, so every run sees the same
// diff and can be scored against the defects that are known to be in it. A real repository is fine for smoke tests and
// useless for comparison — its diff moves between sweeps.
const buildFixture = (name) => {
  const dir = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "eval", "fixtures", name);
  const work = mkdtempSync(join(tmpdir(), "fixture-"));
  const copy = (from, to) =>
    execFileSync("cp", ["-a", `${from}/.`, to], { stdio: "ignore" }) ??
    null;
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { stdio: "ignore" });
  copy(join(dir, "base"), work);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "eval@example.com");
  git("config", "user.name", "eval");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  copy(join(dir, "head"), work);
  git("add", "-A");
  git("commit", "-qm", "change");
  return { work, expect: JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) };
};

const expectations = fixture ? JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "eval", "fixtures", fixture, "expect.json"), "utf8")) : [];
const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
mkdirSync(dirname(out), { recursive: true });

execFileSync("docker", ["build", "-q", "-t", image, join(here, "eval")], { stdio: "inherit" });

// The numbers come from the event stream, never from what was posted: the poster's floors, markers and caps are policy,
// and a sweep is asking what the *model* did.
const metrics = (eventsPath, findingsPath, seconds) => {
  const lines = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n") : [];
  const tools = {};
  const calls = [];
  let turns = 0;
  let answered = false;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn_end") turns += 1;
    if (event.type === "message_end" && event.message?.role === "assistant" && !event.message.errorMessage) answered = true;
    if (event.type === "tool_execution_start") {
      tools[event.toolName] = (tools[event.toolName] || 0) + 1;
      const a = event.args || {};
      calls.push(`${event.toolName} ${String(a.command || a.path || a.id || "")}`.slice(0, 80));
    }
  }
  const hit = [];
  const scored = existsSync(findingsPath)
    ? readFileSync(findingsPath, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  for (const want of expectations) {
    if (scored.some((f) => String(f.path).includes(want.path) && String(f.quote).includes(want.quote))) hit.push(want.id);
  }
  const findings = existsSync(findingsPath)
    ? readFileSync(findingsPath, "utf8").split("\n").filter(Boolean).length
    : 0;
  return {
    seconds,
    turns,
    answered,
    findings,
    reports: tools.report_finding || 0,
    withdraws: tools.withdraw_finding || 0,
    updates: tools.update_finding || 0,
    lists: tools.list_findings || 0,
    bash: tools.bash || 0,
    distinct: new Set(calls).size,
    calls: calls.length,
    ...(expectations.length ? { found: hit.length, of: expectations.length, missing: expectations.map((e) => e.id).filter((id) => !hit.includes(id)) } : {}),
  };
};

const rows = [];
for (let run = 1; run <= runs; run += 1) {
  for (const combo of combos) {
    // Per run, so a run cannot be polluted by the previous one's working tree.
    const built = fixture ? buildFixture(fixture) : null;
    const work = mkdtempSync(join(tmpdir(), "eval-"));
    const target = built ? built.work : repo;
    const started = Date.now();
    let failure = null;
    try { execFileSync(
      "docker",
      [
        "run", "--rm",
        "--network", "host",
        // bubblewrap needs mount and pid namespaces, which Docker's default capability set forbids. This is narrower than
        // --privileged and is what makes the container run the *sandboxed* path rather than a bypass.
        "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_PTRACE",
        "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
        "-v", `${target}:/work`,
        "-v", `${here}/..:/action:ro`,
        "-v", `${work}:/out`,
        "-w", "/work",
        "-e", `AI_REVIEW_BASE_URL=${process.env.AI_REVIEW_BASE_URL}`,
        "-e", `AI_REVIEW_API_KEY=${process.env.AI_REVIEW_API_KEY}`,
        "-e", `AI_REVIEW_SETTINGS_JSON=${JSON.stringify(combo.modelSettings || {})}`,
        "-e", `BASE_REF=${base}`,
        "-e", "GITHUB_WORKSPACE=/work",
        "-e", "RUNNER_TEMP=/out",
        "-e", "FINDINGS_FILE=/out/findings.jsonl",
        "-e", "EVENTS_FILE=/out/events.jsonl",
        "-e", "NOTES_FILE=/out/notes.txt",
        "-e", "PROMPT_FILE=/out/prompt.txt",
        "-e", "TRANSCRIPT_FILE=/out/transcript.md",
        "-e", "PI_CODING_AGENT_DIR=/out/pi-cache",
        image,
        "node", "/action/src/review.mjs",
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    } catch (err) {
      // A failed run is a row, not the end of the sweep: the reason is the most useful thing a sweep can print.
      failure = String(err.stderr || err.stdout || err.message).trim().split(String.fromCharCode(10)).slice(-4).join(" | ");
    }
    const row = {
      at: new Date().toISOString(),
      action: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: join(here, ".."), encoding: "utf8" }).trim(),
      combo: combo.name || "unnamed",
      run,
      ...(failure ? { error: failure.slice(0, 400) } : {}),
      ...metrics(join(work, "events.jsonl"), join(work, "findings.jsonl"), Math.round((Date.now() - started) / 1000)),
    };
    rows.push(row);
    writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(
      `${row.combo.padEnd(18)} r${run}  ${String(row.turns).padStart(3)} turns  ${String(row.seconds).padStart(4)}s  ` +
        `rep ${row.reports} wd ${row.withdraws} upd ${row.updates} list ${row.lists}  ` +
        `kept ${row.findings}  distinct ${row.distinct}/${row.calls}  ` +
        (expectations.length ? `found ${row.found}/${row.of}  ` : "") + `${row.error ? `ERROR ${row.error.slice(0, 90)}` : row.answered ? "" : "NO ANSWER"}`,
    );
  }
}

// The summary a sweep exists for: which combination finished, and which one kept anything.
console.log("\ncombo              runs  avg turns  avg secs  kept  distinct/total");
for (const combo of combos) {
  const mine = rows.filter((r) => r.combo === (combo.name || "unnamed"));
  if (!mine.length) continue;
  const avg = (k) => (mine.reduce((n, r) => n + r[k], 0) / mine.length).toFixed(1);
  console.log(
    `${(combo.name || "unnamed").padEnd(18)} ${String(mine.length).padStart(4)}  ${avg("turns").padStart(9)}  ` +
      `${avg("seconds").padStart(8)}  ${avg("findings").padStart(4)}  ` +
      `${(mine.reduce((n, r) => n + r.distinct, 0) / mine.length).toFixed(0)}/${(mine.reduce((n, r) => n + r.calls, 0) / mine.length).toFixed(0)}`,
  );
}
console.log(`\nrows: ${out}`);
