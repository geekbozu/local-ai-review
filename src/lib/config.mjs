// Repo-agnostic by construction: everything specific to a repo comes from `.ai-review.json` at its root, and
// everything specific to a deployment comes from the action's inputs. No path in this file names a repo.
//
// No config file means no review. That is the opt-in: a file you can see in a diff, next to the decision to be
// reviewed, rather than a workflow someone copied by hand.

import { readFileSync, existsSync } from "node:fs";

export const CONFIG_FILE = ".ai-review.json";

const DEFAULTS = {
  rules: [], // paths or globs, relative to the repo root, read from the base ref
  ignore: [], // paths the review should not comment on
  severityFloor: "low", // low | medium | high | critical
  maxTurns: 60, // a runaway stop, not a tuning knob: high enough to be obviously too high
  thinking: "low", // off | minimal | low | medium | high
  model: null, // null = the action input decides
};

export function loadConfig(dir = process.cwd()) {
  const path = `${dir}/${CONFIG_FILE}`;
  if (!existsSync(path)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }

  const config = { ...DEFAULTS, ...raw, path };
  if (config.enabled === false) return null;

  if (!Array.isArray(config.rules)) throw new Error(`${CONFIG_FILE}: rules must be an array of paths or globs`);
  if (!Array.isArray(config.ignore)) throw new Error(`${CONFIG_FILE}: ignore must be an array of paths or globs`);
  if (!["low", "medium", "high", "critical"].includes(config.severityFloor)) {
    throw new Error(`${CONFIG_FILE}: severityFloor must be low, medium, high or critical`);
  }
  if (!["off", "minimal", "low", "medium", "high"].includes(config.thinking)) {
    throw new Error(`${CONFIG_FILE}: thinking must be off, minimal, low, medium or high`);
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    throw new Error(`${CONFIG_FILE}: maxTurns must be a positive integer`);
  }

  return config;
}

// Globs are deliberately tiny: `**` and `*` only. A dependency for brace expansion or negation would be the
// largest thing in this repo, and the alternative — listing rule files explicitly — is always available.
//
// Escaped and expanded in one pass on purpose: substituting `**` first and `*` after rewrites the `.*` that the
// first substitution inserted, which silently turned `Docs/**` into `Docs/.[^/]*`.
const globToRegExp = (glob) => {
  const special = /[.+^${}()|[\]\\]/;
  let pattern = "";

  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      pattern += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      pattern += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      pattern += "[^/]*";
      i += 1;
    } else {
      pattern += special.test(glob[i]) ? `\\${glob[i]}` : glob[i];
      i += 1;
    }
  }

  return new RegExp(`^${pattern}$`);
};

export function matchesAny(path, globs) {
  return globs.some((g) => {
    if (!g.includes("*")) return path === g || path.startsWith(`${g.replace(/\/$/, "")}/`);
    return globToRegExp(g).test(path);
  });
}

// A rule file with `paths:` frontmatter applies only to matching files; one without applies to the whole review.
// This is the same test pi-rules applies, so the reviewer and the coding agent judge by the same selection.
export function ruleApplies(content, file) {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fence) return true;

  const paths = /^paths:\s*\r?\n((?:\s*-\s*.*\r?\n?)+)/m.exec(fence[1]);
  if (!paths) return true;

  const globs = paths[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  return globs.length === 0 || matchesAny(file, globs);
}
