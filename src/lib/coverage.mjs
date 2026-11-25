// Did the review actually look at the whole change?
//
// `pi --mode json` reports every tool call, so this is answered from the event stream rather than from the model
// saying it read everything. Only `read` counts: a `grep` hit proves the agent saw a line, not the file.

import { readFileSync } from "node:fs";
import { normalise } from "./diff.mjs";

const BACKSLASH = String.fromCharCode(92); // kept out of a literal so no layer of quoting can eat it

// A path from a tool call and a path from a diff have to compare equal, and they arrive in different shapes:
// `read` may report a repo-relative path, one with `./`, a Windows path with backslashes, or an absolute path
// under the checkout. Everything here is one repo, so the root is stripped when known and the result is
// repo-relative like the diff.
export function normalisePath(p, root = "") {
  let out = normalise(String(p)).split(BACKSLASH).join("/").replace(/^\.\//, "");
  const base = root ? normalise(String(root)).split(BACKSLASH).join("/").replace(/\/$/, "") : "";
  if (base && out.startsWith(base + "/")) out = out.slice(base.length + 1);
  return out.replace(/^\//, "");
}

const fileOf = (call) => {
  const p = call?.args?.path ?? call?.args?.file_path ?? call?.args?.file;
  return typeof p === "string" ? p : null;
};

export function openedFiles(jsonlPath, { root = "" } = {}) {
  const opened = new Set();
  let turns = 0;

  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line); // \r is legal trailing whitespace in JSON, so a CRLF stream parses
    } catch {
      continue;
    }
    if (event.type === "turn_end") turns++;
    if (event.type !== "tool_execution_start") continue;
    if (event.toolName !== "read") continue;
    const file = fileOf(event);
    if (file) opened.add(normalisePath(file, root));
  }

  return { opened, turns };
}

export function uncovered(touched, opened, root = "") {
  return touched.map((p) => normalisePath(p, root)).filter((p) => !opened.has(p));
}
