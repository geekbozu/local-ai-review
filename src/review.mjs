// The run. Config decides whether there is a review at all; the action's inputs decide where the model is.
//
// Nothing here knows which repository it is in.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { normaliseBaseUrl } from "./lib/url.mjs";
import { openedFiles, uncovered } from "./lib/coverage.mjs";
import { parseDiff, touchedPaths } from "./lib/diff.mjs";
import { readRules, buildPrompt } from "./lib/prompt.mjs";
import { triage } from "./lib/triage.mjs";

const git = (args, dir = process.cwd()) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")}: ${err.trim()}`))));
  });

// A 45-minute job that prints nothing for 45 minutes is indistinguishable from a wedged one, and the only evidence
// afterwards was a JSONL file on a runner that no longer exists. This prints as it goes and the same numbers go to
// the step summary, so a log answers "was it working" without a re-run.
function watch({ onFinding, onTurn }) {
  let buffer = "";
  let turn = 0;
  let findings = 0;
  const started = Date.now();

  return (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(String.fromCharCode(10));
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type === "tool_execution_end" && event.toolName === "report_finding" && !event.isError) {
        findings += 1;
        const args = event.args || {};
        onFinding?.({ findings, severity: args.severity, path: args.path, body: String(args.body || "") });
      }

      if (event.type === "turn_end") {
        turn += 1;
        const tools = (event.toolResults || []).map((r) => r.toolName).filter(Boolean);
        onTurn?.({ turn, seconds: Math.round((Date.now() - started) / 1000), tools, findings });
      }
    }
  };
}

