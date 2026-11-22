// The finding tools. Findings arrive as tool calls while the agent still has context to correct itself, which is the
// reason this is a tool rather than a JSON block parsed out of the final message.
//
// Three tools rather than one, because deduplication is the agent's own job: it is the only part of the system that
// knows two entries are the same defect described twice. `report_finding` alone made every restatement permanent — one
// measured run reported 29 findings, 13 of them variations of a concern it had already recorded. So it can look at what
// it has (`list_findings`), fix a wording or a severity (`update_finding`), or take one back (`withdraw_finding`).
//
// The list is held in memory and the JSONL is rewritten on every change, so the poster still reads a file and never the
// model's prose, and the file always reflects the agent's current opinion rather than its history.

import { writeFileSync } from "node:fs";
import { Type } from "typebox";

const SEVERITY = Type.Union(
  [Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
  { description: "critical = data loss, security bypass, or the feature does not work" },
);

const oneLine = (text, limit) => String(text).replace(/\s+/g, " ").trim().slice(0, limit);

export default function (pi) {
  const out = process.env.AI_REVIEW_FINDINGS;
  if (!out) throw new Error("AI_REVIEW_FINDINGS is not set; the finding tools have nowhere to write");

  let nextId = 1;
  let items = [];

  // Rewrite rather than append: an edit must not leave the superseded version in the file for the poster to read.
  const flush = () => writeFileSync(out, items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));

  const find = (id) => items.find((item) => item.id === id);
  const summary = (item) => `${item.id}  ${item.severity.padEnd(8)} ${item.path} — ${oneLine(item.body, 90)}`;

  pi.registerTool({
    name: "report_finding",
    label: "Report finding",
    description:
      "Record one review finding, anchored to a line of the change. Quote the line exactly as it appears in the file, " +
      "character for character: the quote is how the comment is placed, so a paraphrase cannot be posted. Returns an " +
      "id you can use with update_finding or withdraw_finding.",
    parameters: Type.Object({
      path: Type.String({ description: "File path exactly as it appears in the diff, e.g. src/services/events.ts" }),
      quote: Type.String({ description: "The exact text of the line, copied from the file, no line number" }),
      severity: SEVERITY,
      body: Type.String({ description: "One or two sentences: what is wrong and what it costs" }),
    }),
    async execute(_toolCallId, params) {
      const item = { id: `f${nextId++}`, ...params, at: Date.now() };
      items.push(item);
      flush();
      return {
        content: [{ type: "text", text: `recorded as ${item.id} (${items.length} finding(s) so far)` }],
        details: { id: item.id, recorded: items.length },
      };
    },
  });

  let lists = 0;

  pi.registerTool({
    name: "list_findings",
    label: "List findings",
    description:
      "List every finding recorded so far, with its id. Use this before finishing: the same defect stated twice is one " +
      "defect, and you are the only one who knows they are the same.",
    parameters: Type.Object({}),
    async execute() {
      lists += 1;
      const text = items.length ? items.map(summary).join("\n") : "no findings recorded yet";
      // A measured run listed 35 times, reporting and withdrawing the same finding in a circle, and did one read in the
      // whole window: the list had become the thing it was working on instead of the review. It is the same list every
      // time, so past the third read the tool says so, in the result the model actually reads.
      const nudge =
        lists > 3
          ? "\n\nThis is the same list you have already been given. Reporting a finding and withdrawing it again is not a " +
            "review: decide once, then finish. If nothing here is a defect you are confident in, report nothing."
          : "";
      return { content: [{ type: "text", text: text + nudge }], details: { count: items.length, lists } };
    },
  });

  pi.registerTool({
    name: "update_finding",
    label: "Update finding",
    description:
      "Change a finding you already recorded — merge a restatement into it, fix its wording, or correct its severity. " +
      "Only the fields you pass are changed.",
    parameters: Type.Object({
      id: Type.String({ description: "The id report_finding returned, e.g. f3" }),
      path: Type.Optional(Type.String({ description: "Replacement path" })),
      quote: Type.Optional(Type.String({ description: "Replacement quote, still character for character" })),
      severity: Type.Optional(SEVERITY),
      body: Type.Optional(Type.String({ description: "Replacement body" })),
    }),
    async execute(_toolCallId, params) {
      const item = find(params.id);
      if (!item) {
        return {
          content: [{ type: "text", text: `no finding ${params.id}; call list_findings to see the ids` }],
          isError: true,
        };
      }
      for (const key of ["path", "quote", "severity", "body"]) {
        if (params[key] !== undefined) item[key] = params[key];
      }
      flush();
      return { content: [{ type: "text", text: `updated ${item.id}: ${summary(item)}` }], details: { id: item.id } };
    },
  });

  pi.registerTool({
    name: "withdraw_finding",
    label: "Withdraw finding",
    description: "Remove a finding you recorded — a restatement of one you kept, or something you no longer think is a defect.",
    parameters: Type.Object({
      id: Type.String({ description: "The id report_finding returned, e.g. f5" }),
    }),
    async execute(_toolCallId, params) {
      const item = find(params.id);
      if (!item) {
        return {
          content: [{ type: "text", text: `no finding ${params.id}; call list_findings to see the ids` }],
          isError: true,
        };
      }
      items = items.filter((entry) => entry.id !== item.id);
      flush();
      return {
        content: [{ type: "text", text: `withdrew ${item.id} (${items.length} finding(s) remain)` }],
        details: { id: item.id, remaining: items.length },
      };
    },
  });
}
