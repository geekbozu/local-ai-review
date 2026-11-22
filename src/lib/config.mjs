// Repo-agnostic by construction: everything specific to a repo comes from `.ai-review.json` at its root, and
// everything specific to a deployment comes from the action's inputs. No path in this file names a repo.
//
// No config file means no review. That is the opt-in: a file you can see in a diff, next to the decision to be
// reviewed, rather than a workflow someone copied by hand.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const CONFIG_FILE = ".ai-review.json";

const DEFAULTS = {
  rules: [], // paths or globs, relative to the repo root, read from the base ref
  ignore: [], // paths the review should not comment on
  // Repo-specific risk patterns (regular expressions, case-insensitive). The action's own defaults are domain
  // words only; anything naming a layout belongs here, in the repository that has that layout.
  riskHints: [],
  // Lines appended to the prompt verbatim. Anything a repository wants the reviewer told that is not a rule
  // file and not a risk pattern: what is out of scope here, what it should ignore, how this codebase works.
  instructions: [],
  severityFloor: "low", // low | medium | high | critical
  maxTurns: 60, // a runaway stop, not a tuning knob: high enough to be obviously too high
  thinking: "low", // off | minimal | low | medium | high
  model: null, // null = the action input decides
  // Everything the model call needs that is a property of the model rather than of the repository's policy. These are
  // the numbers that change when the model changes, so they belong where they can be edited without a release.
  modelSettings: {
    contextWindow: 262144,
    maxTokens: 65536, // the client's output budget: a ceiling against a runaway turn, not a review budget
    temperature: 0.6, // the serving card's recommendation for general tasks; too cold repeats an angle
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    reasoning: true, // does the template accept a thinking/reasoning parameter at all
    thinkingFormat: "openai", // how it is spelled: openai | qwen-chat-template | chat-template | none
  },
  // Character cap on a single tool result. A backstop against one whole-file read owning the run, not a reading policy.
  resultChars: 40000,
  // Wall clock in minutes, 0 = off. Effort is allocated by the turn budget; this is for a genuinely wedged run.
  timeBudgetMinutes: 0,
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

  return validate(raw, path);
}

// The poster reads the configuration from a commit, never from the working tree. The agent can write files, and the
// severity floor that decides what gets posted must not be one of them: an injected agent that raises the floor to
// `critical` suppresses its own findings. A PR's config change takes effect when it is merged, which is also when it
// would take effect for rules.
export function loadConfigFromRef(ref, dir = process.cwd()) {
  let text;
  try {
    text = execFileSync("git", ["-C", dir, "show", `${ref}:${CONFIG_FILE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${ref}:${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }

  return validate(raw, `${ref}:${CONFIG_FILE}`);
}

function validate(raw, path) {
  // Nested objects merge field by field: a repo that sets only `temperature` keeps every other default, which is
  // the difference between a config file and a trap.
  const config = {
    ...DEFAULTS,
    ...raw,
    modelSettings: { ...DEFAULTS.modelSettings, ...(raw.modelSettings || {}) },
    path,
  };
  if (config.enabled === false) return null;

  if (!Array.isArray(config.rules)) throw new Error(`${CONFIG_FILE}: rules must be an array of paths or globs`);
  if (!Array.isArray(config.ignore)) throw new Error(`${CONFIG_FILE}: ignore must be an array of paths or globs`);
  if (!Array.isArray(config.instructions) || config.instructions.some((i) => typeof i !== "string" || !i.trim())) {
    throw new Error(`${CONFIG_FILE}: instructions must be an array of non-empty strings`);
  }
  if (!Array.isArray(config.riskHints)) throw new Error(`${CONFIG_FILE}: riskHints must be an array of regular expressions`);
  for (const p of config.riskHints) {
    try {
      new RegExp(p);
    } catch {
      throw new Error(`${CONFIG_FILE}: riskHints contains an invalid regular expression: ${p}`);
    }
  }
  const numbers = ["contextWindow", "maxTokens", "temperature", "topP", "topK", "minP", "presencePenalty", "repeatPenalty"];
  for (const key of numbers) {
    const value = config.modelSettings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${CONFIG_FILE}: modelSettings.${key} must be a non-negative number`);
    }
  }
  if (!["openai", "qwen-chat-template", "chat-template", "none"].includes(config.modelSettings.thinkingFormat)) {
    throw new Error(`${CONFIG_FILE}: modelSettings.thinkingFormat must be openai, qwen-chat-template, chat-template or none`);
  }
  if (typeof config.modelSettings.reasoning !== "boolean") {
    throw new Error(`${CONFIG_FILE}: modelSettings.reasoning must be true or false`);
  }
  for (const key of ["resultChars", "timeBudgetMinutes"]) {
    if (!Number.isInteger(config[key]) || config[key] < 0) {
      throw new Error(`${CONFIG_FILE}: ${key} must be a non-negative integer`);
    }
  }
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
