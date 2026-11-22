// The run. Config decides whether there is a review at all; the action's inputs decide where the model is.
//
// Nothing here knows which repository it is in.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, cpSync, accessSync, constants, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadConfigFromRef } from "./lib/config.mjs";
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

// A checkout the runner owns can be owned by someone else when a previous run chowned it, and git then refuses with
// "detected dubious ownership" — which reads as "not a git repository". We are the process that checked this tree out,
// so trust it explicitly rather than depend on who owns it.
const git = (args, dir = process.cwd()) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, "-c", `safe.directory=${dir}`, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")}: ${err.trim()}`))));
  });

// A 45-minute job that prints nothing for 45 minutes is indistinguishable from a wedged one, and the only evidence
// afterwards was a JSONL file on a runner that no longer exists. This prints as it goes and the same numbers go to
// the step summary, so a log answers "was it working" without a re-run.
// Enough consecutive failures to call the endpoint dead rather than flaky. Three spaced ≈ a minute of trying.
const MAX_MODEL_ERRORS = 3;

export function watch({ onFinding, onTurn, onFatal }) {
  let buffer = "";
  let turn = 0;
  let findings = 0;
  // Tool arguments arrive on the start event; the end event carries only the outcome. This outlives a chunk, because a
  // start and its end routinely land in different reads — inside the chunk handler, every lookup missed and the log
  // said `finding 1: undefined undefined`.
  const args = new Map();
  const started = Date.now();
  let consecutiveErrors = 0;

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

      // The model host is allowed to hiccup. One failed call is a bad request: the agent gets another turn, and a
      // success resets the count. A run of them is an endpoint that is not coming back — a model the device does not
      // have loaded, a dead key — and waiting out the rest of the budget would only delay the same answer.
      if (event.type === "message_end" && event.message?.role === "assistant") {
        if (event.message.stopReason === "error" || event.message.errorMessage) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_MODEL_ERRORS) {
            onFatal?.(event.message.errorMessage || "the model call failed");
            continue;
          }
        } else {
          consecutiveErrors = 0;
        }
      }

      if (event.type === "tool_execution_start") {
        args.set(event.toolCallId, event.args || {});
        // The list can shrink, so the count in these lines is what the agent *did*, and the file is what it *has*. The
        // two disagreed the moment withdraw_finding existed: the summary reported 19 while the file held 7.
        const a = event.args || {};
        if (event.toolName === "report_finding") console.error(`[ai-review] reported: ${a.severity} ${a.path}`);
        else if (event.toolName === "withdraw_finding") console.error(`[ai-review] withdrew: ${a.id}`);
        else if (event.toolName === "update_finding") console.error(`[ai-review] updated: ${a.id}`);
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
    // /var/run is a symlink to /run, and docker is not the only socket there: containerd, podman and cri-o all live in
    // this tree. Hiding the directory covers the ones nobody thought of.
    "--tmpfs", "/run",
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
  // An `http` server keeps the event loop alive, so the whole review finished, printed its summary and then hung until
  // the job was cancelled. Unref'd, it still answers while the child is alive and cannot outlive the work.
  server.unref();
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
  // `httpIdleTimeoutMs` is the client's own patience, and its default of five minutes is shorter than a slow device needs
  // to read a large prompt: it abandons runs that were working, and the failure arrives as an upstream stream timeout
  // rather than as our timeout. `retry.provider.maxRetries` is 0 because the agent-level retry already covers a failed
  // request; both on means the same request can be retried twice over.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        compaction: { enabled: true, reserveTokens: Math.round(settings.contextWindow * 0.19) },
        httpIdleTimeoutMs: settings.providerTimeoutMs > 0 ? settings.providerTimeoutMs : "disabled",
        // Five agent-level retries, stated rather than inherited: the client's default is three, and a retry policy that
        // nobody chose is a policy nobody can reason about. Provider-level stays 0 — the agent retry covers the same
        // failure, and both at once retries one request twice over.
        retry: { maxRetries: 5, provider: { maxRetries: 0 } },
      },
      null,
      2,
    ),
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

  // Not process.cwd(): a composite action's working directory is the caller's, and relying on it produced
  // "git diff ...: warning: Not a git repository" on a run whose checkout had succeeded. GITHUB_WORKSPACE is the
  // checkout, and the line below makes the difference visible when they disagree.
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const tempRoot = env.RUNNER_TEMP || tmpdir();
  console.error(`[ai-review] workspace ${workspace} (cwd ${process.cwd()}), git repo: ${existsSync(join(workspace, ".git"))}`);
  const diff = await git(["diff", "-U10", `${baseRef}...HEAD`], workspace);
  const files = parseDiff(diff);
  const touched = touchedPaths(files);
  if (!touched.length) {
    console.log("The change is empty; nothing to review.");
    return { skipped: "empty diff" };
  }

  // The extension loads and matches the rules; this only makes sure it reads the base branch's copy of them.
  // Freeze what the poster will judge by, before the agent has run. `.git` lives in the workspace, and the workspace is
  // the one tree the sandbox may write: an agent that moves `origin/main` can otherwise choose both the diff its quotes
  // anchor to and the floor that decides what posts. This directory is outside every bind, so the child can read it and
  // cannot change it.
  // In the per-job temp, which is not writable by the child (only two files there are bound), and which cannot
  // outlive the job. A sibling of the workspace would also be outside the binds, but it would persist between jobs,
  // and a crash before this write would let the poster read the previous run's diff.
  // The policy that decides what is *posted* comes from the base ref, not from the pull request's own copy of the
  // config: otherwise a PR sets severityFloor to low and confidenceFloor to 0 and grades itself. The review's own
  // behaviour (model, samplers, budget) stays whatever the checkout says; this is only the part that judges it.
  const basePolicy = loadConfigFromRef(baseRef, workspace);

  const frozenDir = env.FROZEN_DIR || join(tempRoot, "ai-review-frozen");
  const head = (await git(["rev-parse", "HEAD"], workspace)).trim();
  rmSync(frozenDir, { recursive: true, force: true });
  mkdirSync(frozenDir, { recursive: true });
  writeFileSync(join(frozenDir, "diff.txt"), diff);
  writeFileSync(
    join(frozenDir, "meta.json"),
    JSON.stringify({
      floor: basePolicy?.severityFloor ?? config.severityFloor,
      confidenceFloor: basePolicy?.confidenceFloor ?? config.confidenceFloor,
      ignore: basePolicy?.ignore ?? config.ignore,
      baseRef,
      head,
    }),
  );

  const rules = restoreRulesFromBase(workspace, baseRef, config);
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
  // The sandbox hides `_work/_actions`, which is where these extensions live, so they are copied to the one directory
  // the child can read and write. The alternative — leaving the action's own checkout visible — hands the agent the
  // reviewer's source to read.
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  for (const file of readdirSync(join(import.meta.dirname, "extensions"))) {
    cpSync(join(import.meta.dirname, "extensions", file), join(extDir, file));
  }
  writeAgentDir({
    model,
    baseUrl: proxy.baseUrl,
    apiKeyEnv,
    // The action's input wins when set, so a deployment can clamp a repo's numbers without editing its config.
    settings: {
      ...config.modelSettings,
      maxTokens: Number(env.AI_REVIEW_MAX_TOKENS || 0) || config.modelSettings.maxTokens,
      providerTimeoutMs: config.providerTimeoutMs,
    },
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
    "--tools", "read,bash,edit,write,grep,find,ls,codemode,report_finding,list_findings,update_finding,withdraw_finding",
    // Standing instructions belong in the system prompt, where they are weighted more heavily than a user message.
    // The user message is then only the kickoff, and the change's facts are in the system prompt too.
    "--append-system-prompt", systemPromptFile,
    // No MCP: the review reaches nothing outside this machine and its model. A consumer's MCP servers would make the
    // review a path to external systems, which is not what a code review is for.
    "--no-mcp",
    "-e", join(extDir, "report-finding.js"),
    "-e", join(extDir, "turn-cap.js"),
    "-e", join(extDir, "truncate-results.js"),
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
  // The child writes exactly two files: the findings it reports and the notes the budget writes. Create both here, as
  // root, because the sandbox runs without CAP_DAC_OVERRIDE and a runner temp directory owned by another uid refuses
  // newly created files. Measured: report_finding and turn-cap both failed with EACCES, and the agent spent its entire
  // budget trying to mount, unshare and FUSE its way around a permission error it could not fix.
  for (const file of [findingsFile, notesFile]) {
    try {
      // A previous job that skipped its cleanup could leave a symlink here, and appending through it would write wherever
      // it points. Nothing legitimate creates one, so it is removed rather than followed.
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(file, { force: true });
      if (!existsSync(file)) writeFileSync(file, "");
    } catch (err) {
      console.error(`[ai-review] cannot prepare ${file}: ${err.message}`);
    }
  }
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
    AI_REVIEW_CONTEXT_BUDGET: String(config.contextBudget),
    // A per-run token the loopback proxy accepts, standing where the real key would be.
    [apiKeyEnv]: proxy.token,
  };
  const sandboxed = sandboxArgv({
    argv: [piBin, ...args],
    workspace,
    // The two files, not the directory. A writable runner.temp let the agent delete or replace events.jsonl, which is
    // what the posted coverage report is computed from — a review that names the files it never opened, forged.
    writable: [agentDir, findingsFile, notesFile],
    envForChild: childEnv,
  });

  await new Promise((resolve, reject) => {
    const child = spawn("bwrap", sandboxed, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: env.PATH || "/usr/bin:/bin" },
    });
    // The instructions are in the appended system prompt; this is the kickoff, not a second copy of them.
    child.stdin.end("Review the change described in your instructions. Report what you find with report_finding.");
    let settled = false;
    const progress = watch({
      onFatal: (message) => {
        if (settled) return;
        settled = true;
        console.error(`[ai-review] the model call failed: ${message}`);
        try {
          child.kill("SIGTERM");
        } catch {}
        reject(new Error(`the model call failed: ${message}`));
      },
      onFinding: () => {}, // the report/withdraw/update lines above already say what happened
      onTurn: (t) =>
        console.error(
          `[ai-review] turn ${t.turn} done at ${t.seconds}s` +
            (t.tools.length ? ` — ${t.tools.join(", ")}` : " — no tools") +
            ` — ${t.findings} reported`,
        ),
    });
    child.stdout.on("data", (d) => {
      events.push(d);
      trace.write(d);
      progress(d);
    });
    child.stderr.on("data", (d) => {
      const text = String(d);
      process.stderr.write(text);
      // A review that cannot record a finding is not a review. An extension that fails inside the sandbox — a write the
      // child is not permitted, most likely — has to end the run: measured, the agent spent sixty turns trying to mount
      // and FUSE its way around the denial instead, and the run reported success with nothing to post.
      if (/Extension error/.test(text)) {
        try {
          child.kill("SIGTERM");
        } catch {}
        reject(new Error(`an extension failed inside the sandbox: ${text.trim().split(String.fromCharCode(10))[0]}`));
      }
    });

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

  const coverage = openedFiles(eventsFile, { root: workspace });
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
        "| Rules | " + (config.rules.length ? rules.restored.length + " from the base ref" : "none declared") + " |",
        "| Trace | `ai-review-run` artefact: `transcript.md` to read, `events.jsonl` for the evidence, `prompt.txt` for what it was told |",
        "",
        missing.length ? "**Never opened:** " + missing.map((f) => "`" + f + "`").join(", ") : "",
        "",
      ].join(String.fromCharCode(10)),
    );
  }

  // Nothing the run created should outlive it. The proxy is unref'd, so it cannot hold the process open — that was the
  // difference between a review that finishes and a job that hangs until it is cancelled — and the per-job agent dir is
  // removed rather than left in the runner's temp for the next job to find.
  try {
    proxy.server.close();
  } catch {}
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {}

  console.log(JSON.stringify({ ...result, config: undefined }));

  // Errors that the agent recovered from are reported and not fatal: a review that lost one request and finished is a
  // finished review. The run only fails when the endpoint stopped answering, which the watch above already decided.
  return result;
}

// pathToFileURL, not string surgery: a path with a space or a `#` in it makes the hand-built form disagree with
// import.meta.url, and the runner then silently does nothing. post.mjs has used this form for the same reason.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
