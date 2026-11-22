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
const KEEP = Math.floor(LIMIT * 0.6);

const size = (content) =>
  (content || []).reduce((n, b) => n + (b.type === "text" ? String(b.text || "").length : 0), 0);

export default function (pi) {
  pi.on("tool_result", async (event) => {
    if (size(event.content) <= LIMIT) return;

    // Keep the head and the tail: the head carries the beginning of a file or command output, the tail carries the
    // error a command ended with. The middle is what a reader skips.
    const content = [];
    let seen = 0;

    for (const block of event.content || []) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      const text = String(block.text || "");
      if (seen < KEEP) {
        content.push({ ...block, text: text.slice(0, KEEP - seen) });
        seen += text.length;
        continue;
      }
      if (seen < LIMIT - KEEP) {
        const tail = text.slice(-(LIMIT - KEEP));
        content.push({ ...block, text: `\n\n[… ${text.length - (LIMIT - KEEP)} characters omitted …]\n\n${tail}` });
        seen = LIMIT;
      }
    }

    console.error(`[truncate] ${event.toolName}: ${size(event.content)} chars -> ${size(content)}`);
    return { content };
  });
}
