// Turns `git diff -U<n>` into the line maps the poster needs: which new-file line numbers were added, and
// which are context. A review comment can only attach to one of those two, so this is the filter that decides
// whether a finding can be posted at all.

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Line endings are inconsistent by nature here: the checkout is Windows, the diff may be CRLF, mixed, or LF, and
// the model quotes whatever it read. Every comparison in this file and in the poster goes through one of these,
// so no code path depends on which ending turned up.
export const stripCr = (s) => (s.endsWith("\r") ? s.slice(0, -1) : s);
export const normalise = (s) => stripCr(String(s)).trimEnd();

export function parseDiff(text) {
  const files = new Map();
  let file = null;
  let newLine = 0;
  let oldLine = 0;
  let hunkSeen = false;

  for (const line of text.split("\n")) {
    const raw = stripCr(line);
    const header = FILE_HEADER.exec(raw);
    if (header) {
      file = { path: normalise(header[2]), added: [], context: [], removed: [] };
      files.set(file.path, file);
      hunkSeen = false;
      continue;
    }
    if (!file) continue;
    // Everything before a hunk is metadata: `index`, `old mode`, `new file mode`, `rename from/to`, `similarity index`,
    // `Binary files ... differ`. Any of it landing in `context` invents a line number, and a quote matching that text
    // would anchor a finding to line 1.
    if (!hunkSeen && !HUNK.test(raw)) continue;
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ")) continue;

    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunkSeen = true;
      continue;
    }

    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      file.added.push({ line: newLine++, text: normalise(raw.slice(1)) });
      continue;
    }
    if (raw.startsWith("-")) {
      // Removed lines keep their old-file numbers: an explicit line anchor has to know when a number names two
      // different lines at once, one on each side of the hunk.
      file.removed.push({ line: oldLine++, text: normalise(raw.slice(1)) });
      continue;
    }
    // A context line occupies a line in both files, so both counters advance — leaving oldLine put shifted every
    // later removed line's old-file number, and resolveLine's clash check with it.
    oldLine += 1;
    file.context.push({ line: newLine++, text: normalise(raw.startsWith(" ") ? raw.slice(1) : raw) });
  }

  return files;
}

// A finding is anchored by the text it quotes, never by a number the model counted. Trailing whitespace and
// line endings are ignored on both sides, because neither survives a round trip through a model reliably.
// Full match first, then leading-whitespace-insensitive — each only when it lands on exactly one line, because
// two candidates is the same failure as none and is dropped rather than guessed.
export function resolveQuote(files, path, quote) {
  const file = files.get(normalise(path));
  if (!file) return null;

  const candidates = [
    ...file.added.map((l) => ({ ...l, side: "added" })),
    ...file.context.map((l) => ({ ...l, side: "context" })),
  ];

  // A model quoting two lines is quoting the line it means plus the one under it. Only the first can carry the
  // anchor, and the uniqueness rules below still refuse to guess. Dropping multi-line quotes instead lost the one
  // medium finding on the planted-defect run — it was reported, correct, and thrown away at posting.
  const wanted = normalise(String(quote).split("\n")[0]);
  if (!wanted) return null;

  const match = (wanted) => {
    const exact = candidates.filter((c) => normalise(c.text) === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const loose = wanted.trimStart();
    const trimmed = candidates.filter((c) => normalise(c.text).trimStart() === loose);
    return trimmed.length === 1 ? trimmed[0] : null;
  };

  // A model quoting from `git diff` output carries the diff's own prefix (`+  const x = …`), which never matches the
  // file. The quote as given is tried first — so a line that really begins with `- ` still matches itself — and one
  // prefix with its optional space is the only tolerance beyond whitespace.
  return match(wanted) || (/^[+-]/.test(wanted) ? match(wanted.replace(/^[+-] ?/, "")) : null);
}

// An explicit line number is weaker evidence than a quote, so it is only trusted when it names exactly one line. A
// number that is also a removed line on the minus side of the hunk — the model may have counted the old file — is two
// different lines at once when their text differs, and that refuses rather than guesses.
export function resolveLine(files, path, line) {
  const file = files.get(normalise(path));
  if (!file) return null;
  const n = Number(line);
  if (!Number.isInteger(n) || n < 1) return null;
  const hits = [
    ...file.added.filter((l) => l.line === n).map((l) => ({ ...l, side: "added" })),
    ...file.context.filter((l) => l.line === n).map((l) => ({ ...l, side: "context" })),
  ];
  if (hits.length !== 1) return null;
  const clash = file.removed.some((l) => l.line === n && normalise(l.text) !== hits[0].text);
  return clash ? null : hits[0];
}

// Every file the diff touches. The coverage gate asks which of these the agent never opened, so a review that
// read one third of a change cannot present itself as a review of the change.
export function touchedPaths(files) {
  return [...files.keys()];
}

// The size of the change, per file and in total. A file list says what was touched; this says how much, which is what
// an agent needs to decide whether to read around or read the file.
export function diffStats(files) {
  const perFile = [...files.values()].map((f) => ({
    path: f.path,
    added: f.added.length,
    removed: f.removed.length,
  }));
  // perFile.removed is already a count; reading .length off it summed undefined and produced NaN.
  const total = perFile.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 });
  return { perFile, total };
}
