// The event stream as something a person reads.
//
// `--mode json` emits a delta per token and then the finished message, so 87% of a trace is superseded fragments of
// the 13% that matters. The trace is kept whole because bytes are cheap and a torn file is worse than a large one —
// this is the readable view of it: what the agent thought, what it ran, what came back, and what it decided.
//
// Thinking is kept in full. It is the thing being tuned: whether it wandered, whether it re-confirmed, whether it
// found the risk or only walked the diff.

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}\n…[${s.length - n} chars clipped]`);

const argsBrief = (args = {}) => {
  const entries = Object.entries(args);
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${String(text).replace(/\s+/g, " ").slice(0, 120)}`;
    })
    .join(" ");
};

export function renderTranscript(lines) {
  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const out = [];
  let turns = 0;
  let first = null;
  let last = null;

  for (const event of events) {
    if (event.type === "session") {
      out.push(`Session ${event.id || "?"} in ${event.cwd || "?"}`);
      out.push("");
      continue;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      const u = m.usage || {};
      const at = m.timestamp || event.timestamp;
      if (first && at) last = at;
      first = first ?? at;

      out.push(`### Turn ${turns + 1}`);
      const bits = [];
      if (u.output != null) bits.push(`${u.output} tokens out`);
      if (u.cacheRead) bits.push(`${u.cacheRead} cached`);
      if (u.input != null) bits.push(`${u.input} in`);
      if (m.stopReason) bits.push(`stop: ${m.stopReason}`);
      if (bits.length) out.push(`_${bits.join(" · ")}_`);

      for (const block of m.content || []) {
        if (block.type === "thinking") out.push(`> ${clip(block.thinking || "", 4000).replace(/\n/g, "\n> ")}`);
        else if (block.type === "text" && block.text?.trim()) out.push(block.text.trim());
        else if (block.type === "toolCall") {
          // pi's block carries name + arguments; the tool_execution events use toolName + args. Accept both so a
          // shape change renders as a name rather than as "undefined".
          const name = block.name ?? block.toolName ?? "?";
          out.push(`**→ ${name}** \`${argsBrief(block.arguments ?? block.args)}\``);
        }
      }
      out.push("");
      continue;
    }

    if (event.type === "tool_execution_end") {
      const result = (event.result?.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const mark = event.isError ? "**error**" : "result";
      out.push(`  _${mark} (${event.durationMs ?? "?"}ms)_ ${clip(result.replace(/\s+/g, " ").trim(), 300)}`);
      out.push("");
      continue;
    }

    if (event.type === "turn_end") turns += 1;
  }

  if (first && last) out.push(`---\n${turns} turn(s), ${Math.round((last - first) / 1000)}s of model time.`);
  else out.push(`---\n${turns} turn(s).`);

  return out.join("\n");
}
