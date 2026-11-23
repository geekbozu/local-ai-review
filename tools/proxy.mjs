// A logging proxy, for checking what Pi actually puts on the wire. Not shipped: it exists so a claim about
// request parameters (does thinking level become reasoning_effort?) and about prefix-cache hits per turn can be
// answered from a log instead of from the schema.
//
//   UPSTREAM=http://localhost:8080 PROXY_LOG=out/requests.jsonl node tools/proxy.mjs 8787

import http from "node:http";
import { appendFileSync } from "node:fs";

const UPSTREAM = process.env.UPSTREAM;
const LOG = process.env.PROXY_LOG;
const PORT = Number(process.argv[2] || 8787);

if (!UPSTREAM || !LOG) {
  console.error("set UPSTREAM and PROXY_LOG");
  process.exit(1);
}

const summarise = (url, body) => {
  let j = {};
  try {
    j = JSON.parse(body.toString("utf8"));
  } catch {
    return { url, bytes: body.length };
  }
  return {
    url,
    model: j.model,
    stream: j.stream,
    // what we are trying to prove is sent, and what we are trying to prove is not
    reasoning_effort: j.reasoning_effort,
    thinking: j.thinking,
    chat_template_kwargs: j.chat_template_kwargs,
    temperature: j.temperature,
    max_tokens: j.max_tokens,
    tool_choice: j.tool_choice,
    tools: Array.isArray(j.tools) ? j.tools.map((t) => t.function?.name) : undefined,
    messages: Array.isArray(j.messages)
      ? j.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content.length : "parts"}`)
      : undefined,
    bytes: body.length,
    // Replayable: a summary proves what was sent, the body lets the same request be re-sent to compare.
    raw: body.toString("utf8"),
  };
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    appendFileSync(LOG, JSON.stringify(summarise(req.url, body)) + "\n");

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["accept-encoding"]; // let Node fetch hand us plain text so the proxy can stream it on
    delete headers["content-length"];

    let up;
    try {
      up = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }

    const out = Object.fromEntries(up.headers);
    delete out["content-encoding"];
    delete out["content-length"];
    res.writeHead(up.status, out);
    if (up.body) {
      for await (const chunk of up.body) res.write(chunk);
    }
    res.end();
  })
  .listen(PORT, process.env.HOST || "127.0.0.1", () =>
    console.error(`proxy on http://${process.env.HOST || "127.0.0.1"}:${PORT} -> ${UPSTREAM}`),
  );
