# Mission Completion Gate Contract

## Status

- **Decision date:** 2026-06-02
- **Current contract task:** FN-5902
- **Supersedes:** FN-5718 baseline contract
- **Depends on runtime trigger/recovery behavior from:** FN-5715
- **Implementation status:** Realized by FN-5902

## Decision

Mission completion now uses an **all-criteria AI-run contract**:

1. `MissionFeature.acceptanceCriteria` is the canonical authored feature criteria text.
2. MissionStore must maintain or lazily restore **one store-managed per-feature `MissionContractAssertion`** derived from feature content with text priority:
   - `feature.acceptanceCriteria`
   - `feature.description`
   - `Verify implementation of: {feature.title}`
3. The mission validator must run for every feature completion trigger. Runtime validation may lazily call `ensureFeatureAssertionLinked(feature.id)` before starting the validator so legacy missing-link rows still become validator-backed.
4. `milestone.acceptanceCriteria` is synchronized to one provenance-identified, milestone-scoped assertion and is evaluated only at milestone rollup time.
5. Feature, slice, milestone, and mission advancement are gated by structured scoped assertion results — **not** by an informational-only path.

## Enforcement Model

### Feature-level enforcement

A feature is autopilot-complete only when every linked **feature-scoped** contract assertion passes. The validator ignores parent milestone prose, model aggregate prose, and unmapped behavioral evidence when deriving the feature verdict. Behavioral verification may change only the linked behavioral assertion it identifies.

### Milestone-level enforcement

`milestone.acceptanceCriteria` is no longer informational-only. It is synchronized to one canonical `scope: "milestone"`, `origin: "derived_milestone_acceptance"` assertion. The derived origin is unique per `(project_id, milestone_id)`; independently authored, imported, and legacy milestone assertions remain non-unique and are never identified by title or text.

Milestone assertions require no feature link. The dedicated milestone evaluator may run only after every acceptance-bearing feature has at least one linked feature-scoped assertion and every feature-scoped assertion is linked and `passed`; pending, blocked, failed, unlinked, missing, and prose-only feature contracts are not ready. An all-feature-complete milestone with no acceptance-bearing features may evaluate its milestone assertions directly. Unmet parent scope cannot fail a completed feature or mint a feature-scoped fix.

### Legacy data and lazy repair

Legacy missions can still contain features with missing assertion links. Runtime enforcement no longer depends on pre-running backfill:

- mission execution lazily restores the store-managed feature assertion just before validation, and
- `fn_mission_backfill_assertions` / `backfillFeatureAssertions()` remain available as operator repair tooling for data hygiene and visibility.

## Removed behavior (FN-5902 inversion)

FN-5718's zero-assertion auto-pass behavior is superseded.

Removed contract:

- no `validation_auto_passed_no_assertions` completion path,
- no silent or explicit rubber-stamp pass because assertions were missing,
- no informational-only feature criteria bucket in MissionManager.

Instead, features are routed through validator execution after lazy assertion ensure.

## Worked examples

1. **Feature has acceptance criteria; no linked assertion row is present yet**
   - Runtime calls `ensureFeatureAssertionLinked(feature.id)`.
   - Validator runs against the restored managed assertion.
   - Result gates completion normally.

2. **Feature has acceptance criteria and milestone acceptance criteria**
   - Feature validator evaluates only linked feature assertion(s).
   - Milestone prose is represented by its canonical milestone assertion.
   - A passing feature remains passed even if sibling milestone work is incomplete; the parent assertion gates the later milestone rollup.

3. **Operator runs backfill on legacy data**
   - Backfill pre-restores missing managed assertions for visibility/reporting.
   - Runtime behavior is unchanged because lazy ensure already guarantees validator-backed enforcement.

4. **Feature has a behavioral / bug-fix assertion**
   - The read-only AI judge produces an *advisory* verdict only.
   - The assertion defaults to fail unless a bounded, **non-mutating verification run** confirms the observable behavior by exercising the code (test suite / agent-supplied regression test against a disposable checkout under an isolating sandbox).
   - A genuine behavioral failure → `fail` → Fix Feature with a recorded observed-vs-expected reason.
   - Verification that cannot run or conclude (no isolating backend, timeout, isolation-setup failure, rejected proof, detected flakiness) → `inconclusive` → needs-attention, **no Fix Feature**, never a default pass.
   - The verification run creates no board task, mutates no mission/board row, and leaves the source tree git-clean.

5. **Static assertion (e.g. "documented in README")**
   - Keeps the existing read-only static judging path; no verification run is invoked and no added strictness applies.

## UI contract

MissionManager must present mission criteria as **AI-validated** rather than informational:

- assertion heading text reflects AI validation,
- informational / not-enforced labels are removed,
- zero-assertion warning guard is removed,
- fallback feature-criteria rollups, when shown for missing loaded assertions, describe runtime AI validation rather than non-enforced prose.

## Success invariant

For any mission feature that reaches validation trigger points:

- a validator run must occur,
- the feature must not auto-pass due to missing assertion links,
- parent milestone acceptance text must never affect a feature validator; it is evaluated only by the ready milestone rollup evaluator,
- a behavioral/bug assertion must not pass on the read-only judge's advisory verdict alone — it requires a confirming non-mutating verification run,
- a non-passing verification must resolve to `fail` or `inconclusive`, never a default pass,
- advancement decisions must derive from validator outcomes only.
