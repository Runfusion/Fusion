import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent, AgentHeartbeatRun, AgentStore, Task } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const ORPHANED_EXECUTION_RECOVERY_GRACE_MS = 60_000;
const ORPHANED_WITH_WORKTREE_GRACE_MS = 300_000;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "fn-6336-reattach-"));
  tempDirs.push(dir);
  return dir;
}

function isoAge(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "assigned execution",
    description: "assigned execution",
    column: "in-progress",
    status: "in-progress",
    lineageId: "lineage-1",
    branch: "fusion/fn-1",
    worktree: makeWorktree(),
    assignedAgentId: "agent-1",
    paused: false,
    steps: [{ title: "execute", status: "in-progress" }],
    createdAt: isoAge(ORPHANED_WITH_WORKTREE_GRACE_MS + 10_000),
    updatedAt: isoAge(ORPHANED_WITH_WORKTREE_GRACE_MS + 10_000),
    ...overrides,
  } as Task;
}

function makeAgent(id = "agent-1"): Agent {
  return {
    id,
    name: id,
    role: "executor",
    state: "active",
    createdAt: isoAge(120_000),
    updatedAt: isoAge(120_000),
    metadata: {},
  } as Agent;
}

function makeActiveRun(agentId = "agent-1"): AgentHeartbeatRun {
  return {
    id: "run-1",
    agentId,
    status: "active",
    startedAt: new Date().toISOString(),
  } as AgentHeartbeatRun;
}

function buildManager({
  tasks,
  agents = [makeAgent()],
  activeRuns = new Map<string, AgentHeartbeatRun | null>(),
  hasActiveAgentExecution = () => false,
  globalPause = false,
  enginePaused = false,
  executingTaskIds = new Set<string>(),
}: {
  tasks: Task[];
  agents?: Agent[];
  activeRuns?: Map<string, AgentHeartbeatRun | null>;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  globalPause?: boolean;
  enginePaused?: boolean;
  executingTaskIds?: Set<string>;
}) {
  const resumeAssignedTaskForAgent = vi.fn(async () => undefined);
  const recordRunAuditEvent = vi.fn(async () => undefined);
  const store = {
    getSettings: vi.fn(async () => ({ globalPause, enginePaused })),
    listTasks: vi.fn(async () => tasks),
    recordRunAuditEvent,
  } as any;
  const agentStore = {
    getAgent: vi.fn(async (agentId: string) => agents.find((agent) => agent.id === agentId) ?? null),
    getActiveHeartbeatRun: vi.fn(async (agentId: string) => activeRuns.get(agentId) ?? null),
  } as unknown as AgentStore;

  const manager = new SelfHealingManager(store, {
    rootDir: "/tmp/fn-6336-project",
    agentStore,
    getExecutingTaskIds: () => executingTaskIds,
    hasActiveAgentExecution,
    resumeAssignedTaskForAgent,
  });

  return { manager, resumeAssignedTaskForAgent, agentStore, store, recordRunAuditEvent };
}

