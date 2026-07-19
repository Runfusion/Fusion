# Persisted ideation

Fusion ideation is a project-scoped, bounded operation rather than a free-form document.

1. Start a session with `fn_ideation_start` or Command Center → **Ideation**.
2. Record alternatives with `fn_ideation_diverge`; each candidate records an `agent`, `human`, or `research` origin and optional source reference.
3. Inspect sessions with `fn_ideation_list` and `fn_ideation_show`.
4. Converge an explicit candidate using `fn_ideation_converge` or the Command Center action.

Convergence creates a canonical Mission by default, or attaches to a supplied `targetMissionId`. The selected candidate and session persist the Mission (and optional Feature) linkage. It never writes an orphan ideation document as the handoff.

## Atomic handoff

The ideation store opens one `AsyncDataLayer.transactionImmediate` transaction. Mission creation or validation, candidate selection, session convergence, and linkage persistence all run inside it. If Mission handoff fails, the transaction rolls back: the session remains open, no candidate is selected, and no partial Mission/linkage is retained.

## Access and policy

Engine executor, triage, and heartbeat lanes receive the shared `fn_ideation_*` factory. Listing and showing sessions are positively read-only. Start, diverge, and converge are `task_agent_mutation` operations and require both action-gate and permanent-agent policy recognition.

Dashboard chat always exposes read tools. It exposes mutations only for a bound non-ephemeral agent that has the same durable action/permanent-agent gate contexts as Mission chat writes; unbound chat does not receive ideation mutations.

The dashboard REST route and Command Center panel delegate to the same project-scoped `TaskStore.getIdeationStore()` operation as the tools.
