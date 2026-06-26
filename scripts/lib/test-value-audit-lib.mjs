/*
FNXC:TestInfrastructure 2026-06-25-00:00:
Heuristic "test value audit" scoring library. Pure functions only — all git/FS IO
lives in scripts/test-value-audit.mjs so the classification logic stays unit-testable
with synthetic commit records.

Why this exists (requirement): the suite has rotted before (FN-5048 slow tests, the
quarantine deletion-ratchet in AGENTS.md). We want a data-driven signal for WHICH test
files have actually encoded real bugs vs. only ever churned/flaked, so a human can drive
aggressive deletion of low-signal-yet-slow tests. This is a HEURISTIC, never ground truth:
git history is lossy (renames, squashes), commit subjects lie, and a quiet test can still
be load-bearing. Treat the output as evidence, not a verdict.

Scoring model (transparent + auditable on purpose):
- POSITIVE signal = the commit encoded/caught a real behavioral bug. Strongest when a
  `fix(...)` / `fix:` subject lands alongside a sibling SOURCE change, or carries a
  `## Symptom Verification` regression marker (FN-5893), or the test file was first ADDED
  together with source.
- NEGATIVE signal = low value / churn. Commits whose subject/body mention flake words
  (flake/quarantine/stabiliz/appease/timeout/retry/flaky/deflake) or that repeatedly
  touch ONLY the test file with no source change. Appearing in the quarantine ledger
  history is the strongest negative.
*/

/** Churn / appeasement keywords. A commit mentioning any of these is a negative signal. */
export const NEGATIVE_KEYWORDS = [
  "flake",
  "flaky",
  "deflake",
  "quarantine",
  "stabiliz", // stabilize / stabilization / stabilise
  "appease",
  "timeout",
  "retry",
];

/** Per-commit signed weights. Documented so the report can explain every score. */
export const WEIGHTS = {
  churnKeyword: -3,
  fixWithSource: 3,
  fix: 2,
  symptomVerification: 3,
  addedWithSource: 2,
  added: 1,
  testPlusSource: 1.5,
  testOnlyChurn: -1,
  quarantineLedger: -5,
};

/** Recommendation thresholds on the final summed value score. */
export const THRESHOLDS = {
  delete: 0, // valueScore <= 0 => delete candidate
  review: 3, // 0 < valueScore <= 3 => review
  // valueScore > 3 => keep
};

/**
 * True when the subject is a conventional `fix(...)` / `fix:` / `fix!:` commit.
 * The repo convention is `fix(FN-XXXX):` so this also captures task bug fixes.
 * @param {string} subject
 */
