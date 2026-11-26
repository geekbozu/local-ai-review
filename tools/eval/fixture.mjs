// A fixture is `base/` and `head/` plus `expect.json`: the harness commits base, then head, so every run sees the same
// diff and can be scored against the defects that are known to be in it. A real repository is fine for smoke tests and
// useless for comparison — its diff moves between sweeps. Extracted from tools/eval.mjs so a test can build one too.

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export const fixtureDir = (name) => join(here, "fixtures", name);

export function buildFixture(name) {
  const dir = fixtureDir(name);
  const work = mkdtempSync(join(tmpdir(), "fixture-"));
  const copy = (from, to) => execFileSync("cp", ["-a", `${from}/.`, to], { stdio: "ignore" });
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { stdio: "ignore" });
  copy(join(dir, "base"), work);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "eval@example.com");
  git("config", "user.name", "eval");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  copy(join(dir, "head"), work);
  git("add", "-A");
  git("commit", "-qm", "change");
  return { work, expect: JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) };
}
