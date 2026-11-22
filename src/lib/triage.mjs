// Where is the risk concentrated in this change?
//
// This is a hint for ordering attention, not a measure of how much to care. Effort does not scale with diff size or
// file class: a one-line change to a rules file or an RLS policy is the most expensive thing a change can touch,
// and a long mechanical diff is usually the least. So nothing here says "skim", and nothing here sets a budget —
// the budget is one number, the agent is expected to be thorough inside it, and what is bounded is the work.

const HIGH_RISK = [
  /migrations?\//,
  /\.sql$/,
  /(^|\/)src\/services\//,
  /(^|\/)supabase\/functions\//,
  /auth|session|login|password|magic-?link/i,
  /rls|policy|permission|role/i,
  /payment|credit|money|price|invoice|refund/i,
  /secret|token|key/i,
  /(^|\/)\.pi\/(rules|skills)\//,
  /(^|\/)\.github\/workflows\//,
];

export function riskHints(files) {
  return { highRisk: files.filter((f) => HIGH_RISK.some((re) => re.test(f))), files };
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
