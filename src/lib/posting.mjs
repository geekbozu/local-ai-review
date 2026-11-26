// The posting policy, as pure functions: what a finding becomes, and what is said about the ones that are not posted.
//
// Kept apart from the workflow that calls them, because this is the part worth testing and the part where every security
// decision lives — floors, anchoring, sanitising, markers.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseDiff, resolveQuote, normalise } from "./diff.mjs";
import { matchesAny } from "./config.mjs";

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

export function buildReview({ findings, diff, floor = "low", ignore = [], confidenceFloor = 7 }) {
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
    if (!(f.path && f.body && f.severity && f.quote)) {
      dropped.push({ reason: "missing field", path: f.path, quote: f.quote });
      continue;
    }
    // A finding the agent is not confident in is not a finding to act on, and it used to arrive indistinguishable from
    // one it was sure of. Missing is treated as confident, so a hand-written line or an older run still posts.
    // Any confidence that is present and not a usable number fails closed: the findings file is a writable bind, so the
    // tool schema is not the only producer, and `"9"`, `7.5` or `true` all used to skip the floor entirely.
    if (f.confidence !== undefined && (!Number.isFinite(Number(f.confidence)) || Number(f.confidence) < confidenceFloor)) {
      dropped.push({
        reason: `below confidence ${confidenceFloor}`,
        path: f.path,
        quote: f.quote,
        severity: f.severity,
        body: f.body,
        confidence: f.confidence,
      });
      continue;
    }
    if ((SEVERITY[f.severity] ?? 99) > min) {
      dropped.push({ reason: `below ${floor}`, path: f.path, quote: f.quote, severity: f.severity, body: f.body });
      continue;
    }

    // A finding anchors by the text it quotes; an ambiguous or absent quote refuses rather than guessing.
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
