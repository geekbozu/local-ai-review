// The event stream as a plain-text transcript.
//
// "Lean" means no JSON, no token-by-token deltas, no event envelopes — not less reasoning. The reasoning is the thing
// being tuned, so thinking and the assistant's own words are kept in full. What is dropped is duplicated framing:
// `--mode json` streams every token and then the finished message, so most of a trace is superseded fragments of the
// messages that follow, and almost all of the size reduction comes from that alone.
//
// One deliberate clip: tool *results*. A `read` returns a whole file, which can be re-read from the repo at the commit
// the run names, and it pushes the transcript past readable. The marker says how much was cut.

const RESULT = 800;

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

const clip = (s, n) => {
  const text = oneLine(s);
  return text.length <= n ? text : `${text.slice(0, n)} …(+${text.length - n} chars)`;
};

const argsBrief = (args = {}) =>
  Object.entries(args)
    .map(([k, v]) => `${k}=${oneLine(typeof v === "string" ? v : JSON.stringify(v))}`)
    .join(" ");

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
  let turn = 0;
  let turnStart = null;
  const totals = { out: 0, cached: 0, findings: 0, tools: {} };

  for (const event of events) {
    if (event.type === "turn_start") {
      turnStart = event.timestamp ?? null;
      continue;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      const u = m.usage || {};
      totals.out += u.output || 0;
      totals.cached += u.cacheRead || 0;
      turn += 1;

      const bits = [];
      if (turnStart && m.timestamp) bits.push(`${Math.round((m.timestamp - turnStart) / 1000)}s`);
      if (u.output != null) bits.push(`${u.output} out`);
      if (u.cacheRead) bits.push(`${u.cacheRead} cached`);
      if (m.stopReason) bits.push(m.stopReason);
      out.push(`--- turn ${turn} · ${bits.join(" · ")}`, "");

      for (const block of m.content || []) {
        if (block.type === "thinking") out.push(block.thinking?.trim() ? `[thinking]\n${block.thinking.trim()}\n` : "");
        else if (block.type === "text" && block.text?.trim()) out.push(`${block.text.trim()}\n`);
        else if (block.type === "toolCall") {
          const name = block.name ?? block.toolName ?? "?";
          totals.tools[name] = (totals.tools[name] || 0) + 1;
          if (name === "report_finding") totals.findings += 1;
          out.push(`[tool] ${name} ${argsBrief(block.arguments ?? block.args)}`);
        }
      }
      out.push("");
      continue;
    }

    if (event.type === "tool_execution_end") {
      const text = (event.result?.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ");
      out.push(`[result${event.isError ? " ERROR" : ""}] ${clip(text, RESULT)}\n`);
      continue;
    }
  }

  const tools = Object.entries(totals.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join(" ");
  out.push(
    "===",
    `${turn} turn(s) · ${totals.out} tokens out · ${totals.cached} cached · ${totals.findings} finding(s)` +
      (tools ? ` · ${tools}` : ""),
  );

  return out.join("\n");
}
