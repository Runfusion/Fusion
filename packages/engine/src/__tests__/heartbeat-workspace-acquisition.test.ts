/*
FNXC:Worktree 2026-10-29-11:28 (RUFU-805) — written against the delivered implementation.

The invariant: a heartbeat wake that starts an agent session must hand that session a working
directory inside a real Git work tree, on every project shape. In a workspace project the project
root is NOT a repository (members are siblings named by `.fusion/workspace.json`), so the
single-repo primitive resolves an aggregate `.fusion/worktrees/<task>` path with no repository leg,
the session dies on its first Git call with `fatal: not a git repository`, and the card parks on the
three-strike acquisition cap. Observed in the saneca project on SANE-485/486/586/593/595/601, and on
a fresh SANE-613 three times within 57 seconds while it had no leg in any repository.

`loadWorkspaceConfig` is exercised for real against a temp `rootDir`, never mocked, so the fail-soft
rules (absent / empty / malformed config) are the loader's actual verdicts rather than a stubbed
branch. The strike-path assertions name what the code observably writes: the non-cap strike advances
`recoveryRetryCount`, and the cap writes both the `logEntry` line and the `failed` status.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore, WorkflowIr } from "@fusion/core";

import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import { resetTaskDisposalBarrierForTests } from "../executor/task-disposal-barrier.js";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

const sessionFactory = vi.hoisted(() => ({
  createResolvedAgentSession: vi.fn(),
  promptWithFallback: vi.fn(async (session: { prompt(text: string): Promise<unknown> }, text: string) => {
    await session.prompt(text);
  }),
}));

vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: sessionFactory.createResolvedAgentSession,
}));

vi.mock("../pi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pi.js")>()),
  promptWithFallback: sessionFactory.promptWithFallback,
}));

const WF = "custom:handoff";
const WORKSPACE_LEGS = "/ws/FN-1";
const SINGLE_REPO_LEG = "/wt/FN-1";

function handoffIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "queued", name: "queued", traits: [{ trait: "hold", config: { release: "manual" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "assessing", name: "assessing", traits: [{ trait: "merge-blocker" }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function agentFixture(id: string): Agent {
  return {
    id, name: id, role: "executor", state: "active", taskId: "FN-1",
    createdAt: "", updatedAt: "", metadata: {},
  } as unknown as Agent;
}

function createAgentStore(): AgentStore {
  const run = {
    id: "run-1", agentId: "agent-a", status: "active",
    startedAt: new Date().toISOString(), endedAt: null,
  } as unknown as AgentHeartbeatRun;
  return {
    getAgent: vi.fn().mockResolvedValue(agentFixture("agent-a")),
    getAgentsByTaskId: vi.fn().mockResolvedValue([]),
    startHeartbeatRun: vi.fn().mockResolvedValue(run),
    saveRun: vi.fn(async (written: AgentHeartbeatRun) => { Object.assign(run, written); return run; }),
    getRunDetail: vi.fn().mockResolvedValue(run),
    endHeartbeatRun: vi.fn(),
    updateAgentState: vi.fn(),
    updateAgent: vi.fn(),
    assignTask: vi.fn(),
    recordHeartbeat: vi.fn(),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
    getCachedAgent: vi.fn().mockReturnValue(null),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn(),
    clearLastBlockedState: vi.fn(),
    appendRunLog: vi.fn(),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentStore;
}

/**
 * A stateful task row, because the acquisition strike budget is read back from the task on the next
 * wake (`recoveryRetryCount`). A `getTask` that always returned the same snapshot could never reach
 * the cap.
 */
function createTaskStore(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "FN-1",
    title: "Workspace card",
    description: "d",
    prompt: "# PROMPT",
    column: "building",
    assignedAgentId: "agent-a",
    worktree: SINGLE_REPO_LEG,
    branch: "fusion/fn-1",
    dependencies: [],
    steps: [],
    log: [],
  };
  const taskStore = {
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn(async () => ({ ...row })),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    moveTask: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(row, patch);
      return { ...row };
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WF, stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WF, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: handoffIr() })),
    ...overrides,
  } as unknown as TaskStore;
  return { taskStore, row };
}

async function wakeOn(rootDir: string, taskStore: TaskStore) {
  const monitor = new HeartbeatMonitor({ store: createAgentStore(), taskStore, rootDir });
  return monitor.executeHeartbeat({ agentId: "agent-a", source: "assignment", taskId: "FN-1" });
}

