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

const repo = resolve(arg("repo", process.cwd()));
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
  };
};

const rows = [];
for (let run = 1; run <= runs; run += 1) {
  for (const combo of combos) {
    const work = mkdtempSync(join(tmpdir(), "eval-"));
    const started = Date.now();
    execFileSync(
      "docker",
      [
        "run", "--rm",
        "--network", "host",
        "-v", `${repo}:/work`,
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
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const row = {
      at: new Date().toISOString(),
      action: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: join(here, ".."), encoding: "utf8" }).trim(),
      combo: combo.name || "unnamed",
      run,
      ...metrics(join(work, "events.jsonl"), join(work, "findings.jsonl"), Math.round((Date.now() - started) / 1000)),
    };
    rows.push(row);
    writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(
      `${row.combo.padEnd(18)} r${run}  ${String(row.turns).padStart(3)} turns  ${String(row.seconds).padStart(4)}s  ` +
        `rep ${row.reports} wd ${row.withdraws} upd ${row.updates} list ${row.lists}  ` +
        `kept ${row.findings}  distinct ${row.distinct}/${row.calls}  ${row.answered ? "" : "NO ANSWER"}`,
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
