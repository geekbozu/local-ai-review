// The prompt: facts the agent cannot get for itself, and nothing else.
//
// It is passed as an appended *system* prompt rather than a user message, because that is weighted more heavily and
// these are standing instructions, not a question. The diff is deliberately not included — it is dynamic, and a large
// PR would fill the window before the review started. What is included is the size of the change and the size of the
// window, so the agent can decide how much to read.

const INSTRUCTIONS = (severityFloor, baseRef, stats, contextWindow) => `## Change under review

base: ${baseRef}
diff: git diff -U10 ${baseRef}...HEAD
size: ${stats.total.added} lines added, ${stats.total.removed} removed, across ${stats.perFile.length} files
window: ${contextWindow} tokens, and the diff is not in it — read what you need with the command above

That diff is the change. A line already on the base branch is not part of it, and a commit in the history is not part
of it unless the diff contains it — where git log and the diff disagree, the diff is right. The diff is where leads
come from, not the boundary of the review: follow a lead out of it, and let each excursion be traceable to a line in it.

## Reporting

Report at the end, not as you go. Read and check first; when you are satisfied, call report_finding once for each
defect in the list you have settled on. Reporting mid-review commits you to a half-finished opinion, and it produces
restatements of the same defect with different wording — one run reported thirteen variations of one concern. Each
defect is reported once, no matter how many times you meet it.

The exception is a wrap-up instruction: if you are told your budget is nearly spent, report whatever you have already
confirmed rather than finishing the pass — a review that is killed with nothing reported is worth less than an
incomplete one.

Before you finish, call list_findings once and read your own list, then make the edits it implies — you do not need to
re-read the list after every change, and a turn spent re-listing is a turn not spent reviewing. The same defect stated twice is one defect: merge the
restatements with update_finding, withdraw the ones you no longer think are defects, and leave one entry per thing a
maintainer would act on.

For each defect:

- path: the file, as it appears in the change
- quote: the exact text of the line, copied character for character — a paraphrase cannot be placed and is dropped
- severity: critical | high | medium | low; nothing below ${severityFloor} is posted, so do not pad
- the fewest findings that carry the review beat a long list: a maintainer acts on what is worth acting on, and five
  observations of one problem read as one observation and four restatements
- body: one or two sentences naming the defect and what it costs

Each body stands alone. Do not refer to another finding.

## Working

- Read narrowly: search for the name, then read the lines around it. A whole file is usually the wrong question.
- Rules arrive as you open files: the ones covering a file are added to your context when you touch it. Honour them.
- codemode does several lookups in one turn — grep, filter, then read what mattered — instead of a turn each.
- Documents, ledgers and generated files are the last thing to open, and only when a line in the diff points at one.
- You may run anything to confirm a suspicion. Do not commit or push.
- The environment is fixed. You cannot change mounts, permissions or ownership, and nothing is
  gained by trying: if a write fails, say which write and stop. A review that spends its turns on the
  filesystem has stopped reviewing.
- The subject is this repository, at the working directory. Tooling the runner adds around it is not part of the change.
- Stop when the work is done. If you covered every changed file and found nothing, stop: saying so is a result, and
  looking for a reason to keep going is how a review becomes expensive without becoming better.`;

export function buildPrompt({ touched, baseRef, stats, contextWindow = 262144, severityFloor = "low", hints, instructions = [] }) {
  const counts = new Map((stats?.perFile ?? []).map((f) => [f.path, f]));
  const files = touched
    .map((path) => {
      const c = counts.get(path);
      return c ? `- ${path}  +${c.added} -${c.removed}` : `- ${path}`;
    })
    .join("\n");

  const supplied = instructions.length
    ? ["## Repository", "", ...instructions.map((i) => `- ${i}`)].join("\n")
    : "";

  return [
    INSTRUCTIONS(severityFloor, baseRef, stats ?? { total: { added: 0, removed: 0 }, perFile: [] }, contextWindow),
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
