// Posts the review: findings -> anchored comments -> one review, skipping anything a previous run already posted.
//
// Run standalone (CI) or imported by review.mjs. The model never supplies a line number; see lib/diff.mjs.

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseDiff, resolveQuote, normalise } from "./lib/diff.mjs";
import { openedFiles, uncovered } from "./lib/coverage.mjs";
import { loadConfig, loadConfigFromRef, matchesAny } from "./lib/config.mjs";

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

// The identity of a finding for de-duplication: the line it lands on, its severity, and the first quoted line
// without indentation. Identity used to be the raw quote, which is stricter than the anchor matcher — a run that
// quoted `"npm:pi-background"` and a run that quoted it with its four leading spaces were two comments on one line.
// The body is deliberately not in the key: the same defect in different words is the same defect. Severity is,
// because a re-rating across the floor is a finding that just became visible and should post. Two distinct defects on
// one line still post separately, since their quotes differ.
const marker = (f, line) =>
  createHash("sha256")
    .update(
      `${normalise(f.path)}\u0000${line}\u0000${normalise(f.severity)}\u0000${normalise(String(f.quote).split("\n")[0]).trimStart()}`,
    )
    .digest("hex")
    .slice(0, 16);

const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };

// A finding's body is model output, and the model has read a pull request written by someone who wanted a comment
// posted. Markdown is not inert: `@` pings people and teams, a remote image beacons each reader's address back to its
// host, raw HTML survives, and nothing else caps the size. Posting is the one place the agent's words reach people.
const MAX_BODY = 2000;
// Inside a code span, a newline or a backtick ends the span early and everything after it renders as markdown. Anything
// quoted into a code span goes through this.
const inline = (value, limit) =>
  sanitise(String(value))
    .replace(/[`\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

export const sanitise = (body) =>
  String(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Images, inline and reference-style. A reference-style image needs its definition line too, or the `![x][r]` is
    // inert text and the beacon is the definition — so both go.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // A marker is how the poster recognises its own comment on a later run. Quoted in a body it would suppress a real
    // finding forever, and the agent can compute one: it is a hash of values that are all in the diff.
    .replace(/<!--\s*ai-review:[^>]*-->/g, "")
    .replace(/@/g, "\\@")
    .slice(0, MAX_BODY);

export function buildReview({ findings, diff, floor = "low", ignore = [] }) {
  const files = parseDiff(diff);
  const min = SEVERITY[floor] ?? 3;

  const posted = [];
  const dropped = [];
  const seen = new Set();

  for (const f of findings) {
    // `ignore` is the repository's own list of paths it does not want commented on. It was documented, validated and
    // then never read, which is worse than not having it: the config said something the bot did not do.
    if (f.path && matchesAny(normalise(f.path), ignore)) {
      dropped.push({ reason: "ignored path", path: f.path, quote: f.quote });
      continue;
    }
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

    const id = marker(f, hit.line);
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
      body: `**${f.severity}** — ${sanitise(f.body)}\n\n<!-- ai-review:${id} -->`,
    });
  }

  return { posted, dropped, files };
}

// Re-runs are normal: a push triggers another review. The hidden marker is the only reliable way to tell "we
// already said this" from "we are saying it again", so it is written into every body and read back here.
// Only comments this token wrote count as "we already said that". The marker is a hash of path, line, severity and the
// first quoted line — every input readable from the diff — so anyone who can comment on the pull request can compute one
// and suppress a real finding by posting it first. `only` is the login the token resolves to.
export function existingMarkers(comments, { login = null } = {}) {
  const ids = new Set();
  for (const c of comments) {
    // Ours by name, and nothing counts if we cannot name ourselves. Trusting any bot was the earlier fallback and it is
    // not safe: a GitHub App the attacker controls is type "Bot" too, and the marker is a hash of values visible in the
    // diff. Failing closed here means a run that cannot identify its own token re-posts findings rather than letting one
    // be suppressed — noise instead of silence.
    if (!login || c.user?.login !== login) continue;
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
      ...dropped.slice(0, 25).map((d) => {
        // Every part of this line is agent-controlled: `findings.jsonl` is a writable bind, so a line with an invalid
        // severity is dropped and then printed here — severity and path included. Sanitised and capped like the rest,
        // and backticks removed from the path so a code span cannot be closed early.
        const sev = d.severity ? `**${inline(d.severity, 40)}** ` : "";
        const where = d.path ? ` — \`${inline(d.path, 200)}\`` : "";
        const head = `${sev}${d.reason}${where}`;
        // Model output, in a rendered review body: the same sanitiser as a posted comment, and capped. A dropped finding
        // is not a safe finding, and an uncapped list of them is a way to make the POST fail entirely.
        if (d.body) return `- ${head}\n  ${sanitise(d.body).slice(0, 400)}`;
        if (d.raw) return `- ${head}: \`${inline(d.raw, 200)}\``;
        return `- ${head}${d.quote ? `: \`${inline(d.quote, 120)}\`` : ""}`;
      }),
      dropped.length > 25 ? `- …and ${dropped.length - 25} more, in this run's notes` : "",
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
  const ws = process.env.GITHUB_WORKSPACE || process.cwd();
  const findingsFile = process.env.FINDINGS_FILE || "findings.jsonl";
  const eventsFile = process.env.EVENTS_FILE;
  const diffFile = process.env.DIFF_FILE;
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR_NUMBER are required");

  // Frozen by the review step before the agent ran: the diff, and the floor that decides what posts. `.git` is inside
  // the writable tree, so reading either from the checkout would let a write-only agent choose its own grade.
  const frozenDir = process.env.FROZEN_DIR;
  const frozenDiff = frozenDir ? join(frozenDir, "diff.txt") : null;
  const frozenMeta = frozenDir ? join(frozenDir, "meta.json") : null;
  // Fail closed. A frozen directory that was expected and cannot be read means the review never got as far as freezing,
  // and the only alternative is reading the checkout — which is the tree the agent may have rewritten, and the exact hole
  // the freeze exists to close.
  let frozen = null;
  if (frozenDir) {
    if (!frozenDiff || !existsSync(frozenDiff) || !existsSync(frozenMeta)) {
      throw new Error(`no frozen diff at ${frozenDir}: the review did not complete its setup, so nothing can be posted`);
    }
    frozen = JSON.parse(readFileSync(frozenMeta, "utf8"));
  }

  const diff = frozen
    ? readFileSync(frozenDiff, "utf8")
    : diffFile
    ? readFileSync(diffFile, "utf8")
    : execFileSync("git", ["-C", ws, "-c", `safe.directory=${ws}`, "diff", "-U10", `${resolveBase(base)}...HEAD`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });

  // The floor is the repo's choice, not this tool's; a repo with no config gets the default.
  // The floor comes from the commit, not from the working tree: the agent holds `write`/`edit`, and a floor it can
  // raise is a review that can silence itself. Base ref, matching the rules, so a PR cannot rewrite the config that
  // decides how its own findings are graded.
  // The floor comes from the commit, not from the working tree: the agent holds `write`/`edit`, and a floor it can
  // raise is a review that can silence itself. Base ref, matching the rules, so a PR cannot rewrite the config that
  // decides how its own findings are graded.
  const floor = frozen ? frozen.floor : (loadConfigFromRef(base, ws) || loadConfig())?.severityFloor || "low";
  const { posted, dropped } = buildReview({ findings: loadFindings(findingsFile), diff, floor, ignore: frozen?.ignore || [] });

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

  // Who we are, so a comment written by someone else cannot pass for one of ours. `/user` is a user-to-server endpoint
  // and an installation token gets nothing from it, which would have left this filter silently doing nothing; `/app`
  // answers for an installation, and the bot's login is its slug.
  // /app answers for an installation token, /user for a personal one, and each 401s for the other. If neither answers,
  // the fallback still only trusts bot-authored comments.
  const me = await api("/app")
    .then((a) => (a?.slug ? `${a.slug}[bot]` : null))
    .catch(() => api("/user").then((u) => u?.login ?? null).catch(() => null));
  // Paginated: past the first hundred comments a re-run would re-post everything, and a busy pull request reaches that.
  const seenComments = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await api(`/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    seenComments.push(...batch);
    if (batch.length < 100) break;
  }
  const existing = existingMarkers(seenComments, { login: me });
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
