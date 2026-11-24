#!/usr/bin/env node
// A local sweep: run the review against a real repository, with a matrix of sampler settings, without GitHub.
//
// The GitHub loop costs a queue, a checkout, an artifact round-trip and a 90-minute timeout per data point. This runs the
// same code — inside a container with bubblewrap, git and node, so it is the sandboxed path and not a bypass — and reads
// its numbers from the event stream the review already writes.
//
//   node tools/eval.mjs --repo ../HonorAuditions --base origin/main \
//     --settings tools/eval/models.json --runs 2 --out out/eval.jsonl
//
// `samplers.json` is an array of { "name": "…", "config": { … } }: a whole .ai-review.json per combo, written into
// the fixture the harness just built. No environment override exists in the action, and none is needed here.
// Requires a reachable endpoint: AI_REVIEW_BASE_URL and AI_REVIEW_API_KEY in the environment, and Docker.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { device } from "./eval/device.mjs";

const host = (p) => p.split("\\").join("/");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const fixture = arg("fixture", null);

const base = arg("base", "origin/main");
const settingsFile = arg("settings");
const runs = Number(arg("runs", "1"));
// A sweep of zero runs exits 0 having measured nothing, and "NaN" (from --runs abc) silently does the same.
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be an integer of 1 or more");
  process.exit(2);
}
const out = resolve(arg("out", "out/eval.jsonl"));
const image = arg("image", "ai-review-eval");

if (!fixture) {
  console.error("--fixture <name> is required: a real repository's diff moves between sweeps and cannot be compared");
  process.exit(2);
}
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

const all = JSON.parse(readFileSync(settingsFile, "utf8"));
// The pile of models to test only grows, so a sweep can be narrowed: --only glm runs just those rows.
const only = arg("only", null);
const combos = only ? all.filter((c) => c.name.toLowerCase().includes(only.toLowerCase())) : all;
if (!combos.length) {
  console.error(`no combo matches --only ${only}; ${settingsFile} has: ${all.map((c) => c.name).join(", ")}`);
  process.exit(2);
}

// A model box serves one request at a time and drops its prefix cache between unrelated requests, so two sweeps at once
// do not halve the wall time: they corrupt both. One run of this script at a time, enforced rather than remembered.
const lock = join(process.cwd(), "out", "eval.lock");
mkdirSync(dirname(lock), { recursive: true });
try {
  writeFileSync(lock, String(process.pid), { flag: "wx" });
} catch {
  console.error(`${lock} exists — a sweep is already running (or exited badly; delete the file to continue)`);
  process.exit(3);
}
// A killed sweep leaves its `docker run` container alive, and that container keeps asking the model box for a review:
// five of them once. Labelled, and pruned before a sweep starts, so an orphan cannot quietly compete for the device.
const pruneOrphans = () => {
  try {
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", "label=ai-review-eval"], { encoding: "utf8" })
      .split(String.fromCharCode(10))
      .filter(Boolean);
    if (ids.length) {
      execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
      console.error(`pruned ${ids.length} container(s) left by an earlier sweep`);
    }
  } catch {}
};

const releaseLock = () => {
  try {
    execFileSync("rm", ["-f", lock]);
  } catch {}
};
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));

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

  // One predicate decides whether a finding answers an expectation, and both `hit` and the extras set use it. They used
  // to disagree: extras ignored the comment-quote rule, so a finding that quoted the comment describing a defect instead
  // of the code counted toward neither list and vanished from every metric but the raw count.
  //
  // A code defect cannot be "found" by quoting the comment that talks about it — measured on the oracle output, where the
  // .single() expectation was satisfied by a finding quoting the misleading comment rather than the code.
  const isComment = (q) =>
    String(q || "")
      .split("\n")
      .filter((l) => l.trim())
      .every((l) => /^\s*(\/\/|#|--|\*)/.test(l));
  const answers = (want, f) => {
    const tokens = want.any || [want.quote || ""];
    return (
      String(f.path || "").includes(want.path) &&
      (!want.codeDefect || !isComment(f.quote)) &&
      tokens.some((t) => `${f.quote || ""}${f.body || ""}`.toLowerCase().includes(t.toLowerCase()))
    );
  };

  const matched = new Set();
  let duplicates = 0;
  for (const want of expectations) {
    const claimed = scored.filter((f) => answers(want, f));
    if (claimed.length) hit.push(want.id);
    for (const f of claimed) matched.add(f);
    // Findings beyond the first that answers one expectation are restatements of it. Counting extras here instead (as
    // scored.length - hit.length did) labelled fiction as restatement and missed a finding that answered two
    // expectations on one path.
    duplicates += Math.max(0, claimed.length - 1);
  }

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
    ...(expectations.length
      ? {
          extras: scored.filter((f) => !matched.has(f)).map((f) => ({ severity: f.severity, path: f.path, quote: f.quote, body: f.body })),
          // Findings beyond the number of defects they cover: restatement is a different failure from fiction, and the
          // extras list cannot see it. Measured: one run kept 8 findings for 5 defects with zero extras.
          restated: duplicates,
        }
      : {}),
  };
};

