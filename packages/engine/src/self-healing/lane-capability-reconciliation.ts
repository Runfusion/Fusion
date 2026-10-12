import {
  isTaskNotFoundError,
  evaluateImplementationTaskBind,
  resolveTaskImplementationColumns,
  formatLaneCapabilityDeclineReason,
  buildLaneCapabilityFreezePatch,
  hasLaneCapabilityFreeze,
  LANE_CAPABILITY_DECLINE_CODE,
  type Agent,
  type AgentStore,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowSelectionCache,
} from "@fusion/core";
import { createLogger } from "../logger.js";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { isTaskPlanningOrExecutionLive } from "../agents/planning-execution-liveness.js";

const log = createLogger("self-healing");

/*
FNXC:LaneCapabilityReconciliation 2026-09-26-19:40 (RUFU-272 Step 4):
An implementation-class card whose durable owner lane cannot execute it (audit-only role tags,
`assignmentPolicy: "none"`, or a renamed board where the legacy column vocabulary no longer matched)
wedged forever: the wake path declined it (Step 2) but never released the binding, and the drift
sweeps only clear the `agents.taskId` MIRROR — nobody moves the OWNER. This sweep is the single
mutation owner for that repair. Design locks that shape it:

- ONE primitive moves ownership: `store.updateTask(id, { assignedAgentId })`, whose
  `assignmentChanged` branch owns BOTH durable halves (tasks.assignedAgentId + the agents.taskId
  mirror) under the previous-holder guard. `AgentStore.assignTask`/`syncExecutionTaskLink` write
  only the mirror — using them here would leave the owner on the audit lane and hand
  `recoverDriftedAgentTaskLinks` a fresh drift to clear: a ping-pong with no visible owner change.
- The candidate test is the SAME explicit-bar bind verdict as the wake path, witnessed by the
  durable owner (`task.assignedAgentId`), so a card correctly assigned to an `explicit-only`
  executor/engineer lane is never a candidate.
- Mirror-only drift (`agents.taskId` with no `assignedAgentId`, or a dangling `assignedAgentId` with
  no agent row) belongs to `recoverDriftedAgentTaskLinks` / `reattachOrphanedAssignedExecutions`,
  never here — and per the Step-0 audit neither re-linker can (re)bind an implementation card to an
  ineligible lane: `recoverDriftedAgentTaskLinks` only CLEARS mirrors (including any mirror whose
  card's owner moved away, which is exactly the post-rebind state this sweep produces), so sweep and
  drift recovery converge instead of oscillating.
- Absolute suppressions (RUFU-260, proven twice): a live session/execution, `paused`, `userPaused`,
  or `pausedByAgentId` — the reassignment branch auto-unpauses cards whose `pausedByAgentId` names
  the outgoing owner, so the pause guard is re-evaluated on the immediate pre-write re-read, not
  only at candidacy (Design Lock 8).
- No eligible lane exists → the card freezes ONCE via the named-decline patch (existing
  project-configuration origin, code `lane-capability-mismatch`), keeping its owner: the freeze is
  the operator decision point and unowning the card would hide who the decline named.
- No lifecycle column move anywhere: this repair changes the owner (and, in the freeze case, the
  pause state) at the SAME lane. A sweep never gets column authority.
*/

/** Deterministic rebind-target order: idle lanes first, then agent id (stable for tests). */
function compareRebindTargets(a: Agent, b: Agent): number {
  const aIdle = a.state === "idle" ? 0 : 1;
  const bIdle = b.state === "idle" ? 0 : 1;
  return aIdle - bIdle || a.id.localeCompare(b.id);
}