export function isFixSubject(subject) {
  return /^\s*fix(\(|:|!)/i.test(subject ?? "");
}

/**
 * Classify a single commit that touched a given test file.
 *
 * @param {object} record
 * @param {string} [record.subject] commit subject line
 * @param {string} [record.body] commit body
 * @param {string} [record.status] git name-status of the TEST file in this commit ("A","M","D","R"...)
 * @param {boolean} [record.touchedSource] did the commit also change a non-test source file in the same package?
 * @returns {{category:"positive"|"negative"|"neutral", weight:number, signals:string[]}}
 */
export function classifyCommit(record) {
  const subject = record.subject ?? "";
  const body = record.body ?? "";
  const status = record.status ?? "M";
  const touchedSource = Boolean(record.touchedSource);
  const text = `${subject}\n${body}`.toLowerCase();

  const isAdd = status.startsWith("A");
  const isFix = isFixSubject(subject);
  const hasSymptom = /symptom verification/i.test(body) || /symptom verification/i.test(subject);
  const churnKeyword = NEGATIVE_KEYWORDS.some((k) => text.includes(k));

  let weight = 0;
  const signals = [];

  if (churnKeyword) {
    weight += WEIGHTS.churnKeyword;
    signals.push("churn-keyword");
  }

  if (isFix && touchedSource) {
    weight += WEIGHTS.fixWithSource;
    signals.push("fix+source");
  } else if (isFix) {
    weight += WEIGHTS.fix;
    signals.push("fix");
  }

  if (hasSymptom) {
    weight += WEIGHTS.symptomVerification;
    signals.push("symptom-verification");
  }

  if (isAdd && touchedSource) {
    weight += WEIGHTS.addedWithSource;
    signals.push("added-with-source");
  } else if (isAdd) {
    weight += WEIGHTS.added;
    signals.push("added");
  }

  // Test+source co-change (non-fix, non-add modify) is real behavioral coverage.
  if (!isAdd && !isFix && touchedSource) {
    weight += WEIGHTS.testPlusSource;
    signals.push("test+source");
  }

  // A modify that touched ONLY the test file (no source, not a fix, not the add) is churn.
  if (!isAdd && !isFix && !touchedSource && !hasSymptom) {
    weight += WEIGHTS.testOnlyChurn;
    signals.push("test-only-churn");
  }

  let category = "neutral";
  if (weight > 0) category = "positive";
  else if (weight < 0) category = "negative";

  return { category, weight, signals };
}

/**
 * Aggregate per-commit classifications into a file-level value score + recommendation.
 *
 * @param {object} input
 * @param {Array<{category:string, weight:number, signals:string[]}>} input.commits classified commits
 * @param {number|null} [input.durationMs] per-file test duration from scripts/test-timings.json
 * @param {number} [input.testCount] number of it()/test() cases in the file
 * @param {boolean} [input.quarantined] does the file appear in the quarantine ledger (current or historical)?
 */
export function scoreFile({ commits = [], durationMs = null, testCount = 0, quarantined = false }) {
  let valueScore = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let neutralCount = 0;
  let testOnlyCount = 0;
  const signalTally = {};

  for (const c of commits) {
    valueScore += c.weight;
    if (c.category === "positive") positiveCount += 1;
    else if (c.category === "negative") negativeCount += 1;
    else neutralCount += 1;
    for (const s of c.signals ?? []) {
      signalTally[s] = (signalTally[s] ?? 0) + 1;
      if (s === "test-only-churn") testOnlyCount += 1;
    }
  }

  if (quarantined) {
    valueScore += WEIGHTS.quarantineLedger;
    signalTally["quarantine-ledger"] = (signalTally["quarantine-ledger"] ?? 0) + 1;
  }

  const timesTouched = commits.length;
  const testOnlyRatio = timesTouched > 0 ? testOnlyCount / timesTouched : 0;

  let recommendation = "keep";
  if (quarantined || valueScore <= THRESHOLDS.delete) recommendation = "delete";
  else if (valueScore <= THRESHOLDS.review) recommendation = "review";

  // Deletion priority surfaces SLOW + LOW-VALUE files first (most time saved per unit of
  // lost signal). Valuable files divide their cost down; non-positive files keep full cost
  // and get a small extra nudge proportional to how negative they are.
  const cost = typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : 0;
  const negativityBoost = 1 + Math.max(0, -valueScore) * 0.05;
  const deletionPriority = (cost / (1 + Math.max(0, valueScore))) * negativityBoost;

  // Under the deletion-ratchet (AGENTS.md), a file is a "safe delete" candidate when it
  // carries zero positive evidence and is either quarantined or pure churn.
  const safeDelete = positiveCount === 0 && (quarantined || valueScore <= 0);

  return {
    valueScore: Number(valueScore.toFixed(2)),
    positiveCount,
    negativeCount,
    neutralCount,
    timesTouched,
    testOnlyCount,
    testOnlyRatio: Number(testOnlyRatio.toFixed(3)),
    signalTally,
    durationMs: cost || null,
    testCount,
    quarantined: Boolean(quarantined),
    recommendation,
    safeDelete,
    deletionPriority: Number(deletionPriority.toFixed(1)),
  };
}
