// The run. Config decides whether there is a review at all; the action's inputs decide where the model is.
//
// Nothing here knows which repository it is in.

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, lstatSync, mkdirSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, loadConfigFromRef } from "./lib/config.mjs";
import { normaliseBaseUrl } from "./lib/url.mjs";
import { openedFiles, uncovered } from "./lib/coverage.mjs";

import { parseDiff, touchedPaths, diffStats } from "./lib/diff.mjs";
import { buildPrompt } from "./lib/prompt.mjs";
import { renderTranscript } from "./lib/transcript.mjs";
import { bwrapAvailable, resolveExecutable, sandboxArgv } from "./steps/sandbox.mjs";
import { startKeyProxy } from "./steps/proxy.mjs";
import { seedAgentDir, writeAgentDir } from "./steps/agent-dir.mjs";
import { runAgent } from "./steps/agent-run.mjs";
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


// The workflow. `options` is the seam tests use — a stand-in client, or a dry run that stops before the model. It is a
// function argument and never an environment variable: a flag that can switch the sandbox off is a flag that eventually
// gets set, and nothing in the environment should be able to do that.
export async function run(options = {}) {
  const env = process.env;
  const sandbox = options.sandbox !== false;

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

  // A dry run stops before the spawn, so it does not need a sandbox to prove the steps that come first.
  if (sandbox && !options.dry && !bwrapAvailable()) {
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
  const piArgv = options.clientArgv || [resolveExecutable(env.PI_BIN || "pi")];
  const piBin = piArgv[0];
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
  if (options.dry) {
    // Everything up to the model call, so a refactor's wiring can be exercised without a device.
    console.log(JSON.stringify({ dryRun: true, prompt: prompt.length, frozen: frozenDir, agentDir, files: touched.length }));
    return { dryRun: true };
  }

  const sandboxArgs = sandboxArgv({
    argv: [piBin, ...args],
    workspace,
    // The two files, not the directory. A writable runner.temp let the agent delete or replace events.jsonl, which is
    // what the posted coverage report is computed from — a review that names the files it never opened, forged.
    writable: [agentDir, findingsFile, notesFile],
    envForChild: childEnv,
  });
  const childArgv = sandbox ? ["bwrap", ...sandboxArgs] : [...piArgv, ...args];

  // The agent: the step owns the child's lifetime and returns the raw stream.
  const events = await runAgent({
    argv: childArgv,
    childEnv: sandbox ? null : childEnv,
    eventsFile,
    transcriptFile,
    pathEnv: env.PATH,
  });

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

  // The agent can give up after a single failed turn, so "three consecutive errors" is not enough: a run in which the
  // model never answered at all has to fail, or a 404 for an unloaded model is posted as a clean review that read nothing.
  // Measured: one 404, one turn, "0 inline comments", and five changed files it never opened.
  const answered = decoded.some(
    (e) => e.type === "message_end" && e.message?.role === "assistant" && !e.message.errorMessage && e.message.stopReason !== "error",
  );
  if (!answered) {
    throw new Error(`the model never answered: ${failures[0]?.errorMessage || failures[0]?.stopReason || "no response"}`);
  }

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

  // Measured on gemma: five runs answered with token soup ("<find<|\"|>..."), made no tool call and filed nothing, and
  // every one of them passed the `answered` check above because the stop reason was "stop" and there was no error. A
  // review that read nothing is not a clean review. The action refuses an empty diff before this point, so a legitimate
  // pass has at least one tool call and cannot be confused with this.
  const toolCalls = decoded.filter((e) => e.type === "tool_execution_start").length;
  if (toolCalls === 0 && findings === 0) {
    throw new Error(
      "the model read nothing and reported nothing: no tool call was made, so this is not a clean review � " +
        `check the endpoint serves this model (${failures.length} failure(s), last stop reason ${decoded.at(-1)?.message?.stopReason ?? "unknown"})`,
    );
  }

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
