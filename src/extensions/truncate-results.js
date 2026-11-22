// Keeps a tool result from eating the context.
//
// Measured on a real review: 25 turns, tool results totalling 101,669 characters, and one `read` of a long ledger
// document returned 50,913 of them — for a file that was not even the subject. Every character of that travels in
// the prompt on every later turn, so a single careless read is paid for repeatedly at ~27 tokens a second.
//
// Truncation is the harness's job rather than the prompt's: the agent cannot know the size of what it is asking for,
// and an instruction to "read carefully" has no bound. What is cut is stated in the result, so the model can ask a
// narrower question instead of assuming it has the whole file.

const LIMIT = Number(process.env.AI_REVIEW_RESULT_CHARS || 8000);
const MARKER_ROOM = 120;

const size = (content) =>
  (content || []).reduce((n, b) => n + (b.type === "text" ? String(b.text || "").length : 0), 0);

export default function (pi) {
  pi.on("tool_result", async (event) => {
    const before = size(event.content);
    if (before <= LIMIT) return;

    const content = [];
    let emitted = 0;
    let truncated = false;

    for (const block of event.content || []) {
      if (truncated) break;
      if (block.type !== "text") {
        content.push(block);
        continue;
      }

      const text = String(block.text || "");
      const remaining = LIMIT - emitted;
      if (text.length <= remaining) {
        content.push(block);
        emitted += text.length;
        continue;
      }

      // This block alone overflows what is left: keep its head and its tail, because the head is where a file starts
      // and the tail is where a command's error ends. The middle is what a reader skips anyway.
      const headLength = Math.max(0, Math.floor((remaining - MARKER_ROOM) * 0.6));
      const tailLength = Math.max(0, remaining - MARKER_ROOM - headLength);
      const head = text.slice(0, headLength);
      const tail = tailLength ? text.slice(-tailLength) : "";
      const omitted = text.length - head.length - tail.length;

      content.push({ ...block, text: `${head}\n\n[… ${omitted} characters omitted …]\n\n${tail}` });
      emitted = LIMIT;
      truncated = true;
    }

    console.error(`[truncate] ${event.toolName}: ${before} chars -> ${size(content)} (limit ${LIMIT})`);
    return { content };
  });
}
