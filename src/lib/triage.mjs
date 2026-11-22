// Where is the risk concentrated in this change?
//
// This is a hint for ordering attention, not a measure of how much to care. Effort does not scale with diff size or
// file class: a one-line change to a rules file or an RLS policy is the most expensive thing a change can touch,
// and a long mechanical diff is usually the least. So nothing here says "skim", and nothing here sets a budget —
// the budget is one number, the agent is expected to be thorough inside it, and what is bounded is the work.
//
// The defaults are domain words that mean the same thing everywhere — authentication, money, migrations, secrets.
// Anything that names a layout ("src/services", "functions/", a rules directory) belongs in the repository's own
// `.ai-review.json` under `riskHints`, because this action is meant to work in a repo it has never seen.

const DEFAULT_HINTS = [
  /\bmigrations?\b/i,
  /\.sql$/i,
  /\b(auth|session|login|password|credential|permission|policy|role)\b/i,
  /\b(payment|credit|money|price|invoice|refund|billing)\b/i,
  /\b(secret|token|api[-_]?key)\b/i,
];

const compile = (patterns) => patterns.map((p) => new RegExp(p, "i"));

export function riskHints(files, extra = []) {
  const patterns = [...DEFAULT_HINTS, ...compile(extra)];
  return { highRisk: files.filter((f) => patterns.some((re) => re.test(f))), files };
}

// Said in the prompt because "be thorough" alone invites both grinding and skimming. The two halves matter equally:
// equally hard on every line, and stop when you have either found something or satisfied yourself.
export function thoroughBrief({ highRisk }) {
  if (!highRisk.length) return "";

  return [
    "## Where risk concentrates",
    "",
    ...highRisk.map((f) => `- \`${f}\``),
    "",
    "Start here, but do not stop here: a file outside this list can still be wrong, and a one-line change carries as",
    "much risk as a rewrite. Give every changed line the same attention.",
  ].join("\n");
}
