// How much review does this change warrant?
//
// Uniform effort is why a two-file PR ran 66 minutes: the prompt asked for the same depth on a lockfile as on an RLS
// policy. The signal is cheap and deterministic — the paths touched — so it is computed here rather than hoped for
// from the prompt. The model still decides what it finds; this decides how long it may look.

const MECHANICAL = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
  /\.lock$/,
  /(^|\/)generated\//,
  /(^|\/)migrations\/.*\.sql$/, // read carefully, but the surrounding file rarely needs chasing
  /(^|\/)types\/database\.ts$/, // generated
  /^Docs\/.*\.md$/,
  /\.md$/,
];

// Where a defect is expensive: auth, data access, money, and the rules that everything else is judged by.
const HIGH_RISK = [
  /migrations\//,
  /\.sql$/,
  /(^|\/)src\/services\//,
  /(^|\/)supabase\/functions\//,
  /auth|session|login|password|magic-?link/i,
  /rls|policy|permission|role/i,
  /payment|credit|money|price|invoice|refund/i,
  /secret|token|key/i,
  /(^|\/)\.pi\/rules\//,
];

export const MECHANICAL_TURNS = 5;
export const SEMANTIC_TURNS = 3;
export const HIGH_RISK_TURNS = 10;

export function triage(files, { maxTurns = 100 } = {}) {
  const mechanical = [];
  const semantic = [];
  const highRisk = [];

  for (const file of files) {
    if (MECHANICAL.some((re) => re.test(file))) mechanical.push(file);
    else semantic.push(file);

    if (HIGH_RISK.some((re) => re.test(file))) highRisk.push(file);
  }

  const turns = Math.min(maxTurns, MECHANICAL_TURNS + semantic.length * SEMANTIC_TURNS + highRisk.length * HIGH_RISK_TURNS);

  return { mechanical, semantic, highRisk, turns, maxTurns, capped: turns >= maxTurns };
}

// The prompt states the allocation rather than the model inventing one, so a low-risk change is cheap on purpose
// and a costly one is expensive on purpose.
export function triageBrief(t) {
  const list = (files) => files.map((f) => "`" + f + "`").join(", ");
  const lines = [
    "## Effort",
    "",
    `You have a budget of about ${t.turns} turn(s) for this change. Spend them where the risk is.`,
    "",
  ];

  if (t.highRisk.length) {
    lines.push(`- **Look hard at** ${list(t.highRisk)} — read the file, follow the callers, and say what breaks. This is where a defect is expensive.`);
  }
  if (t.semantic.length) {
    lines.push(`- **Read** ${list(t.semantic)} and comment on what is plainly wrong. Follow a caller only if the change is non-obvious.`);
  }
  if (t.mechanical.length) {
    lines.push(`- **Skim** ${list(t.mechanical)} — generated, mechanical or documentation. Read the diff, do not chase it further, and do not restate what the diff says.`);
  }

  lines.push(
    "",
    "If you find something that warrants more, spend more — but say why in the summary. Do not spend turns confirming",
    "that nothing is wrong; report nothing and say what you checked.",
  );

  return lines.join("\n");
}