function sessionCwd(): string | undefined {
  const call = sessionFactory.createResolvedAgentSession.mock.calls[0] as [{ cwd?: string }] | undefined;
  return call?.[0]?.cwd;
}

async function writeWorkspaceJson(rootDir: string, contents: string): Promise<void> {
  await mkdir(join(rootDir, ".fusion"), { recursive: true });
  await writeFile(join(rootDir, ".fusion", "workspace.json"), contents, "utf8");
}

describe("heartbeat worktree acquisition is workspace-aware", () => {
  let rootDir: string;
  let acquireSingle: ReturnType<typeof vi.spyOn>;
  let acquireWorkspace: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetTaskDisposalBarrierForTests();
    vi.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), "rufu-805-hb-"));
    acquireSingle = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockImplementation(async () => ({
      mode: "new", worktreePath: SINGLE_REPO_LEG, refreshedBase: "abcdef",
    }) as never);
    acquireWorkspace = vi.spyOn(worktreeAcquisition, "acquireWorkspaceTaskWorktrees").mockImplementation(
      async () => ({ task: { id: "FN-1" }, taskWorktreeDir: WORKSPACE_LEGS }) as never,
    );
    sessionFactory.createResolvedAgentSession.mockImplementation(async () => ({
      session: { prompt: vi.fn(async () => {}), dispose: vi.fn(), subscribe: vi.fn(() => () => {}) },
    }));
  });

  afterEach(async () => {
    acquireSingle.mockRestore();
    acquireWorkspace.mockRestore();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("routes a populated workspace config to per-repository acquisition and roots the session in the leg set", async () => {
    await writeWorkspaceJson(rootDir, JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    const { taskStore } = createTaskStore();

    await wakeOn(rootDir, taskStore);

    expect(acquireWorkspace).toHaveBeenCalledTimes(1);
    const opts = (acquireWorkspace.mock.calls[0] as [{ workspaceRootDir: string; runInitCommand?: boolean }])[0];
    expect(opts.workspaceRootDir).toBe(rootDir);
    // Heartbeat wakes never install dependencies — the whole point of threading the flag (Step 1).
    expect(opts.runInitCommand).toBe(false);
    expect(acquireSingle).not.toHaveBeenCalled();
    expect(sessionCwd()).toBe(WORKSPACE_LEGS);
  });

  it("keeps a project without a workspace config on the single-repository arm", async () => {
    const { taskStore } = createTaskStore();

    await wakeOn(rootDir, taskStore);

    expect(acquireWorkspace).not.toHaveBeenCalled();
    expect(acquireSingle).toHaveBeenCalledTimes(1);
    const opts = (acquireSingle.mock.calls[0] as [{ runInitCommand?: boolean }])[0];
    expect(opts.runInitCommand).toBe(false);
    expect(sessionCwd()).toBe(SINGLE_REPO_LEG);
  });

  it("treats an empty repository list as not-workspace, so no legless acquisition is ever attempted", async () => {
    await writeWorkspaceJson(rootDir, JSON.stringify({ repos: [] }));
    const { taskStore } = createTaskStore();

    await wakeOn(rootDir, taskStore);

    expect(acquireWorkspace).not.toHaveBeenCalled();
    expect(acquireSingle).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed repository list as not-workspace", async () => {
    await writeWorkspaceJson(rootDir, JSON.stringify({ repos: [123] }));
    const { taskStore } = createTaskStore();

    await wakeOn(rootDir, taskStore);

    expect(acquireWorkspace).not.toHaveBeenCalled();
    expect(acquireSingle).toHaveBeenCalledTimes(1);
  });

  it("keeps the three-strike budget for workspace failures, ending in the same operator-facing cap", async () => {
    await writeWorkspaceJson(rootDir, JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    const { taskStore, row } = createTaskStore();
    acquireWorkspace.mockRejectedValue(new Error("fatal: not a git repository (or any parent up to mount point /)"));

    await wakeOn(rootDir, taskStore);
    expect(row.recoveryRetryCount).toBe(1);
    expect(row.status).toBeUndefined();

    await wakeOn(rootDir, taskStore);
    expect(row.recoveryRetryCount).toBe(2);
    expect(row.status).toBeUndefined();

    await wakeOn(rootDir, taskStore);
    expect(row.status).toBe("failed");
    expect(String(row.error)).toContain("Worktree acquisition failed after 3 heartbeat attempts");
    expect(String(row.error)).toContain("not a git repository");
    const capLog = (taskStore.logEntry as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[1] ?? ""))
      .find((message) => message.includes("retry cap reached"));
    expect(capLog).toContain("retry cap reached");
  });
});
