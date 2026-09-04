import { afterEach, describe, expect, it, vi } from "vitest";
import { mutationContextForAgent } from "@fusion/core";
import type { Settings, TaskDetail, TaskStore, WorkspaceConfig } from "@fusion/core";
import { ensureGraphCustomNodeWorktree } from "../executor/ensure-graph-custom-node-worktree.js";
import { resolveGraphCustomNodeWorktreePrincipal } from "../executor/run-graph-custom-node.js";
import { runContextForTotal } from "../executor/run-context-for.js";
import { captureBaseCommitSha } from "../executor/worktree-git-refs.js";
import { acquireTaskWorktree, acquireWorkspaceTaskWorktrees } from "../worktree/worktree-acquisition.js";

vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-acquisition.js")>();
  return {
    ...actual,
    acquireWorkspaceTaskWorktrees: vi.fn(actual.acquireWorkspaceTaskWorktrees),
    acquireTaskWorktree: vi.fn(actual.acquireTaskWorktree),
  };
});

vi.mock("../executor/worktree-git-refs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor/worktree-git-refs.js")>();
  return {
    ...actual,
    captureBaseCommitSha: vi.fn(actual.captureBaseCommitSha),
  };
});

const mockedAcquireWorkspace = vi.mocked(acquireWorkspaceTaskWorktrees);
const mockedAcquireTask = vi.mocked(acquireTaskWorktree);
const mockedCaptureBase = vi.mocked(captureBaseCommitSha);

