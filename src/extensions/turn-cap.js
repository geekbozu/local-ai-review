// The turn cap. Pi has no built-in step limit, so an agent on local hardware can spend the whole job timeout
// exploring. This steers one message telling it to wrap up and report what it has.
//
// The budget is measured two ways on purpose. A turn cap alone is not a time bound — one turn that reads a large
// file and runs a command can take ten minutes at ~24 tok/s, and a two-file review once ran 66 minutes on a turn
// budget of 60. So the clock is checked too, and whichever comes first wins.
//
// The nudge is a *user* message, not a system one: a mid-conversation system message is folded into the leading
// prompt by the openai-completions adapter, which rewrites every token after it and destroys the prefix cache.

import { appendFileSync } from "node:fs";

export default function (pi) {
  const cap = Number(process.env.AI_REVIEW_MAX_TURNS || 100);
  const budgetMinutes = Number(process.env.AI_REVIEW_TIME_BUDGET_MIN || 45);
  const notes = process.env.AI_REVIEW_NOTES;
  const startedAt = Date.now();
  let steered = false;

  const note = (line) => {
    console.error(`[turn-cap] ${line}`);
    if (notes) appendFileSync(notes, line + "\n");
  };

  pi.on("turn_end", async (event) => {
    if (steered) return;

    const turn = Number(event?.turnIndex ?? 0) + 1;
    const minutes = (Date.now() - startedAt) / 60000;
    const overTurns = turn >= cap;
    const overTime = minutes >= budgetMinutes;
    if (!overTurns && !overTime) return;

    steered = true;
    note(
      overTime
        ? `time budget reached (${Math.round(minutes)} of ${budgetMinutes} min, ${turn} turns); steering wrap-up`
        : `turn budget reached (${turn} of ${cap}, ${Math.round(minutes)} min); steering wrap-up`,
    );

    pi.sendUserMessage(
      `You are out of budget after ${turn} turns and ${Math.round(minutes)} minutes. Stop exploring now. ` +
        `Call report_finding for anything you have already confirmed and have not yet reported, ` +
        `then reply with a one-paragraph summary of what you checked and what you did not.`,
    );
  });

  pi.on("agent_end", async () => {
    if (!steered) return;
    note("run ended after the budget nudge");
  });
}
