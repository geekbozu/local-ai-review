// Builds the review prompt from what the repo declared, never from a path baked into this tool.
//
// Rules are read from the *base* ref, not the checkout: the review runs against the PR's tree, so a PR that edits
// its own rules would otherwise grade itself by them.

import { execFileSync } from "node:child_process";
import { matchesAny, ruleApplies } from "./config.mjs";
import { triageBrief } from "./triage.mjs";

const CAP = 12000; // characters of rules; beyond this the rules crowd out the diff

const git = (dir, args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function listRuleFiles(dir, baseRef, config) {
  if (!config.rules.length) return [];
  const all = git(dir, ["ls-tree", "-r", "--name-only", baseRef]).split("\n").filter(Boolean);
  return all.filter((path) => matchesAny(path, config.rules));
}

export function readRules(dir, baseRef, config, touched) {
  const chunks = [];
  let used = 0;

  for (const path of listRuleFiles(dir, baseRef, config)) {
    let content;
    try {
      content = git(dir, ["show", `${baseRef}:${path}`]);
    } catch {
      continue; // rule file exists only on the PR, so it is not a rule yet
    }
    if (!touched.some((file) => ruleApplies(content, file))) continue;

    const slice = content.slice(0, Math.max(0, CAP - used));
    if (!slice) break;
    chunks.push(`--- ${path} ---\n${slice.trim()}`);
    used += slice.length;
  }

  return chunks.join("\n\n");
}

const INSTRUCTIONS = (severityFloor) => `You are reviewing one pull request: this checkout, this change.

Rules for this repository are below. Judge the change against them and against what the code is trying to do.

For every defect you are sure of, call report_finding with:
- path: the file, as it appears in the change
- quote: the exact text of the one line the comment belongs on, copied character for character
- severity: one of critical, high, medium, low
- body: one or two sentences naming the defect and what it costs

Rules for what you report:
- A quote must be a line that exists in the change. A paraphrase cannot be placed and will be dropped.
- Each body must read on its own. Do not refer to another finding.
- Only report what you can point at a line for. Anything you could not confirm, leave out.
- Nothing below "${severityFloor}" will be posted, so do not pad.

You have the whole checkout and you may run things to check a suspicion. Do not commit or push.

Work through every changed file before you finish, then reply with a short summary of what you checked and what you
did not.`;

export function buildPrompt({ rules, diff, touched, severityFloor = "low", triage }) {
  const files = touched.map((f) => `- ${f}`).join("\n");
  return [
    INSTRUCTIONS(severityFloor),
    rules ? `## Rules\n\n${rules}` : "",
    `## Changed files\n\n${files}`,
    triage ? triageBrief(triage) : "",
    `## The change\n\n${diff}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
