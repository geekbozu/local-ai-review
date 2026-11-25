// The event stream, written as it arrives.
//
// Buffering it and writing once at the end looks equivalent and is not: the runs worth tuning from are the ones that
// end badly, and a job killed at its timeout or a board that drops leaves nothing behind if the file is written last.
// One chunk in, one chunk out, so whatever happened is on disk before the process dies.
//
// Deliberately not a chained promise: a pending write must not delay the next chunk, and JSONL tolerance means a torn
// last line is a line the reader skips rather than a file that is lost.

import { createWriteStream } from "node:fs";

export function openTrace(file) {
  const stream = createWriteStream(file, { flags: "w" });

  return {
    path: file,
    write: (chunk) => stream.write(chunk),
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}