// The model catalogue is generated from inputs so no repository has to carry one. This is also the only place the
// key is placed, and it goes in with $NAME so it is never written to disk.
function writeAgentDir({ model, baseUrl, apiKeyEnv, maxTokens, thinking }) {
  const dir = join(tmpdir(), `ai-review-agent-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const compat = { thinkingFormat: "openai" };
  const levels = { minimal: "minimal", low: "low", medium: "medium", high: "high" };
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          local: {
            baseUrl,
            api: "openai-completions",
            apiKey: `$${apiKeyEnv}`,
            models: [
              {
                id: model,
                name: model,
                reasoning: true,
                input: ["text"],
                contextWindow: 262144,
                // Pi sizes its own output budget from here. Too small and a thinking model spends it all
                // thinking and reports nothing, which reads as a refusal and is not one.
                maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat,
                samplingParams: { max_tokens: maxTokens, temperature: 0.2 },
                thinkingLevelMap: levels,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: Math.round(262144 * 0.19) } }, null, 2),
  );
  return dir;
}

export async function run() {
  const env = process.env;

  const config = loadConfig();
  if (!config) {
    console.log(`No .ai-review.json at the repo root: this repository has not opted in. Nothing to do.`);
    return { skipped: "not opted in" };
  }

  const baseRef = env.BASE_REF || "origin/main";
  const model = env.AI_REVIEW_MODEL || config.model;
  const baseUrl = normaliseBaseUrl(env.AI_REVIEW_BASE_URL);
  const apiKeyEnv = env.AI_REVIEW_API_KEY_ENV || "AI_REVIEW_API_KEY";
  if (!model) throw new Error("no model: set AI_REVIEW_MODEL or .ai-review.json's model");
  if (!baseUrl) throw new Error("no endpoint: set AI_REVIEW_BASE_URL");
  if (!env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is empty; the endpoint needs a key`);

  const diff = await git(["diff", "-U10", `${baseRef}...HEAD`]);
  const files = parseDiff(diff);
  const touched = touchedPaths(files);
  if (!touched.length) {
    console.log("The change is empty; nothing to review.");
    return { skipped: "empty diff" };
  }

  const rules = readRules(process.cwd(), baseRef, config, touched);
  // Effort is allocated from the paths touched, not from the clock: a lockfile PR should be cheap and an RLS PR
  // should not be. The turn budget follows the same signal.
  const budget = triage(touched, { maxTurns: config.maxTurns });
  const prompt = buildPrompt({ rules, diff, touched, severityFloor: config.severityFloor, triage: budget });
  console.error(
    `[ai-review] triage: ${budget.highRisk.length} high-risk, ${budget.semantic.length} semantic, ` +
      `${budget.mechanical.length} mechanical — budget ${budget.turns} turns`,
  );

  const agentDir = writeAgentDir({
    model,
    baseUrl,
    apiKeyEnv,
    maxTokens: Number(env.AI_REVIEW_MAX_TOKENS || 16384),
    thinking: config.thinking,
  });

  const findingsFile = env.FINDINGS_FILE || join(tmpdir(), `ai-review-findings-${process.pid}.jsonl`);
  const notesFile = join(tmpdir(), `ai-review-notes-${process.pid}.txt`);
  const eventsFile = env.EVENTS_FILE || join(tmpdir(), `ai-review-events-${process.pid}.jsonl`);

  const args = [
    "-p",
    "--mode", "json",
    "--no-session",
    "--no-context-files",
    "--no-extensions", // the checkout must not supply executable extensions
    "--thinking", config.thinking,
    // Plain tool names replace the whole selection, and a custom tool that is not named is silently absent.
    "--tools", "read,bash,edit,write,grep,find,ls,report_finding",
    "-e", join(import.meta.dirname, "extensions", "report-finding.js"),
    "-e", join(import.meta.dirname, "extensions", "turn-cap.js"),
    "--model", `local/${model}`,
  ];

  const started = Date.now();
  const events = [];
  await new Promise((resolve, reject) => {
    const child = spawn(env.PI_BIN || "pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env,
        PI_CODING_AGENT_DIR: agentDir,
        AI_REVIEW_FINDINGS: findingsFile,
        AI_REVIEW_NOTES: notesFile,
        AI_REVIEW_MAX_TURNS: String(config.maxTurns),
      },
    });
    child.stdin.end(prompt);
    const progress = watch({
      onFinding: (f) => console.error(`[ai-review] finding ${f.findings}: ${f.severity} ${f.path} — ${f.body.slice(0, 100)}`),
      onTurn: (t) =>
        console.error(
          `[ai-review] turn ${t.turn} done at ${t.seconds}s` +
            (t.tools.length ? ` — ${t.tools.join(", ")}` : " — no tools") +
            ` — ${t.findings} finding(s) so far`,
        ),
    });
    child.stdout.on("data", (d) => {
      events.push(d);
      progress(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pi exited ${code}`))));
  });

  writeFileSync(eventsFile, Buffer.concat(events));

  // A run that produces nothing must say why in the log. Without this, "0 findings" is indistinguishable from
  // "the endpoint refused, the model was not loaded, or the model refused" — and all three read as a clean review.
  const decoded = Buffer.concat(events)
    .toString("utf8")
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const failures = decoded
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => e.message)
    .filter((m) => m.stopReason === "error" || m.errorMessage);
  for (const m of failures.slice(0, 3)) console.error(`[review] model error: ${m.errorMessage || m.stopReason}`);

  const lastText = decoded
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => (e.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""))
    .filter(Boolean)
    .pop();
  if (lastText) console.error(`[review] agent said: ${lastText.slice(0, 400)}`);
  const findings = (() => {
    try {
      return readFileSync(findingsFile, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  })();

  const result = {
    findings,
    touched: touched.length,
    seconds: Math.round((Date.now() - started) / 1000),
    findingsFile,
    eventsFile,
    config,
  };

  const coverage = openedFiles(eventsFile);
  const opened = coverage.opened;
  const turns = coverage.turns;
  const missing = uncovered(touched, opened);

  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        "## AI review",
        "",
        "| | |",
        "|---|---|",
        "| Model | `" + model + "` |",
        "| Thinking | `" + config.thinking + "` |",
        "| Wall time | " + result.seconds + "s |",
        "| Turns | " + turns + " of " + config.maxTurns + " |",
        "| Findings | " + findings + " |",
        "| Files changed | " + touched.length + " |",
        "| Files opened | " + opened.size + " |",
        "| Rules | " + (rules ? "base ref" : "none declared") + " |",
        "",
        missing.length ? "**Never opened:** " + missing.map((f) => "`" + f + "`").join(", ") : "",
        "",
      ].join(String.fromCharCode(10)),
    );
  }

  console.log(JSON.stringify({ ...result, config: undefined }));
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
