/*
 * FNXC:PlanningReviewCompleteness 2026-08-04-06:35:
 * Planning and Plan Review share one completeness contract: planning researches
 * and maps the full requirement ledger up front, while review evaluates the whole
 * artifact and batches every independently discoverable blocker in one round.
 *
 * FNXC:ReviewSeverityGate 2026-08-10-17:33:
 * Two clauses were removed from the review procedure because they manufactured revision rounds rather
 * than finding defects. The former step 6 ordered a full re-derivation of the artifact after every edit
 * ("distrust the edit ... rebuild the ledger ... fresh holistic pass"), which surfaced a new crop of
 * previously-acceptable observations each round; the former step 3's "keep wording polish advisory"
 * carve-out was too weak to stop them being filed as blockers. Re-review is now incremental (see
 * REVIEW_REREVIEW_POLICY) and nits are suppressed at the source (see REVIEW_SEVERITY_POLICY).
 * Measured driver: 311 of 331 findings over 14 days were spec-internal-consistency complaints, and
 * tasks with >=5 remediation rounds consumed 78% of all task active time.
 */
export const PLANNING_COMPLETENESS_POLICY = `## Mandatory Planning Completeness Procedure

Before writing the final PROMPT.md:

1. Build an internal **planning ledger** from the Original Description, user comments, project instructions, cited issue/report, and any saved planning document. Preserve every requirement, settled decision, explicit non-goal, and acceptance outcome; do not silently replace the reporter's contract with a narrower reproduction.
2. Research before structuring the plan. Trace the affected behavior through its real production entry points, callers, writers/readers, shared consumers, persistence boundaries, recovery paths, and existing tests. Resolve planning-time facts from the repository now; defer only details that genuinely require implementation-time discovery, and label those explicitly.
3. For stateful, lifecycle, persistence, or concurrency work, enumerate the participant graph and both relevant orderings: stale-work cancellation/fencing, lock order and reentrancy, transaction boundaries, pool/transport limits, competing recovery paths, configuration/deployment identities, bypass/force paths, and failure cleanup. Every stated invariant must name the surfaces that preserve it.
4. Map every ledger row to concrete File Scope entries, dependency-ordered implementation steps, and verification. Each feature-bearing step must name specific automated test scenarios with the input/state, action or ordering, and expected observable result; helper-only tests do not prove production reachability.
5. Keep scope disciplined. Reuse current architecture and documented patterns unless the reporter contract requires a redesign. Put optional cleanup and adjacent ideas outside the active steps.
6. Before persisting PROMPT.md, perform a fresh holistic completeness pass across the whole ledger. Try to disprove the plan by checking referenced paths and patterns, missing consumers, contradictory steps, uncovered failure orderings, and acceptance criteria without tests. Fix all gaps in one pass.

On a revision, treat the cumulative revision ledger as durable decisions unless a later entry explicitly supersedes one: preserve resolved items, address every unresolved item surgically, and rerun the complete procedure instead of checking only the latest comment.`;

export const FAST_PLANNING_COMPLETENESS_POLICY = `## Fast Planning Completeness Check

Before writing PROMPT.md, build a compact internal ledger from the Original Description, user comments, project rules, and acceptance outcomes. Inspect the real production callers/consumers, persistence or recovery paths, and nearby tests before choosing File Scope. For stateful or concurrent work, enumerate every participant plus both relevant orderings and failure cleanup. Map each requirement to a concrete step, file, and automated test scenario, then reread the whole plan once for missing surfaces, contradictions, and unproved outcomes. On revision, preserve prior decisions and address the complete cumulative ledger, not only the latest note.`;

export const PLAN_REVIEW_COMPLETENESS_POLICY = `## Mandatory Plan Review Procedure

Apply this procedure to plan/spec reviews only. Code reviews use their dedicated procedure.

Before choosing a verdict:

1. Build one **review ledger** for the entire PROMPT.md: Original Description and user comments; Mission and Completion Criteria; Surface Enumeration and Symptom Verification when required; every implementation step, File Scope entry, dependency, risk, and test/verification promise.
2. Complete the full review before reporting. Check coherence and requirement traceability, feasibility against the current repository, scope discipline, execution ordering, and verification quality. When relevant, also inspect security/data integrity, state transitions, concurrency orderings, deployment/configuration boundaries, recovery competitors, and force/bypass paths.
3. Review at specification altitude. Block when a required behavior, surface, ordering, safety constraint, or proof is missing or the stated approach cannot work. A plan does not need to be internally seamless to be executable — judge whether a competent implementer would build the right thing from it, not whether every section agrees with every other section.
4. If REVISE is necessary, batch **all independently discoverable blocking findings** into this one verdict; do not stop after the first defect. Give each blocker a stable ID, cite the affected section or repository evidence, and state the concrete PROMPT.md correction.
5. After a same-session PROMPT.md edit, verify that the edit resolved what you asked for. Confine that check to the changed sections and their direct dependencies; a fresh whole-artifact re-derivation at this point produces new observations rather than new information.

APPROVE when the plan is executable and verifiable, not when it is cosmetically perfect. If returning REVISE, the verdict notes must contain the complete blocking checklist because those notes are the durable input to the next planning round.`;
