/**
 * FNXC:CodeOrganization 2026-08-04-07:05:
 * Non-FNXC method/section docs relocated from TaskExecutor (U4 line-count ratchet).
 *
 * - Returns the set of task IDs currently being executed.
 * - FN-5256: register in-flight disposal so re-dispatch awaits prior session reap.
 * - Fast-path completed task → in-review without a new agent session.
 * - Defer execute when permanent agent has active heartbeat and allowParallelExecution=false.
 * - Column-agent U5/R6: effective principal matches agentId (fail-soft → false).
 * - Resume orphaned in-progress tasks after crash/restart (complete → in-review fast path).
 * - FN-4811 process-wide graph routing (cross-instance execute() races).
 * - Graph foreach instance persistence (KTD-6); undefined on pre-CRUD stores.
 * - KTD-12 parse-steps artifact/parser for graph-owned step lists (undefined = legacy).
 * - KTD-13 workflow custom field defs for prompt surface (fail-soft → undefined).
 * - Task artifact by key (PROMPT.md falls back to task PROMPT content).
 * - KTD-15/U14 code-node runner (worktree cwd, artifact pre-read, customFields).
 * - Active foreach instance for graph-owned task (undefined outside foreach body).
 * - Public authoritative-driver seam factory (same real lifecycle seams as internal graph runner).
 * - Await-input node: park awaiting-user-input; resume consumes steering as answer.
 * - Run an arbitrary (approved) CLI command in the task worktree, supervised.
 * - Column-agent U3 adoption for custom nodes (R8 fail-soft → undefined).
 * - Plugin-injected taskEnv (scoped; never mutates process.env). Shared by agentWork + graph skill steps.
 * - Custom (non-seam) graph node via WorkflowStep machinery; columnBinding U3/R precedence.
 * - U7 CLI handoff: graceful PTY reap as completed (best-effort; never blocks advancement).
 * - Shared resumeLanesMemo: one snapshot for handleGraphFailure recovery paths (avoid disagreeing re-resolve).
 * - Terminal graph failure: park in review for human action (never leave invisible in-progress).
 * - Execute a script-mode workflow step (scriptName → project settings command in worktree).
 * - Remove only this executor's store-scoped lifecycle disposer registrations.
 * - Stuck-kill: reset done steps when branch has no unique commits (lost uncommitted work).
 * - Run a spawned child agent's task to completion (state transitions + cleanup).
 */

export {};
