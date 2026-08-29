import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----------------------------------------------------------------

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(),
  closeProjectStore: vi.fn(async (context: { store?: { close?: () => Promise<void> } }) => {
    await context.store?.close?.().catch(() => {});
  }),
  asLocalProjectContext: (store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  }),
}));

const promoteBranchGroupMock = vi.fn();
vi.mock("@fusion/engine", () => ({
  promoteBranchGroup: (...args: unknown[]) => promoteBranchGroupMock(...args),
  resolveIntegrationBranch: vi.fn(async () => "main"),
}));

// The canonical completion predicate lives in @fusion/core; keep its real
// behavior so the CLI gate matches the dashboard route gate (parity).
const closeGroupPullRequestMock = vi.fn(async () => ({ prNumber: 55, prUrl: "https://example/pr/55", prState: "closed" as const }));
vi.mock("@fusion/dashboard", () => ({
  GitHubClient: vi.fn(function GitHubClient() {}),
  closeGroupPullRequest: (...args: unknown[]) => closeGroupPullRequestMock(...args),
}));

const createGroupPrCallbackMock = vi.fn(() => async () => ({ prNumber: 1, prUrl: "x", prState: "open" as const }));
vi.mock("../task-lifecycle.js", () => ({
  createGroupPrCallback: (...args: unknown[]) => createGroupPrCallbackMock(...args),
}));

import { resolveProject } from "../../project-context.js";
import { runBranchGroupPromote, runBranchGroupList, runBranchGroupAbandon } from "../branch-group.js";

const LANDED_TASK = {
  id: "FN-1",
  title: "one",
  description: "one",
  column: "in-review",
  mergeDetails: {
    mergeConfirmed: true,
    mergeTargetSource: "branch-group-integration",
    mergeTargetBranch: "feature/shared",
  },
  branchContext: { source: "planning", assignmentMode: "shared", groupId: "BG-1" },
};

const UNLANDED_TASK = {
  ...LANDED_TASK,
  id: "FN-2",
  column: "in-progress",
  mergeDetails: undefined,
};

function makeStore(group: Record<string, unknown>, members: unknown[]) {
  return {
    getBranchGroup: vi.fn(() => group),
    listBranchGroups: vi.fn(() => [group]),
    // The list command pre-fetches all tasks once and filters in memory (N+1 fix);
    // show/abandon still go through the per-group scan.
    listTasks: vi.fn(async () => members),
    listTasksByBranchGroup: vi.fn(async () => members),
    updateBranchGroup: vi.fn((_id: string, patch: Record<string, unknown>) => ({ ...group, ...patch })),
    getSettings: vi.fn(async () => ({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      mergeStrategy: "merge",
      baseBranch: "main",
    })),
    recordRunAuditEvent: vi.fn(),
  };
}

const BASE_GROUP = {
  id: "BG-1",
  sourceType: "planning",
  sourceId: "PS-1",
  branchName: "feature/shared",
  status: "open" as const,
  prState: "none" as const,
  autoMerge: false,
};