function task(overrides: Record<string, unknown> = {}): TaskDetail {
  return {
    id: "FN-3430",
    title: "First custom node",
    description: "First custom node",
    column: "in-progress",
    assignedAgentId: "graph-node-agent",
    dependencies: [],
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

const settings = {} as Settings;
const workspaceConfig: WorkspaceConfig = { repos: ["repo-a"] };

/*
FNXC:Identity 2026-09-04-07:57:
Greptile P1 — first-executable custom nodes never populate the implementation
currentRunContexts map. Drive the shipped helper with the real empty-map total
resolver so the acquire cannot hide behind a stubbed runContextFor.
*/
function emptyImplementationRunContextFor(taskId: string, fallbackAgentId?: string | null) {
  return runContextForTotal(() => undefined, taskId, fallbackAgentId);
}

function graphNodeAcquireDeps(overrides: Record<string, unknown> = {}) {
  return {
    store: {
      logEntry: vi.fn(async () => undefined),
      getTask: vi.fn(async (id: string) => task({ id })),
    } as unknown as TaskStore,
    rootDir: "/workspace",
    workspaceConfigOwner: {},
    getWorkspaceConfig: () => null as WorkspaceConfig | null,
    setWorkspaceConfig: vi.fn(),
    getRunContextFor: () => undefined,
    runContextFor: emptyImplementationRunContextFor,
    createWorktree: vi.fn(),
    runConfiguredCommand: vi.fn(),
    addActiveWorktree: vi.fn(),
    registerConfiguredCommandController: vi.fn(),
    unregisterConfiguredCommandController: vi.fn(),
    ...overrides,
  };
}

function expectGraphNodeContext(runContext: { agentId?: string; runId?: string; actor?: { actor?: { id?: string } } } | undefined) {
  expect(runContext?.agentId).toBe("graph-node-agent");
  expect(runContext?.actor?.actor?.id).toBe("graph-node-agent");
  expect(runContext?.runId).toMatch(/^workflow-node-worktree-FN-3430-/);
  expect(runContext?.agentId).not.toBe("executor");
  expect(runContext?.runId).not.toBe("unknown");
}

afterEach(() => vi.clearAllMocks());

describe("ensureGraphCustomNodeWorktree first-node identity", () => {
  it("attributes workspace acquisition to the graph-node agent and synthetic run, not executor/unknown", async () => {
    const live = task({
      workspaceWorktrees: { "repo-a": { worktreePath: "/workspace/.fusion/worktrees/fn-3430/repo-a" } },
    });
    mockedAcquireWorkspace.mockResolvedValue({
      task: live,
      taskWorktreeDir: "/workspace/.fusion/worktrees/fn-3430",
    });

    await ensureGraphCustomNodeWorktree(
      graphNodeAcquireDeps({ getWorkspaceConfig: () => workspaceConfig }),
      live,
      settings,
      "custom-first",
      true,
    );

    const fallback = emptyImplementationRunContextFor(live.id);
    expect(fallback.agentId).toBe("executor");
    expect(fallback.runId).toBe("unknown");

    expect(mockedAcquireWorkspace).toHaveBeenCalledOnce();
    expectGraphNodeContext(mockedAcquireWorkspace.mock.calls[0]?.[0]?.runContext);
  });

  it("attributes task-worktree acquire and base-SHA persist to the graph-node agent and synthetic run", async () => {
    mockedAcquireTask.mockResolvedValue({
      worktreePath: "/workspace/.fusion/worktrees/fn-3430",
      branch: "fusion/fn-3430",
      source: "fresh",
      hydrated: false,
      isResume: false,
    } as Awaited<ReturnType<typeof acquireTaskWorktree>>);
    mockedCaptureBase.mockResolvedValue(undefined);

    await ensureGraphCustomNodeWorktree(graphNodeAcquireDeps(), task(), settings, "custom-first");

    expect(mockedAcquireTask).toHaveBeenCalledOnce();
    expectGraphNodeContext(mockedAcquireTask.mock.calls[0]?.[0]?.runContext);
    expect(mockedCaptureBase).toHaveBeenCalledOnce();
    expectGraphNodeContext(mockedCaptureBase.mock.calls[0]?.[5]);
  });

  it("prefers a live implementation carrier when the map is populated", async () => {
    const liveContext = mutationContextForAgent("agent-live", "run-live");
    mockedAcquireTask.mockResolvedValue({
      worktreePath: "/workspace/.fusion/worktrees/fn-3430",
      branch: "fusion/fn-3430",
      source: "fresh",
      hydrated: false,
      isResume: false,
    } as Awaited<ReturnType<typeof acquireTaskWorktree>>);
    mockedCaptureBase.mockResolvedValue(undefined);

    await ensureGraphCustomNodeWorktree(
      graphNodeAcquireDeps({ getRunContextFor: () => liveContext }),
      task(),
      settings,
      "custom-first",
    );

    expect(mockedAcquireTask.mock.calls[0]?.[0]?.runContext).toEqual(liveContext);
    expect(mockedCaptureBase.mock.calls[0]?.[5]).toEqual(liveContext);
  });

  it("attributes empty-map acquire to node config agentId, not the task assignee", async () => {
    mockedAcquireTask.mockResolvedValue({
      worktreePath: "/workspace/.fusion/worktrees/fn-3430",
      branch: "fusion/fn-3430",
      source: "fresh",
      hydrated: false,
      isResume: false,
    } as Awaited<ReturnType<typeof acquireTaskWorktree>>);
    mockedCaptureBase.mockResolvedValue(undefined);

    await ensureGraphCustomNodeWorktree(
      graphNodeAcquireDeps(),
      task({ assignedAgentId: "task-assignee" }),
      settings,
      "custom-first",
      false,
      "node-agent",
    );

    const runContext = mockedAcquireTask.mock.calls[0]?.[0]?.runContext;
    expect(runContext?.agentId).toBe("node-agent");
    expect(runContext?.actor?.actor?.id).toBe("node-agent");
    expect(runContext?.runId).toMatch(/^workflow-node-worktree-FN-3430-/);
    expect(runContext?.agentId).not.toBe("task-assignee");
    expect(runContext?.agentId).not.toBe("executor");
    expect(runContext?.runId).not.toBe("unknown");
    expect(mockedCaptureBase.mock.calls[0]?.[5]?.agentId).toBe("node-agent");
  });

  it("resolves column-override principal over node and task agents", () => {
    const resolved = resolveGraphCustomNodeWorktreePrincipal({
      cfg: { agentId: "node-agent" },
      columnBinding: { mode: "override", agentId: "column-agent" },
      graphContext: { "workflow:principal-agent-id": "pool-agent" },
    });
    expect(resolved.principalAgentId).toBe("column-agent");
    expect(resolved.effective).toEqual({ source: "column-agent", agentId: "column-agent" });
  });

  it("resolves graph principal when there is no column override", () => {
    const resolved = resolveGraphCustomNodeWorktreePrincipal({
      cfg: { agentId: "node-agent" },
      graphContext: { "workflow:principal-agent-id": "pool-agent" },
    });
    expect(resolved.principalAgentId).toBe("pool-agent");
    expect(resolved.effective.source).toBe("own-settings");
  });

  it("attributes empty-map acquire to column-override principal, not node or task agent", async () => {
    mockedAcquireTask.mockResolvedValue({
      worktreePath: "/workspace/.fusion/worktrees/fn-3430",
      branch: "fusion/fn-3430",
      source: "fresh",
      hydrated: false,
      isResume: false,
    } as Awaited<ReturnType<typeof acquireTaskWorktree>>);
    mockedCaptureBase.mockResolvedValue(undefined);
    const { principalAgentId } = resolveGraphCustomNodeWorktreePrincipal({
      cfg: { agentId: "node-agent" },
      columnBinding: { mode: "override", agentId: "column-agent" },
    });

    await ensureGraphCustomNodeWorktree(
      graphNodeAcquireDeps(),
      task({ assignedAgentId: "task-agent" }),
      settings,
      "custom-first",
      false,
      principalAgentId,
    );

    const runContext = mockedAcquireTask.mock.calls[0]?.[0]?.runContext;
    expect(runContext?.agentId).toBe("column-agent");
    expect(runContext?.actor?.actor?.id).toBe("column-agent");
    expect(runContext?.runId).toMatch(/^workflow-node-worktree-FN-3430-/);
    expect(runContext?.agentId).not.toBe("node-agent");
    expect(runContext?.agentId).not.toBe("task-agent");
    expect(runContext?.agentId).not.toBe("executor");
  });

  it("attributes empty-map acquire to graph principal when there is no column override", async () => {
    mockedAcquireTask.mockResolvedValue({
      worktreePath: "/workspace/.fusion/worktrees/fn-3430",
      branch: "fusion/fn-3430",
      source: "fresh",
      hydrated: false,
      isResume: false,
    } as Awaited<ReturnType<typeof acquireTaskWorktree>>);
    mockedCaptureBase.mockResolvedValue(undefined);
    const { principalAgentId } = resolveGraphCustomNodeWorktreePrincipal({
      cfg: { agentId: "node-agent" },
      graphContext: { "workflow:principal-agent-id": "pool-agent" },
    });

    await ensureGraphCustomNodeWorktree(
      graphNodeAcquireDeps(),
      task({ assignedAgentId: "task-agent" }),
      settings,
      "custom-first",
      false,
      principalAgentId,
    );

    const runContext = mockedAcquireTask.mock.calls[0]?.[0]?.runContext;
    expect(runContext?.agentId).toBe("pool-agent");
    expect(runContext?.actor?.actor?.id).toBe("pool-agent");
    expect(runContext?.runId).toMatch(/^workflow-node-worktree-FN-3430-/);
    expect(runContext?.agentId).not.toBe("node-agent");
    expect(runContext?.agentId).not.toBe("task-agent");
  });
});
