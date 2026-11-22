// The budget. Pi has no built-in step limit, so an agent on local hardware can spend the whole job timeout exploring.
// Two triggers steer one wrap-up message: the turn count, and the wall clock when the consumer sets one. Whichever
// comes first wins, and the job timeout is the backstop under both.
//
// There is deliberately no "reported nothing yet" trigger. A turn count is not progress: on the planted-defect run the
// agent reported nothing until turn 32 and then reported four findings, the first of them correct. A guard on silence
// fires in the middle of the work it is meant to protect, and it fired on that run.
//
// The clock is off by default (0). A turn that reads a file and runs a command costs minutes, so a turn count is not a
// time bound either — but review quality tied to machine speed is the wrong trade when nothing is wedged.
//
// The nudge is a *user* message, not a system one: a mid-conversation system message is folded into the leading prompt
// by the openai-completions adapter, which rewrites every token after it and destroys the prefix cache.
//
// It is sent as an explicit steer: `deliverAs`, which is the option the extension API takes. `streamingBehavior` is a
// field on *input events*, and passing it here looks plausible and does nothing — every nudge this extension made threw
// "Agent is already processing" and steered nothing.

import { appendFileSync } from "node:fs";

export default function (pi) {
  const cap = Number(process.env.AI_REVIEW_MAX_TURNS || 60);
  const budgetMinutes = Number(process.env.AI_REVIEW_TIME_BUDGET_MIN || 0);
  const notes = process.env.AI_REVIEW_NOTES;
  const startedAt = Date.now();
  let steered = false;

  const note = (line) => {
    console.error(`[turn-cap] ${line}`);
    if (notes) appendFileSync(notes, line + "\n");
  };

  // The nudge is advice, and a model can decline it: one measured run took the wrap-up at turn 60 and kept going to turn
  // 120, reporting and withdrawing the same finding. A budget that is only a message is not a budget, so after a short
  // grace the child is stopped — the findings file is already on disk, so what it confirmed still gets posted.
  let grace = 0;
  const GRACE_TURNS = 6;

  pi.on("turn_end", async (event) => {
    if (steered) {
      grace += 1;
      if (grace > GRACE_TURNS) {
        note(`still running ${grace} turns after the wrap-up; stopping the run`);
        process.exit(0);
      }
      return;
    }

    const turn = Number(event?.turnIndex ?? 0) + 1;
    const minutes = (Date.now() - startedAt) / 60000;
    const overTurns = turn >= cap;
    const overTime = budgetMinutes > 0 && minutes >= budgetMinutes;
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
      { deliverAs: "steer" },
    );
  });

  pi.on("agent_end", async () => {
    if (!steered) return;
    note("run ended after the budget nudge");
  });
}
