import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCommit,
  scoreFile,
  isFixSubject,
  WEIGHTS,
  NEGATIVE_KEYWORDS,
} from "../lib/test-value-audit-lib.mjs";

/*
FNXC:TestInfrastructure 2026-06-25-00:00:
Unit coverage for the test-value-audit classifier. Feeds synthetic commit records and
asserts the scoring so the heuristic's behavior is pinned independent of git/FS IO.
*/

// --- isFixSubject ---
test("isFixSubject matches conventional fix subjects incl. fix(FN-XXXX)", () => {
  assert.ok(isFixSubject("fix(FN-1234): correct merge race"));
  assert.ok(isFixSubject("fix: handle null"));
  assert.ok(isFixSubject("fix!: breaking repair"));
  assert.ok(!isFixSubject("feat(FN-1): add thing"));
  assert.ok(!isFixSubject("prefix change"));
});

// --- classifyCommit positive signals ---
test("fix subject + source change is strongest positive", () => {
  const c = classifyCommit({ subject: "fix(FN-9): bug", body: "", status: "M", touchedSource: true });
  assert.equal(c.category, "positive");
  assert.equal(c.weight, WEIGHTS.fixWithSource);
  assert.ok(c.signals.includes("fix+source"));
});

test("fix subject without source change is a weaker positive", () => {
  const c = classifyCommit({ subject: "fix: bug", body: "", status: "M", touchedSource: false });
  assert.equal(c.weight, WEIGHTS.fix);
  assert.ok(c.signals.includes("fix"));
});

test("symptom verification marker adds positive weight on top of fix", () => {
  const c = classifyCommit({
    subject: "fix(FN-5893): invariant",
    body: "## Symptom Verification\nOriginal symptom: ...",
    status: "M",
    touchedSource: true,
  });
  assert.equal(c.weight, WEIGHTS.fixWithSource + WEIGHTS.symptomVerification);
  assert.ok(c.signals.includes("symptom-verification"));
});

test("added with source is positive; added alone is weak positive", () => {
  const withSrc = classifyCommit({ subject: "feat: x", status: "A", touchedSource: true });
  assert.equal(withSrc.weight, WEIGHTS.addedWithSource);
  assert.ok(withSrc.signals.includes("added-with-source"));

  const alone = classifyCommit({ subject: "test: x", status: "A", touchedSource: false });
  assert.equal(alone.weight, WEIGHTS.added);
  assert.ok(alone.signals.includes("added"));
});

test("non-fix test+source modify is a mild positive", () => {
  const c = classifyCommit({ subject: "refactor: rework", status: "M", touchedSource: true });
  assert.equal(c.weight, WEIGHTS.testPlusSource);
  assert.ok(c.signals.includes("test+source"));
});

// --- classifyCommit negative signals ---
test("flake/quarantine keywords produce negative weight", () => {
  for (const kw of NEGATIVE_KEYWORDS) {
    const c = classifyCommit({ subject: `chore: ${kw} the test`, status: "M", touchedSource: false });
    assert.ok(c.weight <= WEIGHTS.churnKeyword, `keyword ${kw} should be negative`);
    assert.ok(c.signals.includes("churn-keyword"));
  }
});

test("test-only modify (no source, no fix) is churn", () => {
  const c = classifyCommit({ subject: "chore: tidy assertions", status: "M", touchedSource: false });
  assert.equal(c.category, "negative");
  assert.equal(c.weight, WEIGHTS.testOnlyChurn);
  assert.ok(c.signals.includes("test-only-churn"));
});

test("a fix that also mentions a churn keyword nets toward neutral (mixed signal)", () => {
  const c = classifyCommit({
    subject: "fix(FN-1): widen timeout to stabilize merge",
    status: "M",
    touchedSource: true,
  });
  // churnKeyword(-3) + fixWithSource(+3) = 0 -> neutral, both signals recorded.
  assert.equal(c.weight, 0);
  assert.equal(c.category, "neutral");
  assert.ok(c.signals.includes("churn-keyword"));
  assert.ok(c.signals.includes("fix+source"));
});

// --- scoreFile aggregation ---
test("scoreFile sums weights and recommends keep for net-positive files", () => {
  const commits = [
    classifyCommit({ subject: "test: add", status: "A", touchedSource: true }), // +2
    classifyCommit({ subject: "fix(FN-2): real bug", status: "M", touchedSource: true }), // +3
  ];
  const s = scoreFile({ commits, durationMs: 500, testCount: 4 });
  assert.equal(s.valueScore, 5);
  assert.equal(s.positiveCount, 2);
  assert.equal(s.recommendation, "keep");
  assert.equal(s.safeDelete, false);
});

test("scoreFile recommends delete + safeDelete for pure churn with no positives", () => {
  const commits = [
    classifyCommit({ subject: "chore: tweak", status: "M", touchedSource: false }), // -1
    classifyCommit({ subject: "chore: deflake", status: "M", touchedSource: false }), // -3 (and -1 churn? no: keyword path only)
  ];
  const s = scoreFile({ commits, durationMs: 9000, testCount: 3 });
  assert.ok(s.valueScore < 0);
  assert.equal(s.positiveCount, 0);
  assert.equal(s.recommendation, "delete");
  assert.equal(s.safeDelete, true);
});

test("quarantine ledger membership forces delete and applies the penalty", () => {
  const commits = [classifyCommit({ subject: "fix(FN-3): bug", status: "M", touchedSource: true })]; // +3
  const s = scoreFile({ commits, durationMs: 100, testCount: 2, quarantined: true });
  // +3 then -5 quarantine = -2 => delete; but positiveCount=1 so NOT safeDelete.
  assert.equal(s.valueScore, WEIGHTS.fixWithSource + WEIGHTS.quarantineLedger);
  assert.equal(s.recommendation, "delete");
  assert.equal(s.quarantined, true);
  assert.equal(s.safeDelete, false);
});

test("deletionPriority surfaces slow + low-value above slow + valuable", () => {
  const lowValueSlow = scoreFile({
    commits: [classifyCommit({ subject: "chore: tweak", status: "M", touchedSource: false })],
    durationMs: 10_000,
    testCount: 1,
  });
  const highValueSlow = scoreFile({
    commits: [
      classifyCommit({ subject: "fix(FN-4): bug", status: "M", touchedSource: true }),
      classifyCommit({ subject: "fix(FN-5): bug2", status: "M", touchedSource: true }),
    ],
    durationMs: 10_000,
    testCount: 1,
  });
  assert.ok(
    lowValueSlow.deletionPriority > highValueSlow.deletionPriority,
    "low-value slow file must outrank high-value slow file",
  );
});

test("missing duration yields zero deletionPriority (unknown cost)", () => {
  const s = scoreFile({
    commits: [classifyCommit({ subject: "chore: tweak", status: "M", touchedSource: false })],
    durationMs: null,
    testCount: 1,
  });
  assert.equal(s.deletionPriority, 0);
  assert.equal(s.durationMs, null);
});

test("testOnlyRatio reflects churn fraction", () => {
  const commits = [
    classifyCommit({ subject: "test: add", status: "A", touchedSource: true }), // not churn
    classifyCommit({ subject: "chore: tidy", status: "M", touchedSource: false }), // churn
    classifyCommit({ subject: "chore: tidy2", status: "M", touchedSource: false }), // churn
  ];
  const s = scoreFile({ commits, durationMs: 1, testCount: 1 });
  assert.equal(s.testOnlyCount, 2);
  assert.equal(s.testOnlyRatio, Number((2 / 3).toFixed(3)));
});
