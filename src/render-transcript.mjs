// Render a trace that already exists.
//
// The transcript used to be produced only at the end of a run, which meant a cancelled or killed job — the run you
// most want to read — left 45 MB of JSONL and no readable view. This runs as its own step under `if: always()`, so a
// kill still yields the transcript.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { renderTranscript } from "./lib/transcript.mjs";

const events = process.argv[2] || process.env.EVENTS_FILE;
const out = process.argv[3] || process.env.TRANSCRIPT_FILE || (events && join(dirname(events), "ai-review-transcript.md"));

if (!events || !existsSync(events)) {
  console.log(`No event stream at ${events ?? "(unset)"}: nothing to render.`);
  process.exit(0);
}

const lines = readFileSync(events, "utf8").split(String.fromCharCode(10));
writeFileSync(out, renderTranscript(lines));
console.log(`Wrote ${out} from ${lines.length} event(s).`);
