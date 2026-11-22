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
import { openTrace } from "./lib/trace.mjs";
import { renderTranscript } from "./lib/transcript.mjs";

// The client's output budget per turn, not a review budget: the loop bounds a run. High enough never to bind on
// a normal turn (~10k of thinking) and only to stop a pathological one running for hours.
const MAX_OUTPUT_TOKENS = Number(process.env.AI_REVIEW_MAX_TOKENS || 65536);
import { parseDiff, touchedPaths } from "./lib/diff.mjs";
import { readRules, buildPrompt } from "./lib/prompt.mjs";
import { riskHints } from "./lib/triage.mjs";

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
                // Not a per-turn cap: this is the client's own output budget, and the loop is what bounds a run.
                // A value below the size of the model's thinking truncates the turn mid-thought and returns no
                // tool call at all — measured at ~10k tokens of thinking per turn, so 4096 "spends nothing" is
                // really "does nothing". Set high enough never to bind in practice (natural stops run ~10k) and
                // only to stop a pathological turn from running for hours.
                maxTokens: MAX_OUTPUT_TOKENS,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat,
                // 0.6 is the model card's recommendation for general tasks. Too cold on a reasoning model
                // makes it restate an angle instead of converging, which measured as ~10k tokens of thinking
                // per turn and no findings in 22 turns.
                //
                // No max_tokens in the request: an OpenAI-compatible server defaults to its own limit (-1 on the
                // hardware this was built against, meaning the context), so a per-turn ceiling can only hurt.
                samplingParams: { temperature: 0.6 },
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
  // Risk hints order the agent's attention; they do not scale its effort. Thoroughness is uniform, the budget is
  // one number, and what is bounded is the work rather than how much any particular line deserves.
  const hints = riskHints(touched);
  const prompt = buildPrompt({ rules, diff, touched, severityFloor: config.severityFloor, hints });
  console.error(
    `[ai-review] ${touched.length} file(s), ${hints.highRisk.length} in a high-risk area — budget ${config.maxTurns} turns`,
  );

  const agentDir = writeAgentDir({
    model,
    baseUrl,
    apiKeyEnv,
    maxTokens: Number(env.AI_REVIEW_MAX_TOKENS || 16384),
    thinking: config.thinking,
  });

  const findingsFile = env.FINDINGS_FILE || join(tmpdir(), `ai-review-findings-${process.pid}.jsonl`);
  const promptFile = env.PROMPT_FILE || join(tmpdir(), `ai-review-prompt-${process.pid}.txt`);
  const transcriptFile = env.TRANSCRIPT_FILE || join(tmpdir(), `ai-review-transcript-${process.pid}.md`);
  writeFileSync(promptFile, prompt);
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
  // Written as it arrives: a run that is killed leaves the trace of how far it got, which is the run worth reading.
  const trace = openTrace(eventsFile);
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
      trace.write(d);
      progress(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));

    // A cancelled job sends SIGTERM to this process, not to the agent under it. Without forwarding, `pi` survives as
    // an orphan: it keeps its model request alive on a device that serves one at a time, and a cancelled job has no
    // timeout left to end it. Measured on a real cancel — a review was still generating seven minutes after its run
    // was marked cancelled, holding the only model slot while the replacement queued behind it.
    let stopping = false;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      console.error(`[ai-review] ${signal}: stopping the agent`);
      child.kill(signal);
      const hard = setTimeout(() => {
        console.error("[ai-review] agent ignored the signal; killing it");
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 10_000);
      hard.unref();
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(signal));

    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pi exited ${code}`))));
  });

  await trace.close();

  // The readable view of the same run: what it thought, what it ran, what came back, what it decided. The raw
  // stream is kept beside it because a rendering is an interpretation and the stream is the evidence.
  writeFileSync(transcriptFile, renderTranscript(Buffer.concat(events).toString("utf8").split(String.fromCharCode(10))));

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
        "| Trace | `ai-review-run` artefact: `transcript.md` to read, `events.jsonl` for the evidence, `prompt.txt` for what it was told |",
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
