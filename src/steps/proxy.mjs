// The endpoint key, held by a process the agent cannot read.
//
// The child's environment is whatever we build for it, so anything in there is readable by anything it runs. The proxy
// listens on loopback, accepts one per-run token, and knows the real key.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

export async function startKeyProxy({ target, realKey }) {
  const token = randomBytes(24).toString("hex");
  const base = target.replace(/\/+$/, "");

  const server = createServer(async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: { message: "unauthorized" } });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    // The base URL already ends at /v1 and pi appends /chat/completions to it, so a path that carries its own /v1 is
    // not duplicated.
    const path = base.endsWith("/v1") && req.url.startsWith("/v1") ? req.url.slice(3) : req.url;
    try {
      const upstream = await fetch(base + path, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          authorization: `Bearer ${realKey}`,
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      reply(502, { error: { message: String(err && err.message) } });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // An `http` server keeps the event loop alive, so the whole review finished, printed its summary and then hung until
  // the job was cancelled. Unref'd, it still answers while the child is alive and cannot outlive the work.
  server.unref();
  return { server, token, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// The shared agent dir holds pi's package cache, so a board pays for it once. It is never handed to the sandbox: a
