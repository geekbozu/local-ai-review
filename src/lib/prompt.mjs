// The prompt: facts the agent cannot get for itself, and nothing else.
//
// It is passed on stdin as the user message, not appended to the system prompt — but the principle is the same one:
// what the agent can obtain with one command does not belong in the text it is given. So the change arrives as a list
// of files and the command that prints the diff, rather than as the diff itself.

import { execFileSync } from "node:child_process";
import { matchesAny, ruleApplies } from "./config.mjs";

const CAP = 12000; // characters of rules; beyond this they crowd out everything else

const git = (dir, args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function listRuleFiles(dir, baseRef, config) {
  if (!config.rules.length) return [];
  return git(dir, ["ls-tree", "-r", "--name-only", baseRef])
    .split("\n")
    .filter(Boolean)
    .filter((path) => matchesAny(path, config.rules));
}

// Rules come from the *base* ref, not the checkout: the review runs against the PR's tree, so a PR that edits its own
// rules would otherwise be judged by them. Only the files whose `paths:` frontmatter covers a changed file are
// included — the rules are the largest thing in the prompt now that the diff is out of it.
export function readRules(dir, baseRef, config, touched) {
  const chunks = [];
  let used = 0;

  for (const path of listRuleFiles(dir, baseRef, config)) {
    let content;
    try {
      content = git(dir, ["show", `${baseRef}:${path}`]);
    } catch {
      continue; // a rule file that exists only on the PR is not a rule yet
    }
    if (!touched.some((file) => ruleApplies(content, file))) continue;

    const slice = content.slice(0, Math.max(0, CAP - used));
    if (!slice) break;
    chunks.push(`--- ${path} ---\n${slice.trim()}`);
    used += slice.length;
  }

  return chunks.join("\n\n");
}

const INSTRUCTIONS = (severityFloor, baseRef) => `## Change under review

base: ${baseRef}
diff: git diff -U10 ${baseRef}...HEAD
changed files: see below

That diff is the change. A line already on the base branch is not part of it, and a commit in the history is not part
of it unless the diff contains it — where git log and the diff disagree, the diff is right. The diff is where leads
come from, not the boundary of the review: follow a lead out of it, and let each excursion be traceable to a line in it.

## Reporting

Call report_finding once per defect:

- path: the file, as it appears in the change
- quote: the exact text of the line, copied character for character — a paraphrase cannot be placed and is dropped
- severity: critical | high | medium | low; nothing below ${severityFloor} is posted, so do not pad
- body: one or two sentences naming the defect and what it costs

Each body stands alone. Do not refer to another finding.

## Working

- Read narrowly: search for the name, then read the lines around it. A whole file is usually the wrong question.
- codemode does several lookups in one turn — grep, filter, then read what mattered — instead of a turn each.
- Documents, ledgers and generated files are the last thing to open, and only when a line in the diff points at one.
- You may run anything to confirm a suspicion. Do not commit or push.
- The subject is this repository, at the working directory. Anything outside that directory is tooling: reads there
  are refused, and a lead worth following is in the change or in the code it points at.
- Stop when the work is done. If you covered every changed file and found nothing, stop: saying so is a result, and
  looking for a reason to keep going is how a review becomes expensive without becoming better.`;

export function buildPrompt({ rules, touched, baseRef, severityFloor = "low", hints, instructions = [] }) {
  const files = touched.map((f) => `- ${f}`).join("\n");
  const supplied = instructions.length
    ? ["## Repository", "", ...instructions.map((i) => `- ${i}`)].join("\n")
    : "";

  return [
    INSTRUCTIONS(severityFloor, baseRef),
    rules ? `## Rules\n\n${rules}` : "",
    `## Changed files\n\n${files}`,
    hints ? thoroughBrief(hints) : "",
    supplied,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Where risk concentrates: ordering, not a measure of how much to care. Effort does not scale with diff size or file
// class — a one-line change to a rules file is the most expensive thing a change can touch — so nothing here says
// "skim", and nothing here sets a budget.
export function thoroughBrief({ highRisk }) {
  if (!highRisk.length) return "";
  return [
    "## Risk",
    "",
    ...highRisk.map((f) => `- ${f}`),
    "",
    "Start here, not only here: a file outside this list can still be wrong, and a one-line change carries as much",
    "risk as a rewrite.",
  ].join("\n");
}
