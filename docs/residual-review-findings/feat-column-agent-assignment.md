# Residual Review Findings — feat/column-agent-assignment

Source: ce-code-review autofix run `20260605-003401-136dbfd5` (artifact: `/tmp/compound-engineering/ce-code-review/20260605-003401-136dbfd5/`), reviewing the column-agent-assignment feature against `docs/plans/2026-06-04-002-feat-column-agent-assignment-plan.md`.

All other actionable findings from the review (validated P1 correctness bugs, R13 agent-path gate bypass, reliability guards, test gaps — findings #1-#10, #12-#18) were fixed on-branch in commit `fix(review): apply autofix feedback` before PR creation. One design-level residual was deferred to the tracker:

## Residual Review Findings

- **[P2]** `packages/dashboard/src/routes/register-workflow-routes.ts:119` — Column-agent policy-escalation gate is save-time-only (TOCTOU): broadening a bound agent's policy (or narrowing the project default) after save silently escalates the substituted principal with no re-confirmation. Filed: https://github.com/Runfusion/Fusion/issues/1431

## Advisory notes (report-only, no action required)

- `confirmPolicyEscalation` is a transient per-request flag; no persisted record of which policy state was confirmed.
- KTD-4 hot-swap covers execute-seam sessions; step-session tasks are not hot-swapped mid-flight (documented limitation).
- `resumeTaskForAgent` pass-2 performs sequential per-candidate IR resolution; consider a fast-path skip when no bindings are active if it shows up in profiles.
- `effectiveColumnAgentByTask` is per-executor-instance while `graphRouting` is process-static — a second `TaskExecutor` instance would not see the first's column-bound sessions in the heartbeat reverse guard.
