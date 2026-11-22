// Rules come from the base ref, and pi-rules delivers them.
//
// The loading is the extension's job — it hooks before_agent_start and tool_result, matches each rule's `paths:` globs
// against the file being worked on, and injects what applies. Hand-rolling that produced a 12,313-character blob, 84%
// of the prompt, most of it about the local database stack and migrations the diff never touched.
//
// What the harness still has to do is make the extension read the *base* branch's rules. pi-rules discovers rules from
// the checkout, and the checkout is the PR — so a PR could edit the rules it is judged by, or add one. This restores
// the configured rule paths from the base ref and deletes any the PR added, before the review starts.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesAny } from "./config.mjs";

const git = (dir, args, options = {}) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

const list = (dir, args) =>
  git(dir, args)
    .split("\n")
    .filter(Boolean);

export function restoreRulesFromBase(dir, baseRef, config) {
  if (!config.rules.length) return { restored: [], removed: [] };

  const inBase = new Set(list(dir, ["ls-tree", "-r", "--name-only", baseRef]).filter((p) => matchesAny(p, config.rules)));
  const inHead = list(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).filter((p) => matchesAny(p, config.rules));

  const restored = [];
  for (const path of inBase) {
    const content = git(dir, ["show", `${baseRef}:${path}`]);
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    restored.push(path);
  }

  // A rule the PR adds would otherwise be loaded and obeyed, which is the whole reason this exists.
  const removed = [];
  for (const path of inHead) {
    if (inBase.has(path)) continue;
    const target = join(dir, path);
    if (existsSync(target)) rmSync(target, { force: true });
    removed.push(path);
  }

  return { restored, removed };
}
