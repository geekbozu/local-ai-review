// The report_finding tool. Findings arrive as tool calls while the agent still has context to correct itself,
// which is the reason this is a tool rather than a JSON block parsed out of the final message.
//
// Findings are appended to AI_REVIEW_FINDINGS as JSONL so the poster reads a file and never the model's prose.

import { appendFileSync } from "node:fs";
import { Type } from "typebox";

export default function (pi) {
  const out = process.env.AI_REVIEW_FINDINGS;
  if (!out) throw new Error("AI_REVIEW_FINDINGS is not set; report_finding has nowhere to write");

  let count = 0;

  pi.registerTool({
    name: "report_finding",
    label: "Report finding",
    description:
      "Record one review finding, anchored to a line of the change. Call once per finding, as you find it. " +
      "Quote the line exactly as it appears in the file, character for character: the quote is how the comment " +
      "is placed, so a paraphrase cannot be posted.",
    parameters: Type.Object({
      path: Type.String({ description: "File path exactly as it appears in the diff, e.g. src/services/events.ts" }),
      quote: Type.String({ description: "The exact text of the line, copied from the file, no line number" }),
      severity: Type.Union(
        [
          Type.Literal("critical"),
          Type.Literal("high"),
          Type.Literal("medium"),
          Type.Literal("low"),
        ],
        { description: "critical = data loss, security bypass, or the feature does not work" },
      ),
      body: Type.String({ description: "One or two sentences: what is wrong and what it costs" }),
    }),
    async execute(_toolCallId, params) {
      count += 1;
      appendFileSync(out, JSON.stringify({ ...params, at: Date.now() }) + "\n");
      return {
        content: [{ type: "text", text: `recorded (${count} so far)` }],
        details: { recorded: count },
      };
    },
  });
}