describe("FN-6336: reattach orphaned assigned in-progress executions", () => {
  it("re-dispatches an orphaned assigned task past worktree grace via the assigned-agent seam", async () => {
    const task = makeTask();
    const { manager, resumeAssignedTaskForAgent, recordRunAuditEvent } = buildManager({ tasks: [task] });

    const recovered = await manager.reattachOrphanedAssignedExecutions();

    expect(recovered).toBe(1);
    expect(resumeAssignedTaskForAgent).toHaveBeenCalledTimes(1);
    expect(resumeAssignedTaskForAgent).toHaveBeenCalledWith("agent-1");
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:reattach-orphaned-execution",
      target: "FN-1",
    }));
    manager.stop();
  });

  it("uses the shorter grace when no task worktree exists", async () => {
    const task = makeTask({ worktree: undefined, updatedAt: isoAge(ORPHANED_EXECUTION_RECOVERY_GRACE_MS + 1_000) });
    const { manager, resumeAssignedTaskForAgent } = buildManager({ tasks: [task] });

    await expect(manager.reattachOrphanedAssignedExecutions()).resolves.toBe(1);

    expect(resumeAssignedTaskForAgent).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("does not reattach a task that is still within the longer worktree grace window", async () => {
    const task = makeTask({ updatedAt: isoAge(ORPHANED_WITH_WORKTREE_GRACE_MS - 1_000) });
    const { manager, resumeAssignedTaskForAgent } = buildManager({ tasks: [task] });

    await expect(manager.reattachOrphanedAssignedExecutions()).resolves.toBe(0);

    expect(resumeAssignedTaskForAgent).not.toHaveBeenCalled();
    manager.stop();
  });

  it.each([
    ["an active heartbeat run exists", { activeRuns: new Map([["agent-1", makeActiveRun()]]) }, {}],
    ["an active agent execution exists", { hasActiveAgentExecution: (agentId: string) => agentId === "agent-1" }, {}],
    ["the task is within the no-worktree grace window", {}, { worktree: undefined, updatedAt: isoAge(ORPHANED_EXECUTION_RECOVERY_GRACE_MS - 1_000) }],
    ["the task is paused", {}, { paused: true }],
    ["the project is globally paused", { globalPause: true }, {}],
    ["the engine is paused", { enginePaused: true }, {}],
    ["the task is soft-deleted", {}, { deletedAt: new Date().toISOString() }],
    ["task work is already complete", {}, { steps: [{ title: "execute", status: "done" }] }],
    ["the executor is already executing the task", { executingTaskIds: new Set(["FN-1"]) }, {}],
    ["the task has no assigned agent", {}, { assignedAgentId: undefined }],
    ["the assigned agent is missing", { agents: [] }, {}],
  ] as const)("does not reattach when %s", async (_name, managerOverrides, taskOverrides) => {
    const { manager, resumeAssignedTaskForAgent } = buildManager({ tasks: [makeTask(taskOverrides as Partial<Task>)], ...managerOverrides });

    await expect(manager.reattachOrphanedAssignedExecutions()).resolves.toBe(0);

    expect(resumeAssignedTaskForAgent).not.toHaveBeenCalled();
    manager.stop();
  });

  it("deduplicates multiple orphaned tasks sharing the same assigned agent", async () => {
    const first = makeTask({ id: "FN-1", lineageId: "lineage-1" });
    const second = makeTask({ id: "FN-2", lineageId: "lineage-2", branch: "fusion/fn-2" });
    const { manager, resumeAssignedTaskForAgent, recordRunAuditEvent } = buildManager({ tasks: [first, second] });

    await expect(manager.reattachOrphanedAssignedExecutions()).resolves.toBe(1);

    expect(resumeAssignedTaskForAgent).toHaveBeenCalledTimes(1);
    expect(resumeAssignedTaskForAgent).toHaveBeenCalledWith("agent-1");
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("only considers in-progress tasks and ignores review, done, todo, triage, and archived tasks", async () => {
    const tasks = [
      makeTask({ id: "FN-review", column: "in-review" }),
      makeTask({ id: "FN-done", column: "done" }),
      makeTask({ id: "FN-todo", column: "todo" }),
      makeTask({ id: "FN-triage", column: "triage" }),
      makeTask({ id: "FN-archived", column: "archived" }),
    ] as Task[];
    const { manager, resumeAssignedTaskForAgent } = buildManager({ tasks });

    await expect(manager.reattachOrphanedAssignedExecutions()).resolves.toBe(0);

    expect(resumeAssignedTaskForAgent).not.toHaveBeenCalled();
    manager.stop();
  });

  it("is registered after agent and stale-run recovery in startup and periodic self-healing loops", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startup = source.slice(source.indexOf("async runStartupRecovery"), source.indexOf("  stop(): void"));
    const periodicStart = source.lastIndexOf("recover-ghost-review");
    const periodicEnd = source.indexOf("reconcile-task-worktree-metadata", periodicStart);
    const periodic = source.slice(periodicStart, periodicEnd);

    for (const block of [startup, periodic]) {
      const orphanedAgents = block.indexOf("recover-orphaned-agents");
      const staleRuns = block.indexOf("recover-stale-heartbeat-runs");
      const reattach = block.indexOf("reattach-orphaned-assigned-executions");
      expect(orphanedAgents).toBeGreaterThanOrEqual(0);
      expect(staleRuns).toBeGreaterThan(orphanedAgents);
      expect(reattach).toBeGreaterThan(staleRuns);
    }
  });
});
