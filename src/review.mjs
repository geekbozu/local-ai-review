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

import { parseDiff, touchedPaths } from "./lib/diff.mjs";
import { buildPrompt } from "./lib/prompt.mjs";
import { restoreRulesFromBase } from "./lib/rules.mjs";
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
export function writeAgentDir({ model, baseUrl, apiKeyEnv, settings }) {
  const dir = join(tmpdir(), `ai-review-agent-${process.pid}`);
  mkdirSync(dir, { recursive: true });

  // A model with no thinking parameter gets no compatibility shim: sending reasoning_effort to a template that does not
  // read it is ignored at best. The wire format is the repo's choice — see modelSettings.thinkingFormat.
  // supportsMidConvoSystemMessages is load-bearing, not cosmetic: pi-rules injects rules as a mid-conversation system
  // message, and without this the adapter folds it into the *leading* prompt, rewriting every token after the fold and
  // dropping the prefix cache to single-digit percentages. Measured in this repo's own tooling.
  const compat = {
    ...(settings.reasoning && settings.thinkingFormat !== "none" ? { thinkingFormat: settings.thinkingFormat } : {}),
    supportsMidConvoSystemMessages: true,
  };
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
                reasoning: settings.reasoning,
                input: ["text"],
                // No max_tokens is sent per request: an OpenAI-compatible server defaults to its own limit (-1 on the
                // hardware this was built against, meaning the context). maxTokens here is the client's output budget,
                // and below the size of the model's thinking it truncates a turn mid-thought and returns no tool call.
                contextWindow: settings.contextWindow,
                maxTokens: settings.maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat,
                samplingParams: {
                  temperature: settings.temperature,
                  top_p: settings.topP,
                  top_k: settings.topK,
                  min_p: settings.minP,
                  presence_penalty: settings.presencePenalty,
                  repeat_penalty: settings.repeatPenalty,
                },
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

  // Compaction starts at a fifth of the window, so a long review summarises before the context forces it.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: Math.round(settings.contextWindow * 0.19) } }, null, 2),
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

  // The extension loads and matches the rules; this only makes sure it reads the base branch's copy of them.
  const rules = restoreRulesFromBase(process.cwd(), baseRef, config);
  // Risk hints order the agent's attention; they do not scale its effort. Thoroughness is uniform, the budget is
  // one number, and what is bounded is the work rather than how much any particular line deserves.
  const hints = riskHints(touched, config.riskHints || []);
  // No diff in the prompt: the change arrives as a file list and the command that prints it. What the agent can get
  // with one command does not belong in the text it is given, and on a large PR the diff is the largest thing there.
  const prompt = buildPrompt({
    baseRef,
    touched,
    severityFloor: config.severityFloor,
    hints,
    instructions: config.instructions,
  });
  console.error(
    `[ai-review] ${touched.length} file(s), ${hints.highRisk.length} in a high-risk area — budget ${config.maxTurns} turns — ` +
      `rules from base: ${rules.restored.length} restored, ${rules.removed.length} removed`,
  );

  const agentDir = writeAgentDir({
    model,
    baseUrl,
    apiKeyEnv,
    // The action's input wins when set, so a deployment can clamp a repo's numbers without editing its config.
    settings: { ...config.modelSettings, maxTokens: Number(env.AI_REVIEW_MAX_TOKENS || config.modelSettings.maxTokens) },
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
    // codemode lets the agent do several lookups in one turn — grep a name across four files, filter the result,
    // then read the two lines that mattered — instead of a round trip each. On a device that serves one request at a
    // time, turns are the expensive unit.
    "--tools", "read,bash,edit,write,grep,find,ls,codemode,report_finding",
    // No MCP: the review reaches nothing outside this machine and its model. A consumer's MCP servers would make the
    // review a path to external systems, which is not what a code review is for.
    "--no-mcp",
    "-e", join(import.meta.dirname, "extensions", "report-finding.js"),
    "-e", join(import.meta.dirname, "extensions", "turn-cap.js"),
    "-e", join(import.meta.dirname, "extensions", "truncate-results.js"),
    "-e", join(import.meta.dirname, "extensions", "scope.js"),
    // pi-rules is the loader: it matches each rule's paths against the file being worked on and injects what applies,
    // at agent start and after every tool result. Path supplied by the job; absent, the review simply has no rules.
    ...(env.PI_RULES_EXT ? ["-e", env.PI_RULES_EXT] : []),
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
        AI_REVIEW_RESULT_CHARS: String(config.resultChars),
        AI_REVIEW_TIME_BUDGET_MIN: String(env.AI_REVIEW_TIME_BUDGET_MIN || config.timeBudgetMinutes),
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
      console.error(`[ai-review] ${signal}: stopping the agent and rendering what it had`);

      // Clean up here rather than relying on a later step: a cancelled job races the runner's grace period, and the
      // one thing that makes a killed review useful is the transcript of what it managed.
      try {
        child.kill(signal);
      } catch {}
      try {
        writeFileSync(transcriptFile, renderTranscript(Buffer.concat(events).toString("utf8").split(String.fromCharCode(10))));
        console.error(`[ai-review] wrote ${transcriptFile} before exit`);
      } catch (err) {
        console.error(`[ai-review] could not render the transcript: ${err.message}`);
      }
      void trace.close();

      const hard = setTimeout(() => {
        console.error("[ai-review] agent ignored the signal; killing it");
        try {
          child.kill("SIGKILL");
        } catch {}
        process.exit(143);
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
