// The turn cap. Pi has no built-in step limit, so an agent on a local 35B can spend the whole job timeout
// exploring. At AI_REVIEW_MAX_TURNS this steers one message telling it to wrap up and report what it has.
//
// The nudge is a *user* message, not a system one: a mid-conversation system message is folded into the leading
// prompt by the openai-completions adapter, which rewrites every token after it and destroys the prefix cache.

import { appendFileSync } from "node:fs";

export default function (pi) {
  const cap = Number(process.env.AI_REVIEW_MAX_TURNS || 100);
  const notes = process.env.AI_REVIEW_NOTES;
  let steered = false;

  const note = (line) => {
    console.error(`[turn-cap] ${line}`);
    if (notes) appendFileSync(notes, line + "\n");
  };

  pi.on("turn_end", async (event) => {
    const turn = Number(event?.turnIndex ?? 0) + 1;
    if (steered || turn < cap) return;

    steered = true;
    note(`turn budget reached at turn ${turn} of ${cap}; steering wrap-up`);
    pi.sendUserMessage(
      `You have used ${turn} of your ${cap} turns. Stop exploring now. ` +
        `Call report_finding for anything you have already confirmed and have not yet reported, ` +
        `then reply with a one-paragraph summary of what you checked and what you did not.`,
    );
  });

  pi.on("agent_end", async () => {
    if (!steered) return;
    note("run ended after the turn budget nudge");
  });
}
