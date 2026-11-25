// One manual run against the fixture, with the container's output passed through, so a client failure is legible.
// Usage: node tools/eval/one.mjs <model> [thinking]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = process.argv[2];
const thinking = process.argv[3] || "off";
const repo = process.cwd();
const fixture = join(repo, "tools", "eval", "fixtures", "vending-supabase");
const host = (p) => p.split("\\").join("/");

const work = mkdtempSync(join(tmpdir(), "one-"));
execFileSync("cp", ["-a", join(fixture, "base"), work + "/"]);
const git = (...a) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.email", "e@x");
git("config", "user.name", "e");
git("add", "-A");
git("commit", "-qm", "base");
git("update-ref", "refs/remotes/origin/main", "HEAD");
execFileSync("cp", ["-a", join(fixture, "head"), work + "/"]);
git("add", "-A");
git("commit", "-qm", "change");

writeFileSync(
  join(work, ".ai-review.json"),
  JSON.stringify({
    rules: [],
    severityFloor: "low",
    model,
    thinking,
    maxTurns: 20,
    modelSettings: {
      contextWindow: 131072,
      maxTokens: 16384,
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repeatPenalty: 1,
      reasoning: false,
      thinkingFormat: "chat-template",
    },
  }),
);

console.log(`work: ${work}`);
const run = execFileSync(
  "docker",
  [
    "run", "--rm",
    "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_PTRACE",
    "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
    "-v", `${host(work)}:/work`,
    "-v", `${host(repo)}:/action:ro`,
    "-w", "/work",
    "-e", `AI_REVIEW_BASE_URL=${process.env.AI_REVIEW_BASE_URL}`,
    "-e", `AI_REVIEW_API_KEY=${process.env.AI_REVIEW_API_KEY}`,
    "-e", "BASE_REF=origin/main",
    "-e", "GITHUB_WORKSPACE=/work",
    "-e", "RUNNER_TEMP=/work/.eval",
    "-e", "FINDINGS_FILE=/work/.eval/f.jsonl",
    "-e", "EVENTS_FILE=/work/.eval/e.jsonl",
    "ai-review-eval",
    "sh", "-c", "mkdir -p /work/.eval && node /action/src/review.mjs",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
console.log(run);
try {
  console.log("findings:\n" + readFileSync(join(work, ".eval", "f.jsonl"), "utf8"));
} catch {
  console.log("no findings file");
}
