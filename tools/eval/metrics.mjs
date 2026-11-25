// The per-run numbers, read from the event stream the review already writes — so a test can call it on a synthetic
// `events.jsonl`, and a sweep can re-score a row from its `work` directory without re-running the model.

import { readFileSync, existsSync } from "node:fs";

// The numbers come from the event stream, never from what was posted: the poster's floors, markers and caps are policy,
// and a sweep is asking what the *model* did.
export function metrics(eventsPath, findingsPath, seconds, expectations = []) {
  const lines = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n") : [];
  const tools = {};
  const calls = [];
  let turns = 0;
  let answered = false;
  // A message's usage record repeats across its `message_update` deltas and once more at `message_end`; count it once
  // per distinct serialisation. The sum across turns is the metered total — the largest turn alone undercounts by
  // roughly the turn count, which once made a device look four times slower than it is.
  const usageSeen = new Set();
  let outputTokens = 0;
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
    const usage = event.message?.usage;
    if (usage) {
      const key = JSON.stringify(usage);
      if (!usageSeen.has(key)) {
        usageSeen.add(key);
        outputTokens += Number(usage.output) || 0;
      }
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
    outputTokens,
    // Aggregate throughput, not a decode rate: prefill and tool time are inside `seconds`, so rows are comparable.
    tokPerSec: seconds ? Number((outputTokens / seconds).toFixed(1)) : 0,
    // What the model actually filed, as opposed to what it claimed in prose.
    findings: scored.length,
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
          // Findings on code no expectation covers: the fixture's clean files. `extras` mixes two failures — fiction
          // on a defect file and nits on a clean file — and only the second is the noise a maintainer reads, so a
          // fixture with clean lines reports it on its own. A finding whose path belongs to an expected defect is not
          // here even when it matches no token: that is an extra, not noise on clean code.
          falsePositives: scored
            .filter((f) => !expectations.some((w) => String(f.path || "").includes(w.path)))
            .map((f) => ({ severity: f.severity, path: f.path, quote: f.quote, body: f.body })),
          // Findings beyond the number of defects they cover: restatement is a different failure from fiction, and the
          // extras list cannot see it. Measured: one run kept 8 findings for 5 defects with zero extras.
          restated: duplicates,
        }
      : {}),
  };
}