pruneOrphans();

// Any OpenAI-compatible endpoint works; only a device that keeps one model resident needs to be told which to load. That
// is an adapter, chosen with --device, and the default does nothing.
const box = device({ kind: arg("device", "none"), baseUrl: process.env.AI_REVIEW_BASE_URL, key: process.env.AI_REVIEW_API_KEY });

const rows = [];
for (const combo of combos) {
  await box.ensure(combo.config.model);
  for (let run = 1; run <= runs; run += 1) {
    // Per run, so a run cannot be polluted by the previous one's working tree.
    const built = fixture ? buildFixture(fixture) : null;
    const target = built.work;
    // "deviceDefaults": true means "whatever this box runs when nobody configures it" — the row worth measuring first,
    // and one that cannot be transcribed wrong because it is read from the device.
    const settings = combo.config.deviceDefaults
      ? { ...combo.config, modelSettings: { ...(await box.defaults()), ...(combo.config.modelSettings || {}) }, deviceDefaults: undefined }
      : combo.config;
    writeFileSync(
      join(target, ".ai-review.json"),
      JSON.stringify(
        {
          rules: [],
          severityFloor: "low",
          maxTurns: combo.maxTurns || 20,
          // A deployment fact, and the one this box needs: without it a run grows to the whole 131k window, and every
          // later turn pays a four-minute prefill until the device cuts the request at ten minutes. It is not a default
          // — the action ships 0 — but every deployment that runs on this hardware has to say it.
          contextBudget: combo.contextBudget || 32000,
          // The client's own patience is a hardware fact, not a default: at 300 s a slow model's first turn is
          // aborted mid-stream and the row reads as a model failure. Measured on GLM under a 1.9k-token prompt:
          // 'Request timed out.: This operation was aborted' after 849 s of work.
          providerTimeoutMs: combo.providerTimeoutMs || 900000,
          ...settings,
        },
        null,
        2,
      ),
    );
    const started = Date.now();
    let failure = null;
    try { execFileSync(
      "docker",
      [
        "run", "--rm",
        "--label", "ai-review-eval",
        // bubblewrap needs mount and pid namespaces, which Docker's default capability set forbids. Narrower than
        // --privileged, and it is what makes a sweep test the sandboxed path rather than a bypass.
        "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_PTRACE",
        "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
        // One mount. Output goes inside it, so there is no second bind to get wrong — and Docker wants a forward-slash
        // path, which is what `host` is.
        "-v", `${host(target)}:/work`,
        "-v", `${host(join(here, ".."))}:/action:ro`,
        "-w", "/work",
        "-e", `AI_REVIEW_BASE_URL=${process.env.AI_REVIEW_BASE_URL}`,
        "-e", `AI_REVIEW_API_KEY=${process.env.AI_REVIEW_API_KEY}`,
        "-e", `BASE_REF=${base}`,
        "-e", "GITHUB_WORKSPACE=/work",
        "-e", "RUNNER_TEMP=/work/.eval",
        "-e", "FINDINGS_FILE=/work/.eval/findings.jsonl",
        "-e", "EVENTS_FILE=/work/.eval/events.jsonl",
        "-e", "NOTES_FILE=/work/.eval/notes.txt",
        "-e", "PROMPT_FILE=/work/.eval/prompt.txt",
        "-e", "TRANSCRIPT_FILE=/work/.eval/transcript.md",
        "-e", "PI_CODING_AGENT_DIR=/work/.eval/pi-cache",
        image,
        "sh", "-c", "mkdir -p /work/.eval && node /action/src/review.mjs",
      ],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    } catch (err) {
      // A failed run is a row, not the end of the sweep: the reason is the most useful thing a sweep can print.
      failure = String(err.stderr || err.stdout || err.message).trim().split(String.fromCharCode(10)).slice(-4).join(" | ");
    }
    const row = {
      at: new Date().toISOString(),
      sweep: `${process.pid}@${started}`,
      action: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: join(here, ".."), encoding: "utf8" }).trim(),
      // Which prompt produced this row, and on which sampler. Without these, an A/B result is a filename and a memory:
      // the prompt lives in the working tree, so an uncommitted variant has no other identity.
      prompt: createHash("sha256").update(readFileSync(join(here, "..", "src", "lib", "prompt.mjs"))).digest("hex").slice(0, 12),
      limits: { providerTimeoutMs, contextBudget: combo.contextBudget || 32000, maxTurns: combo.maxTurns || 20 },
      samplers: Object.fromEntries(
        ["temperature", "topP", "topK", "minP", "presencePenalty", "repeatPenalty", "thinkingFormat", "reasoning"].map((k) => [
          k,
          combo.config.modelSettings?.[k],
        ]),
      ),
      combo: combo.name || "unnamed",
      run,
      work: target,
      ...(failure ? { error: failure.slice(0, 400) } : {}),
      ...metrics(join(target, ".eval", "events.jsonl"), join(target, ".eval", "findings.jsonl"), Math.round((Date.now() - started) / 1000)),
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