describe("branch-group CLI promote (agent-native parity)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    promoteBranchGroupMock.mockReset();
    createGroupPrCallbackMock.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.mocked(resolveProject).mockReset();
  });

  it("promotes a complete group via the same coordinator path and prints the PR url", async () => {
    const store = makeStore(BASE_GROUP, [LANDED_TASK]);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p",
      projectPath: "/tmp/p",
      projectName: "p",
      isRegistered: true,
      store: store as never,
    });
    promoteBranchGroupMock.mockResolvedValue({
      groupId: "BG-1",
      promoted: true,
      alreadyFinalized: false,
      reason: "promoted",
      status: "open",
      prState: "open",
      prNumber: 42,
      prUrl: "https://example/pr/42",
    });

    await runBranchGroupPromote("BG-1");

    // Reaches the SAME standalone coordinator the engine bridge method delegates to,
    // with the createGroupPr callback wired (the dashboard route ends here too).
    expect(createGroupPrCallbackMock).toHaveBeenCalledTimes(1);
    expect(promoteBranchGroupMock).toHaveBeenCalledTimes(1);
    const callArg = promoteBranchGroupMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.groupId).toBe("BG-1");
    expect(callArg.createGroupPr).toBeTypeOf("function");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("https://example/pr/42");
  });

  it("returns the same prUrl shape the promote route returns (parity)", async () => {
    const store = makeStore(BASE_GROUP, [LANDED_TASK]);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p", projectPath: "/tmp/p", projectName: "p", isRegistered: true, store: store as never,
    });
    const routeShape = {
      groupId: "BG-1",
      promoted: true,
      alreadyFinalized: false,
      reason: "promoted",
      status: "open",
      prState: "open",
      prNumber: 7,
      prUrl: "https://example/pr/7",
    };
    promoteBranchGroupMock.mockResolvedValue(routeShape);

    await runBranchGroupPromote("BG-1");

    const result = await promoteBranchGroupMock.mock.results[0].value;
    expect(result).toMatchObject({ prNumber: 7, prUrl: "https://example/pr/7", prState: "open" });
  });

  it("rejects an incomplete group with the same completion gate message", async () => {
    const store = makeStore(BASE_GROUP, [LANDED_TASK, UNLANDED_TASK]);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p", projectPath: "/tmp/p", projectName: "p", isRegistered: true, store: store as never,
    });

    await expect(runBranchGroupPromote("BG-1")).rejects.toThrow(/process.exit/);
    expect(promoteBranchGroupMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).toContain("Branch group completion gate not satisfied");
  });

  it("lists groups with completion + PR state", async () => {
    const store = makeStore({ ...BASE_GROUP, prState: "open", prNumber: 3 }, [LANDED_TASK]);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p", projectPath: "/tmp/p", projectName: "p", isRegistered: true, store: store as never,
    });

    await runBranchGroupList();

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("BG-1");
    expect(out).toContain("feature/shared");
    expect(out).toContain("PR open");
  });

  it("fetches tasks once for the whole list instead of one scan per group (N+1 fix)", async () => {
    const groupA = { ...BASE_GROUP, id: "BG-1" };
    const groupB = { ...BASE_GROUP, id: "BG-2", branchName: "feature/other" };
    const store = makeStore(groupA, [LANDED_TASK]);
    store.listBranchGroups = vi.fn(() => [groupA, groupB]);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p", projectPath: "/tmp/p", projectName: "p", isRegistered: true, store: store as never,
    });

    await runBranchGroupList();

    expect(store.listTasks).toHaveBeenCalledTimes(1);
    expect(store.listTasksByBranchGroup).not.toHaveBeenCalled();
  });
});

describe("branch-group CLI abandon (agent-native parity, Fix #7)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    closeGroupPullRequestMock.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.mocked(resolveProject).mockReset();
  });

  function mountStore(group: Record<string, unknown>) {
    const store = makeStore(group, []);
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "p", projectPath: "/tmp/p", projectName: "p", isRegistered: true, store: store as never,
    });
    return store;
  }

  it("closes the managed PR and marks the group abandoned/closed", async () => {
    const store = mountStore({ ...BASE_GROUP, prState: "open", prNumber: 55, prUrl: "https://example/pr/55" });

    await runBranchGroupAbandon("BG-1");

    expect(closeGroupPullRequestMock).toHaveBeenCalledTimes(1);
    expect(store.updateBranchGroup).toHaveBeenCalledWith(
      "BG-1",
      expect.objectContaining({ status: "abandoned", prState: "closed" }),
    );
    expect(logSpy.mock.calls.flat().join("\n")).toContain("abandoned");
  });

  it("abandons without touching GitHub when there is no open PR", async () => {
    const store = mountStore({ ...BASE_GROUP, prState: "none", prNumber: undefined });

    await runBranchGroupAbandon("BG-1");

    expect(closeGroupPullRequestMock).not.toHaveBeenCalled();
    // A group that never had a PR keeps prState "none" — "closed" would falsely
    // imply a PR existed and was explicitly closed.
    expect(store.updateBranchGroup).toHaveBeenCalledWith(
      "BG-1",
      expect.objectContaining({ status: "abandoned", prState: "none" }),
    );
  });

  it("still marks abandoned when the PR close fails (best-effort)", async () => {
    const store = mountStore({ ...BASE_GROUP, prState: "open", prNumber: 55 });
    closeGroupPullRequestMock.mockRejectedValueOnce(new Error("github down"));

    await runBranchGroupAbandon("BG-1");

    expect(store.updateBranchGroup).toHaveBeenCalledWith(
      "BG-1",
      expect.objectContaining({ status: "abandoned", prState: "closed" }),
    );
  });

  it("rejects abandon of an already-merged group (terminal-state guard)", async () => {
    const store = mountStore({ ...BASE_GROUP, prState: "merged", status: "open" });

    await expect(runBranchGroupAbandon("BG-1")).rejects.toThrow(/process.exit/);
    expect(closeGroupPullRequestMock).not.toHaveBeenCalled();
    expect(store.updateBranchGroup).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join("\n")).toMatch(/finalized\/merged/);
  });

  it("rejects abandon of an already-abandoned group", async () => {
    const store = mountStore({ ...BASE_GROUP, status: "abandoned", prState: "closed" });

    await expect(runBranchGroupAbandon("BG-1")).rejects.toThrow(/process.exit/);
    expect(store.updateBranchGroup).not.toHaveBeenCalled();
  });
});
