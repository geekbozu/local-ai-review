// Builds the review prompt from what the repo declared, never from a path baked into this tool.
//
// Rules are read from the *base* ref, not the checkout: the review runs against the PR's tree, so a PR that edits
// its own rules would otherwise grade itself by them.

import { execFileSync } from "node:child_process";
import { matchesAny, ruleApplies } from "./config.mjs";
import { thoroughBrief } from "./triage.mjs";

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

The change under review is the diff given to you below, and only that. A line already on the base branch is not
part of it, and a commit you find in the history is not part of it unless the diff contains it — if git log and the
diff appear to disagree, the diff is right.

The diff is where leads come from, not the boundary of the review. Follow a lead out of it — the function it calls,
the table it writes, the test that covers it — and let each excursion be traceable to a line in the diff. Reading
outside those leads is how a review of five files becomes an hour of reading a repository.

Read narrowly. Search for the name you care about first, then read the lines around it; the read tool takes an offset
and a limit, and a whole file is usually the wrong question. Documents, ledgers and generated files are the last thing
to open, not the first, and only when a line in the diff points at one.

The subject is this repository, at the working directory. Whatever the runner adds around it — action checkouts, temp
directories — is tooling, not part of the change. Commit messages and git history are how you understand the change,
not part of what you judge.

Work through every changed file before you finish. Give a one-line change the same attention as a rewrite: the size
of a diff says nothing about the risk in it.

And stop when the work is done. Once you have either found something or satisfied yourself that a file is correct,
move on — do not spend turns re-confirming that nothing is wrong. If you have covered every changed file and found
nothing, stop: saying so is a result, not a failure, and looking for a reason to keep going is how a review becomes
expensive without becoming better.`;

export function buildPrompt({ rules, diff, touched, severityFloor = "low", hints, instructions = [] }) {
  const files = touched.map((f) => `- ${f}`).join("\n");
  const supplied = instructions.length
    ? ["## From this repository", "", ...instructions.map((i) => `- ${i}`)].join("\n")
    : "";

  return [
    INSTRUCTIONS(severityFloor),
    rules ? `## Rules\n\n${rules}` : "",
    `## Changed files\n\n${files}`,
    hints ? thoroughBrief(hints) : "",
    supplied,
    `## The change\n\n${diff}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
