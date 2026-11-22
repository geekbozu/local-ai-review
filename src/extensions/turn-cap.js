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
  const cap = Number(process.env.AI_REVIEW_MAX_TURNS || 60);
  // 0 means off. Effort is allocated by triage in review.mjs; this is only here for the case where a run is
  // genuinely wedged, and a default would make review quality depend on machine speed.
  const budgetMinutes = Number(process.env.AI_REVIEW_TIME_BUDGET_MIN || 0);
  const notes = process.env.AI_REVIEW_NOTES;
  const startedAt = Date.now();
  let steered = false;

  const note = (line) => {
    console.error(`[turn-cap] ${line}`);
    if (notes) appendFileSync(notes, line + "\n");
  };

  // Findings the agent has actually reported, so the budget can be spent on a review rather than on looking for one.
  let findings = 0;
  pi.on("tool_call", async (event) => {
    if (event.toolName === "report_finding") findings += 1;
  });

  pi.on("turn_end", async (event) => {
    if (steered) return;

    const turn = Number(event?.turnIndex ?? 0) + 1;
    const minutes = (Date.now() - startedAt) / 60000;
    const overTurns = turn >= cap;
    const overTime = budgetMinutes > 0 && minutes >= budgetMinutes;
    // A review that has reported nothing by half its budget has usually stopped reviewing and started hunting. The
    // measured case: 29 turns, 207k output tokens, no findings, cut off by the job timeout. This is the guard that
    // does not depend on the prompt being obeyed.
    // Half the budget was too late: measured at 40 minutes and 20 turns, six of them spending ~10k tokens of thinking
    // with no finding, before the guard's trigger at 30 was even close. A quarter of the budget, capped at 15.
    const fruitless = findings === 0 && turn >= Math.max(8, Math.min(15, Math.ceil(cap / 4)));
    if (!overTurns && !overTime && !fruitless) return;

    steered = true;
    note(
      fruitless && !overTurns && !overTime
        ? `${turn} turns with no findings; steering wrap-up`
        : overTime
          ? `time budget reached (${Math.round(minutes)} of ${budgetMinutes} min, ${turn} turns); steering wrap-up`
          : `turn budget reached (${turn} of ${cap}, ${Math.round(minutes)} min); steering wrap-up`,
    );

    pi.sendUserMessage(
      (fruitless && !overTurns
        ? `You have spent ${turn} turns and reported nothing. Stop exploring now: if you found nothing worth reporting, say so and finish; if you have a finding, report it. `
        : `You are out of budget after ${turn} turns and ${Math.round(minutes)} minutes. Stop exploring now. `) +
        `Call report_finding for anything you have already confirmed and have not yet reported, ` +
        `then reply with a one-paragraph summary of what you checked and what you did not.`,
    );
  });

  pi.on("agent_end", async () => {
    if (!steered) return;
    note("run ended after the budget nudge");
  });
}
