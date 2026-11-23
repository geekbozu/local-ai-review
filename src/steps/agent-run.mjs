// Running the agent: spawn it inside the sandbox, decode its stream, and make sure it cannot outlive the job.
//
// This is one step of the review workflow. It owns the child's lifetime — signals, the transcript written on a kill, and
// the two failures that must end a run instead of being logged — and returns the raw event stream for the report step.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { renderTranscript } from "../lib/transcript.mjs";
import { openTrace } from "../lib/trace.mjs";

// Enough consecutive failures to call the endpoint dead rather than flaky.
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

export async function runAgent({ argv, childEnv = null, eventsFile, transcriptFile, pathEnv }) {
  const events = [];
  // Written as it arrives: a run that is killed leaves the trace of how far it got, which is the run worth reading.
  const trace = openTrace(eventsFile);
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // Unsandboxed (a local harness, or a test with a stand-in client) the child needs the environment the sandbox would
      // otherwise inject; sandboxed, `--setenv` already carries it.
      env: childEnv || { PATH: pathEnv || "/usr/bin:/bin" },
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
  return events;
}