export async function reconcileLaneCapabilityMisbinds(
  store: TaskStore,
  agentStore: AgentStore,
  isTaskLive: (task: Task) => boolean,
  onReconciled?: (repairs: readonly { taskId: string; fromAgentId: string | null; toAgentId: string | null }[]) => void | Promise<void>,
): Promise<number> {
  const settings = await store.getSettings();
  if (settings.globalPause || settings.enginePaused) return 0;

  const durableAgents = await agentStore.listAgents({ includeEphemeral: false });
  const agentById = new Map(durableAgents.map((agent) => [agent.id, agent]));
  // Shared across the whole pass: lane resolution dedupes per workflow definition.
  const irCache = new Map<string, WorkflowIr>();
  const selectionCache: WorkflowSelectionCache = new Map();

  let repairedCount = 0;
  let suppressedCandidateCount = 0;
  const repairs: { taskId: string; fromAgentId: string | null; toAgentId: string | null }[] = [];

  // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
  for (const slim of await store.listTasks({ includeArchived: false, slim: true, excludeLog: true })) {
    // Prescreen on the slim row; every guard is re-evaluated on the authoritative re-read.
    if (slim.deletedAt || !slim.assignedAgentId) continue;
    if (slim.paused || slim.userPaused || slim.pausedByAgentId) continue;
    // A card already carrying this decline is frozen pending operator action — re-writing the
    // freeze would only churn updatedAt; re-running candidacy is pointless until the owner moves.
    if (hasLaneCapabilityFreeze(slim)) continue;
    if (isTaskLive(slim) || isTaskPlanningOrExecutionLive(slim.id)) continue;

    try {
      const implementationColumns = await resolveTaskImplementationColumns(store, slim.id, irCache, selectionCache);

      // Authoritative re-read (slim rows do not carry sourceMetadata / external-block payloads).
      const card = await store.getTask(slim.id);
      if (!card || card.deletedAt || !card.assignedAgentId) continue;
      const previousAgentId = card.assignedAgentId;
      const previousAgent = agentById.get(previousAgentId) ?? await agentStore.getAgent(previousAgentId).catch(() => null);
      // Dangling owner (no agent row) is not a capability verdict we can NAME; mirror/ownership
      // drift without an owner row belongs to the mirror sweeps, not here.
      if (!previousAgent) continue;

      const ownerVerdict = evaluateImplementationTaskBind(previousAgent, card, {
        explicitRouting: true,
        executorRoleOverride: card.sourceMetadata?.executorRoleOverride === true,
        implementationColumns,
      });
      if (ownerVerdict.allowed) continue;

      // Candidate confirmed. Re-assert the absolute guards on the full row before any repair.
      if (card.paused || card.userPaused || card.pausedByAgentId) { suppressedCandidateCount++; continue; }
      if (isTaskLive(card) || isTaskPlanningOrExecutionLive(card.id)) { suppressedCandidateCount++; continue; }

      const declineReason = formatLaneCapabilityDeclineReason(previousAgent, card);

      // Eligible targets: auto-assignable AND the executor/engineer role bar AND enabled runtime,
      // each additionally re-evaluated at the AUTO bind bar against this card (never guess).
      const eligibleTargets: Agent[] = [];
      for (const candidate of durableAgents) {
        if (candidate.id === previousAgentId) continue;
        if (candidate.runtimeConfig?.enabled === false) continue;
        const targetVerdict = evaluateImplementationTaskBind(candidate, card, {
          explicitRouting: false,
          allowEngineer: true,
          executorRoleOverride: card.sourceMetadata?.executorRoleOverride === true,
          implementationColumns,
        });
        if (targetVerdict.allowed) eligibleTargets.push(candidate);
      }
      eligibleTargets.sort(compareRebindTargets);

      if (eligibleTargets.length === 0) {
        // No lane may implement this card — freeze it ONCE, keeping the owner so the decline names
        // whom the operator must fix. Idempotence is guaranteed by the candidacy skip above plus the
        // re-read check here (a freeze from a different pass cannot double-stamp).
        if (hasLaneCapabilityFreeze(card)) { suppressedCandidateCount++; continue; }
        const freezePatch = buildLaneCapabilityFreezePatch(card, previousAgent);
        await store.updateTask(card.id, freezePatch);
        repairedCount++;
        repairs.push({ taskId: card.id, fromAgentId: previousAgentId, toAgentId: null });
        log.warn(`Lane-capability decline frozen for ${card.id}: ${declineReason}`);
        await emitBoundedRunAudit(store, {
          taskId: card.id,
          agentId: previousAgentId,
          runId: "lane-capability-reconcile",
          domain: "database",
          mutationType: "task:reconcile-lane-capability-decline-frozen",
          target: card.id,
          metadata: { outcome: "frozen", taskId: card.id, priorAgentId: previousAgentId, column: card.column, code: LANE_CAPABILITY_DECLINE_CODE, candidateCount: 0 },
        });
        continue;
      }

      // Design Lock 8: the pre-write re-read is the last race window. Anything else claiming the
      // card, pausing it, or starting a session in the meantime aborts this repair untouched.
      const preWrite = await store.getTask(card.id);
      if (!preWrite || preWrite.assignedAgentId !== previousAgentId
        || preWrite.paused || preWrite.userPaused || preWrite.pausedByAgentId
        || preWrite.deletedAt || isTaskLive(preWrite) || isTaskPlanningOrExecutionLive(preWrite.id)) {
        suppressedCandidateCount++;
        continue;
      }

      const target = eligibleTargets[0]!;
      const preserved = { branch: preWrite.branch, worktree: preWrite.worktree, sessionFile: preWrite.sessionFile, currentStep: preWrite.currentStep, column: preWrite.column };
      await store.updateTask(card.id, { assignedAgentId: target.id });

      const post = await store.getTask(card.id);
      if (!post || post.assignedAgentId !== target.id) {
        log.warn(`Lane-capability rebind did not stick for ${card.id} (owner: ${post?.assignedAgentId ?? "unreadable"})`);
        suppressedCandidateCount++;
        continue;
      }
      if (post.branch !== preserved.branch || post.worktree !== preserved.worktree
        || post.sessionFile !== preserved.sessionFile || post.currentStep !== preserved.currentStep
        || post.column !== preserved.column) {
        // The assignment seam must never move lanes or drop execution context; if it did, this is
        // the assertion that catches it. Ownership already moved, so log loudly and keep the audit
        // trail rather than pretending the repair did not happen.
        log.warn(`Lane-capability rebind of ${card.id} unexpectedly altered execution context (column ${preserved.column}->${post.column})`);
      }
      repairedCount++;
      repairs.push({ taskId: card.id, fromAgentId: previousAgentId, toAgentId: target.id });
      log.log(`Rebound lane-capability misbind ${card.id}: ${previousAgentId} -> ${target.id}`);
      await emitBoundedRunAudit(store, {
        taskId: card.id,
        agentId: previousAgentId,
        runId: "lane-capability-reconcile",
        domain: "database",
        mutationType: "task:reconcile-lane-capability-misbind-rebound",
        target: card.id,
        metadata: { outcome: "rebound", taskId: card.id, priorAgentId: previousAgentId, nextAgentId: target.id, column: post.column, candidateCount: eligibleTargets.length },
      });
    } catch (error) {
      if (isTaskNotFoundError(error)) continue;
      log.warn(`Lane-capability reconciliation deferred for ${slim.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (suppressedCandidateCount > 0 && repairedCount === 0) {
    // Deduped per pass: candidates existed but every one hit an absolute guard. Counts/ids only —
    // never the decline prose.
    await emitBoundedRunAudit(store, {
      runId: "lane-capability-reconcile",
      domain: "database",
      mutationType: "task:reconcile-lane-capability-misbind-no-action",
      target: "sweep",
      metadata: { outcome: "suppressed", suppressedCount: suppressedCandidateCount },
    });
  }

  if (repairs.length) await onReconciled?.(repairs);
  return repairedCount;
}
