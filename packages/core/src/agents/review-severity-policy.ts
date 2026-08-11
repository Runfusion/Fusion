/*
FNXC:ReviewSeverityGate 2026-08-10-17:33:
One shared severity taxonomy for every review-kind gate (Plan Review, Code Review). It exists because
the persisted `severity` field was previously requested from the model with no definition at all —
the system prompt asked for "low|medium|high|critical" and never said what they meant or what they did,
so reviewers classified arbitrarily and the engine ignored the answer.

The engine now gates the verdict on these values (see `workflows/review-severity-gate.ts`), so the
vocabulary is a behavioral contract, not documentation: a mis-classified finding either blocks delivery
that should have proceeded, or lets a real defect through. The definitions below are written in terms of
CONSEQUENCE (what breaks if unfixed) rather than effort or confidence, because consequence is the only
axis the gate can act on.

The no-nits rule is the load-bearing half. Measured over 14 days, 311 of 331 recorded findings were
spec-internal-consistency complaints that changed no delivered behavior, and each one forced a full
remediation round. Suppressing them at the source is cheaper than classifying and then discarding them,
and it keeps the reviewer's attention on defects.
*/

/** Severity definitions + no-nits rule shared by all review-kind gates. */
export const REVIEW_SEVERITY_POLICY = `## Finding Priority

Every finding you report MUST carry a \`severity\`. Classify by CONSEQUENCE — what breaks if this is never fixed — not by how confident you are or how easy the fix is.

- **critical (P0)** — delivery-blocking. The stated approach cannot work, a required behavior or safety constraint is missing, or shipping this causes incorrect behavior, data loss, a security hole, or a broken contract for an existing consumer.
- **high (P1)** — materially wrong but not fatal. A real defect, missing verification for a behavior being changed, or an ambiguity concrete enough that a competent implementer would likely resolve it the wrong way.
- **medium / low (P2)** — genuine but non-blocking. Worth knowing, safe to defer, and safe to decline.

## Do Not Report Nits

Assume the implementer is a competent engineer who resolves local detail correctly without being told. Do NOT report — at ANY severity, including as advisory notes — any of the following:

- Wording, phrasing, formatting, heading, ordering, or naming preferences.
- Internal numbering, counting, or cross-reference mismatches between sections that do not change what gets built (for example: a list says "13 sites" but enumerates 15, a step cites a section by the wrong label, two sections describe the same requirement in different words).
- Restating a requirement that is already satisfied elsewhere in the artifact, or asking for a detail to be repeated in a second location.
- Detail that is genuinely underspecified but that any reasonable implementation choice would satisfy.
- Speculative future concerns not reachable by the change under review, and improvements outside its stated scope.
- Requests to add defensive handling for conditions the surrounding code already prevents.

If a finding's only consequence is that the artifact reads less precisely, it is a nit. Omit it entirely. A review with no findings is a good outcome, and you are not expected to find something.

Report only what changes the delivered result. Prefer few, well-evidenced findings over exhaustive coverage.`;

/**
 * Re-review rules for the second and subsequent rounds.
 *
 * FNXC:ReviewSeverityGate 2026-08-10-17:33:
 * The previous policy told the reviewer to "distrust the edit: reread the complete artifact, rebuild
 * the ledger, and perform a fresh holistic pass" on every round. Combined with an unbounded revision
 * budget that instruction was the churn engine — each round re-derived the artifact from scratch and
 * surfaced a fresh crop of previously-acceptable observations as new blockers, so convergence depended
 * on the reviewer running out of things to notice. Re-review is now INCREMENTAL and the bar for
 * introducing a NEW blocker after round one is deliberately higher than for the first round.
 */
export const REVIEW_REREVIEW_POLICY = `## Re-Review (round 2 and later)

You are re-reviewing an artifact that was revised in response to your own earlier findings. Your job is to CONVERGE, not to re-derive the review.

1. Verify each prior blocking finding: resolved, partially resolved, or unresolved. Resolved items are settled — do not reopen them, and do not re-raise a semantic duplicate under a new ID.
2. Accept decisions the previous round already accepted. A choice you did not object to before is not a defect now merely because you are looking again.
3. You may raise a NEW blocking finding only when one of these is true, and you must state which:
   - the revision INTRODUCED it;
   - it is P0 (delivery-blocking) and was genuinely missed earlier — say so plainly rather than demoting it;
   - a prior blocker was masking it.
   A new finding that meets none of these is not blocking. Report it as P2 or omit it.
4. Never introduce a new P1 or P2 finding as grounds for another revision round. Late-arriving non-blocking observations belong in notes.
5. If every prior blocker is resolved, APPROVE. Do not withhold approval because a fresh read suggests further polish — approve when the artifact is executable and verifiable, not when it is beyond improvement.`;
