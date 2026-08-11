/**
 * FNXC:CodeOrganization 2026-08-03-11:25:
 * runCliAgentNode + reapCliTaskSessionForHandoff peeled from TaskExecutor (U4).
 * CLI agent graph node: launch PTY session, map outcomes to WorkflowNodeResult.
 */
import type { CliSessionStore, TaskDetail, TaskStore, WorkflowIrNode } from "@fusion/core";
import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveCliExecutorConfig } from "./cli-executor-config.js";
import {
  CliTaskSession,
  launchCliTaskSession,
  killLiveTaskSessions,
  type CliTaskOutcome,
} from "../cli-agent/task-session.js";
import { CliConcurrencyLimitError, type CliSessionManager } from "../cli-agent/session-manager.js";
import type { TelemetryHub } from "../cli-agent/telemetry-hub.js";
import type { CliAdapterRegistry } from "../cli-agent/adapter.js";

/** Structural match for TaskExecutor's CliAgentRuntime (avoids circular import). */
export type CliAgentRuntimeBundle = {
  manager: CliSessionManager;
  hub: TelemetryHub;
  registry: CliAdapterRegistry;
  store: CliSessionStore;
  projectId: string;
  hookEndpointUrl: string;
  hookDirRoot?: string;
};

export type RunCliAgentNodeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  activeCliTaskSessions: Map<string, CliTaskSession>;
  cliAgentRuntime?: CliAgentRuntimeBundle | null;
  reapCliTaskSessionForHandoff: (session: CliTaskSession, taskId: string) => Promise<void>;
};

export async function runCliAgentNode(
  deps: RunCliAgentNodeDeps,
  node: WorkflowIrNode,
  live: TaskDetail,
  cfg: Record<string, unknown>,
): Promise<WorkflowNodeResult> {
  const runtime = deps.cliAgentRuntime;
  if (!runtime) {
    await deps.store.logEntry(
      live.id,
      `Workflow node '${node.id}' uses the cli-agent executor but no CLI agent runtime is wired`,
      undefined,
      deps.getRunContextFor(live.id),
    );
    return { outcome: "failure", value: "cli-agent-runtime-unavailable" };
  }
  const worktreePath = live.worktree;
  if (!worktreePath) {
    await deps.store.logEntry(
      live.id,
      `Workflow node '${node.id}' (cli-agent) is write-capable but no task worktree exists yet — place it after the execute seam`,
      undefined,
      deps.getRunContextFor(live.id),
    );
    return { outcome: "failure", value: "no-worktree-for-write-node" };
  }
  const config = resolveCliExecutorConfig(cfg);
  if (!config) {
    await deps.store.logEntry(
      live.id,
      `Workflow node '${node.id}' (cli-agent) is missing 'cliAdapterId'`,
      undefined,
      deps.getRunContextFor(live.id),
    );
    return { outcome: "failure", value: "cli-agent-adapter-missing" };
  }

  const prompt = typeof cfg.prompt === "string" ? cfg.prompt : (live.prompt ?? "");

  // Re-entry: kill any prior LIVE session for this task (RETHINK/replan context
  // reset) before launching fresh.
  killLiveTaskSessions(live.id, runtime.manager, runtime.store);

  let session: CliTaskSession;
  try {
    session = await launchCliTaskSession({
      taskId: live.id,
      projectId: runtime.projectId,
      worktreePath,
      prompt,
      config,
      manager: runtime.manager,
      hub: runtime.hub,
      registry: runtime.registry,
      hookEndpointUrl: runtime.hookEndpointUrl,
      hookDirRoot: runtime.hookDirRoot,
      log: (msg) => executorLog.log(`[cli-agent] ${msg}`),
    });
  } catch (err) {
    if (err instanceof CliConcurrencyLimitError) {
      await deps.store.logEntry(
        live.id,
        `cli-agent session for node '${node.id}' rejected at PTY pool ceiling (${err.active}/${err.ceiling}) — queued`,
        undefined,
        deps.getRunContextFor(live.id),
      );
      // A typed, surfaced state — NOT a silent stall. The graph failure handler
      // parks the task; a later sweep / capacity opening re-runs it.
      return { outcome: "failure", value: "cli-agent-at-capacity" };
    }
    throw err;
  }

  deps.activeCliTaskSessions.set(live.id, session);
  let outcome: CliTaskOutcome;
  try {
    outcome = await session.result();
  } finally {
    // Detach the live-session handle. Reaping (success) / killing (cancel) is
    // handled per-outcome below or by the abort path.
    if (deps.activeCliTaskSessions.get(live.id) === session) {
      deps.activeCliTaskSessions.delete(live.id);
    }
  }

  switch (outcome.kind) {
    case "success":
      // Reap the PTY at the execute→in-review handoff (autoMerge:false tasks
      // don't hold slots): graceful kill, record terminationReason "completed".
      await deps.reapCliTaskSessionForHandoff(session, live.id);
      return { outcome: "success", value: "cli-agent-done" };
    case "killed":
      // Hard cancel already moved the task + killed the PTY via the abort path;
      // just unwind the graph walk.
      return { outcome: "failure", value: "cli-agent-killed" };
    case "auth-failed":
      return { outcome: "failure", value: "cli-agent-auth-failed" };
    case "user-exited":
      return { outcome: "failure", value: "cli-agent-user-exited" };
    case "needs-attention":
    default:
      return { outcome: "failure", value: "cli-agent-needs-attention" };
  }
}

export async function reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): Promise<void> {
  try {
    await session.reap();
  } catch (err) {
    executorLog.warn(`${taskId}: failed to reap cli-agent session at handoff: ${err}`);
  }
}
