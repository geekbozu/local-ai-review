// Posts the review: findings -> anchored comments -> one review, skipping anything a previous run already posted.
//
// Run standalone (CI) or imported by review.mjs. The model never supplies a line number; see lib/diff.mjs.

import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseDiff, resolveQuote, normalise } from "./lib/diff.mjs";
import { openedFiles, uncovered } from "./lib/coverage.mjs";
import { loadConfig } from "./lib/config.mjs";

export function loadFindings(file) {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map(normalise)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _malformed: line };
      }
    });
}

// The identity of a finding for de-duplication. The body is deliberately not in it: the same defect described in
// different words is the same defect, and a reworded body defeated this — `presencePenalty` was posted three times on
// the same line in one batch of runs. Severity is in it, because a re-rating from low to medium is a finding that just
// became visible and should post.
const marker = (f) =>
  createHash("sha256")
    .update(`${normalise(f.path)}\u0000${normalise(f.quote)}\u0000${normalise(f.severity)}`)
    .digest("hex")
    .slice(0, 16);

const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildReview({ findings, diff, floor = "low" }) {
  const files = parseDiff(diff);
  const min = SEVERITY[floor] ?? 3;

  const posted = [];
  const dropped = [];
  const seen = new Set();

  for (const f of findings) {
    if (f._malformed !== undefined) {
      dropped.push({ reason: "not JSON", raw: String(f._malformed).slice(0, 120) });
      continue;
    }
    if (!(f.path && f.quote && f.body && f.severity)) {
      dropped.push({ reason: "missing field", path: f.path, quote: f.quote });
      continue;
    }
    if ((SEVERITY[f.severity] ?? 99) > min) {
      dropped.push({ reason: `below ${floor}`, path: f.path, quote: f.quote, severity: f.severity, body: f.body });
      continue;
    }

    const hit = resolveQuote(files, f.path, f.quote);
    if (!hit) {
      dropped.push({
        reason: "cannot anchor to a line in the diff",
        path: f.path,
        quote: f.quote,
        severity: f.severity,
        body: f.body,
      });
      continue;
    }

    const id = marker(f);
    if (seen.has(id)) {
      dropped.push({ reason: "duplicate within this review", path: f.path, quote: f.quote, severity: f.severity, body: f.body });
      continue;
    }
    seen.add(id);

    posted.push({
      path: normalise(f.path),
      line: hit.line,
      side: "RIGHT",
      severity: f.severity,
      marker: id,
      body: `**${f.severity}** — ${f.body}\n\n<!-- ai-review:${id} -->`,
    });
  }

  return { posted, dropped, files };
}

// Re-runs are normal: a push triggers another review. The hidden marker is the only reliable way to tell "we
// already said this" from "we are saying it again", so it is written into every body and read back here.
export function existingMarkers(comments) {
  const ids = new Set();
  for (const c of comments) {
    const m = /<!-- ai-review:([0-9a-f]{16}) -->/.exec(c.body || "");
    if (m) ids.add(m[1]);
  }
  return ids;
}

export function summarise({ posted, dropped, uncovered: missing = [], turns }) {
  const lines = [`AI review: ${posted.length} inline comment${posted.length === 1 ? "" : "s"}.`];
  if (missing.length) {
    lines.push(
      `**Not reviewed:** the agent never opened ${missing.length} changed file${missing.length === 1 ? "" : "s"} — ` +
        missing.map((p) => `\`${p}\``).join(", "),
    );
  }
  if (dropped.length) {
    lines.push(
      "",
      `<details><summary>${dropped.length} finding${dropped.length === 1 ? "" : "s"} not posted</summary>`,
      "",
      // The body, not just the quote: severity is the model's own rating and it is not stable — the same defect came
      // back medium, medium and low across three runs of one diff. A low that is really a medium has to be readable
      // here, because the artifact is not where anyone looks.
      ...dropped.map((d) => {
        const head = `${d.severity ? `**${d.severity}** ` : ""}${d.reason}${d.path ? ` — \`${d.path}\`` : ""}`;
        if (d.body) return `- ${head}\n  ${d.body}`;
        return `- ${head}${d.quote ? `: \`${String(d.quote).slice(0, 120)}\`` : ""}`;
      }),
      "",
      "</details>",
    );
  }
  if (turns) lines.push("", `<sub>${turns} turns, advisory only — this never blocks a merge.</sub>`);
  return lines.join("\n");
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// BASE_REF is the complete ref: "origin/main", not "main". Both callers used to disagree about that, which produced
// `origin/origin/main` in a log and nothing else to go on. Fail with the value in the message instead.
const resolveBase = (ref) => {
  const candidate = ref.includes("/") ? ref : `origin/${ref}`;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { stdio: "ignore" });
  } catch {
    throw new Error(`BASE_REF "${ref}" does not resolve to a commit. Pass a full ref such as origin/main.`);
  }
  return candidate;
};

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  const base = process.env.BASE_REF || "origin/main";
  const findingsFile = process.env.FINDINGS_FILE || "findings.jsonl";
  const eventsFile = process.env.EVENTS_FILE;
  const diffFile = process.env.DIFF_FILE;
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR_NUMBER are required");

  const diff = diffFile
    ? readFileSync(diffFile, "utf8")
    : execFileSync("git", ["diff", "-U10", `${resolveBase(base)}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  // The floor is the repo's choice, not this tool's; a repo with no config gets the default.
  const floor = loadConfig()?.severityFloor || "low";
  const { posted, dropped } = buildReview({ findings: loadFindings(findingsFile), diff, floor });

  // Everything the run found and did not post, with the body a reader would have needed. The summary has room for a
  // folded list of reasons; this is where a low finding or an unanchorable one stays legible. It travels with the
  // artifact, which is why the artifact step runs after this one.
  if (process.env.AI_REVIEW_NOTES && dropped.length) {
    appendFileSync(
      process.env.AI_REVIEW_NOTES,
      dropped
        .map(
          (d) =>
            `[${d.reason}] ${d.severity || "?"} ${d.path || d.raw || "?"}\n` +
            `  quote: ${String(d.quote ?? "").slice(0, 300)}\n` +
            `  body: ${d.body || ""}\n`,
        )
        .join(""),
    );
  }

  // With the repository root, so an absolute read path becomes the repo-relative one the diff uses. Without it the
  // gate reported every changed file as unopened while the agent had read all five.
  const coverage = eventsFile ? openedFiles(eventsFile, { root: process.cwd() }) : { opened: new Set(), turns: 0 };
  const missing = eventsFile ? uncovered([...parseDiff(diff).keys()], coverage.opened) : [];

  const existing = existingMarkers(await api(`/repos/${repo}/pulls/${pr}/comments?per_page=100`));
  const fresh = posted.filter((p) => !existing.has(p.marker));
  const skipped = posted.length - fresh.length;

  const body = summarise({ posted: fresh, dropped, uncovered: missing, turns: coverage.turns });
  const comments = fresh.map(({ path, line, side, body: text }) => ({ path, line, side, body: text }));

  if (comments.length || body) {
    await api(`/repos/${repo}/pulls/${pr}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "COMMENT", body, comments }),
    });
  }

  const report = {
    posted: fresh.length,
    alreadyPresent: skipped,
    dropped: dropped.length,
    uncovered: missing,
    turns: coverage.turns,
  };
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  }
}

import { pathToFileURL } from "node:url";

// Run when invoked directly. pathToFileURL, not string surgery: on Windows import.meta.url is
// file:///C:/..., and a hand-built prefix silently never matches, leaving the CLI a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
