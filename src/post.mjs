// Posting: what the run found, as one review with inline comments.
//
// The workflow — resolve the frozen policy, read the findings, ask who we are, skip what is already there, post once.
// The decisions about *what* is postable live in lib/posting.mjs.

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openedFiles, uncovered } from "./lib/coverage.mjs";
import { parseDiff } from "./lib/diff.mjs";
import { loadConfig, loadConfigFromRef } from "./lib/config.mjs";
import { buildReview, existingMarkers, loadFindings, summarise } from "./lib/posting.mjs";


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
  // raise is a review that can silence itself. The review step resolves it against the base ref and freezes it.
  const floor = frozen ? frozen.floor : (loadConfigFromRef(base, ws) || loadConfig())?.severityFloor || "low";
  const { posted, dropped } = buildReview({
    findings: loadFindings(findingsFile),
    diff,
    floor,
    ignore: frozen?.ignore || [],
    confidenceFloor: frozen?.confidenceFloor ?? 7,
  });

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
