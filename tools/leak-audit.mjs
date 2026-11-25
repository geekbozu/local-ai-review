#!/usr/bin/env node
// What would a public copy of this repo leak?
//
// The built-in patterns are deliberately generic: addresses, absolute user paths, credential shapes. Anything
// specific to one operator's network or organisation belongs in .leak-audit.local.json, which is git-ignored, so
// this file can be published without naming the things it is meant to catch.
//
//   { "terms": ["example.internal", "example-org"] }
//
// Exits non-zero when it finds something, so it can be a pre-publish check.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const LOCAL = ".leak-audit.local.json";
const SELF = "tools/leak-audit.mjs"; // this file discusses patterns by design

const patterns = [
  // Loopback is not a leak: a bound socket has to name something. Each private range names all of its octets — the
  // first version wrote `192\.168` and then asked for three more groups, so `192.168.68.82` and `172.16.4.9` both
  // passed and only a four-group address was caught.
  [
    "private address",
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/,
  ],
  ["absolute user path", /[A-Za-z]:[\\/](?:Users|home)[\\/][^\s"')]+/],
  ["credential shape", /\b(?:sk-|ghp_|gho_|github_pat_|xox[abp]-)[A-Za-z0-9_-]{10,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

if (existsSync(LOCAL)) {
  const { terms = [] } = JSON.parse(readFileSync(LOCAL, "utf8"));
  for (const term of terms) patterns.push([`listed term: ${term}`, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]);
}

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

let hits = 0;
for (const file of files) {
  if (file === SELF) continue;
  let text;
  try {
    // The working tree, not HEAD: this runs before a commit, on the copy about to be published.
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const [label, re] of patterns) {
      if (re.test(line)) {
        hits++;
        console.log(`${file}:${i + 1}  [${label}]  ${line.trim().slice(0, 140)}`);
        break;
      }
    }
  });
}

console.log(hits ? `\n${hits} line(s) to consider before publishing.` : "Nothing found.");
process.exit(hits ? 1 : 0);
