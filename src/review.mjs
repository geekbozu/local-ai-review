// The run. Config decides whether there is a review at all; the action's inputs decide where the model is.
//
// Nothing here knows which repository it is in.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { normaliseBaseUrl } from "./lib/url.mjs";
import { openedFiles, uncovered } from "./lib/coverage.mjs";
import { openTrace } from "./lib/trace.mjs";
import { renderTranscript } from "./lib/transcript.mjs";

import { parseDiff, touchedPaths, diffStats } from "./lib/diff.mjs";
import { buildPrompt } from "./lib/prompt.mjs";
import { restoreRulesFromBase } from "./lib/rules.mjs";

// Pinned by commit: pi fetches it once, and a checkout of that commit is never refetched on later runs.
const PI_RULES = process.env.PI_RULES || "git:github.com/code-yeongyu/pi-rules@96b65ff340de262e4fd7c09b191b97b5f3e67a19";
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
export function watch({ onFinding, onTurn }) {
  let buffer = "";
  let turn = 0;
  let findings = 0;
  // Tool arguments arrive on the start event; the end event carries only the outcome. This outlives a chunk, because a
  // start and its end routinely land in different reads — inside the chunk handler, every lookup missed and the log
  // said `finding 1: undefined undefined`.
  const args = new Map();
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

      if (event.type === "tool_execution_start") {
        args.set(event.toolCallId, event.args || {});
        continue;
      }

      if (event.type === "tool_execution_end" && event.toolName === "report_finding" && !event.isError) {
        findings += 1;
        const found = args.get(event.toolCallId) || {};
        onFinding?.({ findings, severity: found.severity, path: found.path, body: String(found.body || "") });
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
// --- the sandbox --------------------------------------------------------------------------------------------------
// Everything below is what the OS enforces. The previous design read `bash` command strings and decided what was
// allowed; a relative path defeated it in one attempt, and no amount of pattern-writing wins that game. A mount
// cannot be argued with.

// The sandbox does not inherit the job's PATH, and pi lives wherever npm put it — often a prefix that is on the job's
// PATH and nowhere else. Resolving to an absolute path is what makes the same command work inside and outside.
export function resolveExecutable(name, path = process.env.PATH || "") {
  if (name.includes("/")) return name;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return name;
}

export function bwrapAvailable() {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Root is read-only; the workspace and a per-job directory are writable; the action's own checkout is hidden rather
// than forbidden; the environment is cleared and rebuilt from the whitelist below.
export function sandboxArgv({ argv, workspace, writable = [], envForChild = {} }) {
  // No uid drop, and not by preference. A runner container commonly runs as root, and `--unshare-user` then maps root
  // to root, so `--uid 1000` lands on the overflow uid and can write nowhere — measured. Dropping privileges needs a
  // non-root runner user, which is the runner's decision rather than this action's. What is enforced instead: every
  // capability gone, so even as root there is no DAC override, no mount, no ptrace; nothing writable but two binds;
  // and the places worth reading hidden rather than guarded.
  const args = [
    "--ro-bind", "/", "/",
    "--bind", workspace, workspace,
    "--tmpfs", "/root",
    "--ro-bind-try", "/dev/null", "/var/run/docker.sock",
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "--clearenv",
    "--cap-drop", "ALL",
  ];
  for (const dir of writable) if (dir && existsSync(dir)) args.push("--bind", dir, dir);
  // The runner checks the action out beside the repository. A review that reads the reviewer is reviewing the wrong
  // thing, and this is the version of that rule that holds.
  const actions = join(dirname(dirname(workspace)), "_actions");
  if (existsSync(actions)) args.push("--tmpfs", actions);
  for (const [key, value] of Object.entries(envForChild)) {
    if (value !== undefined) args.push("--setenv", key, String(value));
  }
  args.push("--", ...argv);
  return args;
}

// The endpoint key must not exist inside the sandbox: with `bash` available, anything in the environment is readable by
// whatever the model was talked into running. This holds the key, listens on loopback, and accepts one per-run token.
// A convinced model can still use the model it was already using; it cannot take the credential.
export async function startKeyProxy({ target, realKey }) {
  const token = randomBytes(24).toString("hex");
  const base = target.replace(/\/+$/, "");

  const server = createServer(async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: { message: "unauthorized" } });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    // The base URL already ends at /v1 and pi appends /chat/completions to it, so a path that carries its own /v1 is
    // not duplicated.
    const path = base.endsWith("/v1") && req.url.startsWith("/v1") ? req.url.slice(3) : req.url;
    try {
      const upstream = await fetch(base + path, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          authorization: `Bearer ${realKey}`,
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      reply(502, { error: { message: String(err && err.message) } });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, token, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// The shared agent dir holds pi's package cache, so a board pays for it once. It is never handed to the sandbox: a
// writable shared cache is a way of making the next run load attacker-chosen code. Each job gets a copy.
function seedAgentDir() {
  const cache = process.env.PI_CODING_AGENT_DIR;
  const dir = join(process.env.RUNNER_TEMP || tmpdir(), `ai-review-agent-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  if (cache && cache !== dir && existsSync(cache)) {
    try {
      cpSync(cache, dir, { recursive: true });
    } catch (err) {
      console.error(`[ai-review] could not seed the agent dir from ${cache}: ${err.message}`);
    }
  }
  return dir;
}

export function writeAgentDir({ model, baseUrl, apiKeyEnv, settings }) {
  // Supplied by the action when the runner keeps a directory between jobs, so pi's `-e` package cache persists.
  const dir = process.env.PI_CODING_AGENT_DIR || join(tmpdir(), `ai-review-agent-${process.pid}`);
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
  // The repo's config wins: a workflow input is a deployment default for every repo that runs the action, while
  // `model` in .ai-review.json is one repository saying "this one". The old order made the config unreachable,
  // because the workflow always supplies its default and an env var that is always set is not a fallback.
  const model = config.model || env.AI_REVIEW_MODEL;
  const baseUrl = normaliseBaseUrl(env.AI_REVIEW_BASE_URL);
  const apiKeyEnv = env.AI_REVIEW_API_KEY_ENV || "AI_REVIEW_API_KEY";
  if (!model) throw new Error("no model: set AI_REVIEW_MODEL or .ai-review.json's model");
  if (!baseUrl) throw new Error("no endpoint: set AI_REVIEW_BASE_URL");
  if (!env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is empty; the endpoint needs a key`);

  if (!bwrapAvailable()) {
    throw new Error(
      "bubblewrap is not installed, so the review cannot be sandboxed. Install it once per runner " +
        "(apt-get install bubblewrap); see docs/security.md.",
    );
  }

  // The child never sees the endpoint key: it sees a loopback proxy that holds it.
  const proxy = await startKeyProxy({ target: baseUrl, realKey: env[apiKeyEnv] });

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
  const stats = diffStats(files);
  // No diff in the prompt: the change arrives as a file list and the command that prints it. What the agent can get
  // with one command does not belong in the text it is given, and on a large PR the diff is the largest thing there.
  const prompt = buildPrompt({
    baseRef,
    stats,
    contextWindow: config.modelSettings.contextWindow,
    touched,
    severityFloor: config.severityFloor,
    hints,
    instructions: config.instructions,
  });
  console.error(
    `[ai-review] model ${model} (from ${config.model ? "config" : "the action input"}) · ` +
      `${touched.length} file(s), ${hints.highRisk.length} in a high-risk area — budget ${config.maxTurns} turns — ` +
      `rules from base: ${rules.restored.length} restored, ${rules.removed.length} removed`,
  );

  // A per-job copy of the shared cache, never the cache itself: a writable shared directory is how the next run ends up
  // loading someone else's code.
  const agentDir = seedAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeAgentDir({
    model,
    baseUrl: proxy.baseUrl,
    apiKeyEnv,
    // The action's input wins when set, so a deployment can clamp a repo's numbers without editing its config.
    settings: { ...config.modelSettings, maxTokens: Number(env.AI_REVIEW_MAX_TOKENS || config.modelSettings.maxTokens) },
  });

  const systemPromptFile = join(agentDir, "reviewer.md");
  writeFileSync(systemPromptFile, prompt);

  const findingsFile = env.FINDINGS_FILE || join(tmpdir(), `ai-review-findings-${process.pid}.jsonl`);
  const promptFile = env.PROMPT_FILE || join(tmpdir(), `ai-review-prompt-${process.pid}.txt`);
  const transcriptFile = env.TRANSCRIPT_FILE || join(tmpdir(), `ai-review-transcript-${process.pid}.md`);
  writeFileSync(promptFile, prompt);
  const notesFile = env.NOTES_FILE || join(tmpdir(), `ai-review-notes-${process.pid}.txt`);
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
    // Standing instructions belong in the system prompt, where they are weighted more heavily than a user message.
    // The user message is then only the kickoff, and the change's facts are in the system prompt too.
    "--append-system-prompt", systemPromptFile,
    // No MCP: the review reaches nothing outside this machine and its model. A consumer's MCP servers would make the
    // review a path to external systems, which is not what a code review is for.
    "--no-mcp",
    "-e", join(import.meta.dirname, "extensions", "report-finding.js"),
    "-e", join(import.meta.dirname, "extensions", "turn-cap.js"),
    "-e", join(import.meta.dirname, "extensions", "truncate-results.js"),
    // pi-rules is the loader: it matches each rule's paths against the file being worked on and injects what applies,
    // at agent start and after every tool result. Given as a package spec rather than a path, so pi installs and caches
    // it; pinned to a commit, which pi never refetches once checked out.
    ...(PI_RULES ? ["-e", PI_RULES] : []),
    "--model", `local/${model}`,
  ];

  const started = Date.now();
  const events = [];
  // Written as it arrives: a run that is killed leaves the trace of how far it got, which is the run worth reading.
  const trace = openTrace(eventsFile);
  const workspace = process.cwd();
  const tempDir = dirname(findingsFile);
  const piBin = resolveExecutable(env.PI_BIN || "pi");
  // The whole environment the child gets. `--clearenv` means this list is all there is: no PATH from the runner, no
  // key, no token, nothing inherited by accident.
  const childEnv = {
    PATH: [dirname(piBin), "/usr/local/sbin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    HOME: agentDir,
    TMPDIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    AI_REVIEW_FINDINGS: findingsFile,
    AI_REVIEW_NOTES: notesFile,
    AI_REVIEW_MAX_TURNS: String(config.maxTurns),
    AI_REVIEW_RESULT_CHARS: String(config.resultChars),
    AI_REVIEW_TIME_BUDGET_MIN: String(env.AI_REVIEW_TIME_BUDGET_MIN || config.timeBudgetMinutes),
    // A per-run token the loopback proxy accepts, standing where the real key would be.
    [apiKeyEnv]: proxy.token,
  };
  const sandboxed = sandboxArgv({
    argv: [piBin, ...args],
    workspace,
    writable: [agentDir, tempDir],
    envForChild: childEnv,
  });

  await new Promise((resolve, reject) => {
    const child = spawn("bwrap", sandboxed, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: env.PATH || "/usr/bin:/bin" },
    });
    // The instructions are in the appended system prompt; this is the kickoff, not a second copy of them.
    child.stdin.end("Review the change described in your instructions. Report what you find with report_finding.");
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
