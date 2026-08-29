// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import type { BranchGroup, Task, TaskStore } from "@fusion/core";
import { request as REQUEST } from "../test-request.js";

const integratedRouterMocks = vi.hoisted(() => ({
  getOrCreateProjectStore: vi.fn(),
  reconcileBranchGroupPr: vi.fn(async () => ({
    reconciled: false,
    prState: "open",
    prNumber: null,
    prUrl: null,
  })),
}));

vi.mock("../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../project-store-resolver.js")>("../project-store-resolver.js");
  return { ...actual, getOrCreateProjectStore: integratedRouterMocks.getOrCreateProjectStore };
});

// Capture how GitHubClient is constructed so we can assert the configured token
// is forwarded (Fix #1) into the abandon/reconcile close path.
const ctorCalls: Array<unknown> = [];

vi.mock("../github.js", () => {
  class GitHubClient {
    constructor(tokenOrOptions?: unknown) {
      ctorCalls.push(tokenOrOptions);
    }
  }
  return {
    GitHubClient,
    closeGroupPullRequest: vi.fn(async (_client: unknown, group: { prNumber: number; prUrl?: string }) => ({
      prNumber: group.prNumber,
      prUrl: group.prUrl ?? "https://example/pr",
      prState: "closed" as const,
    })),
    reconcileGroupPullRequest: vi.fn(async () => ({ prNumber: 0, prUrl: "", prState: "open" as const })),
  };
});

// reconcileBranchGroupPr is real-ish but harmless here; stub to avoid GitHub.
vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return { ...actual, reconcileBranchGroupPr: integratedRouterMocks.reconcileBranchGroupPr };
});

import { reconcileBranchGroupPr } from "@fusion/engine";
import { closeGroupPullRequest } from "../github.js";
import { registerIntegratedRouters } from "../routes/register-integrated-routers.js";

function buildGroup(): BranchGroup {
  return {
    id: "BG-TOK",
    sourceType: "planning",
    sourceId: "PS-TOK",
    branchName: "feature/tok",
    autoMerge: false,
    prState: "open",
    prNumber: 99,
    prUrl: "https://example/pr/99",
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function buildStore(group: BranchGroup, rootDir = "/tmp/project", tasks: Task[] = []): TaskStore {
  let current = { ...group };
  return {
    getRootDir: vi.fn(() => rootDir),
    getBranchGroup: vi.fn((id: string) => (id === current.id ? current : null)),
    listBranchGroups: vi.fn(() => [current]),
    listTasks: vi.fn(async () => tasks),
    listTasksByBranchGroup: vi.fn(async () => tasks),
    updateBranchGroup: vi.fn((_id: string, patch: Partial<BranchGroup>) => {
      current = { ...current, ...patch };
      return current;
    }),
  } as unknown as TaskStore;
}

describe("integrated branch-groups router — GitHub token wiring (Fix #1)", () => {
  beforeEach(() => {
    ctorCalls.length = 0;
    integratedRouterMocks.getOrCreateProjectStore.mockReset();
    integratedRouterMocks.reconcileBranchGroupPr.mockClear();
    vi.mocked(closeGroupPullRequest).mockClear();
  });

  it("forwards options.githubToken into GitHubClient for the abandon close path", async () => {
    const store = buildStore(buildGroup());
    const router = express.Router();
    registerIntegratedRouters({ router, store, options: { githubToken: "ghp_test_secret" } as any });

    const app = express();
    app.use(express.json());
    app.use("/api", router);

    const res = await REQUEST(app, "POST", "/api/branch-groups/BG-TOK/abandon", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    // The closeGroupPr callback constructed a GitHubClient with the configured token.
    expect(ctorCalls).toContain("ghp_test_secret");
  });

  it("persists reconciliation and resolves GitHub cwd through the selected project store", async () => {
    const defaultStore = buildStore({ ...buildGroup(), branchName: "feature/default", prNumber: 10 }, "/projects/default");
    const secondaryStore = buildStore({ ...buildGroup(), branchName: "feature/secondary", prNumber: 20 }, "/projects/secondary");
    integratedRouterMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const router = express.Router();
    registerIntegratedRouters({ router, store: defaultStore, options: { githubToken: "ghp_scoped" } as any });

    const app = express();
    app.use(express.json());
    app.use("/api", router);

    const read = await REQUEST(app, "GET", "/api/branch-groups/BG-TOK?projectId=secondary");
    expect(read.status).toBe(200);
    expect(read.body.group.branchName).toBe("feature/secondary");
    expect(vi.mocked(reconcileBranchGroupPr)).toHaveBeenCalledWith(expect.objectContaining({
      store: secondaryStore,
      group: expect.objectContaining({ prNumber: 20 }),
      cwd: "/projects/secondary",
    }));
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();

    const abandon = await REQUEST(
      app,
      "POST",
      "/api/branch-groups/BG-TOK/abandon?projectId=secondary",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(abandon.status).toBe(200);
    expect(vi.mocked(closeGroupPullRequest)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prNumber: 20 }),
      "/projects/secondary",
    );
    expect(secondaryStore.updateBranchGroup).toHaveBeenCalledWith(
      "BG-TOK",
      expect.objectContaining({ status: "abandoned", prState: "closed" }),
    );
    expect(defaultStore.updateBranchGroup).not.toHaveBeenCalled();
  });

  it("selects the matching project engine for promotion while gating on its store", async () => {
    const group = buildGroup();
    const completeTask = {
      id: "FN-SCOPED",
      description: "secondary complete task",
      column: "done",
      dependencies: [],
      steps: [],
      currentStep: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" },
      mergeDetails: {
        mergeConfirmed: true,
        mergeTargetSource: "branch-group-integration",
        mergeTargetBranch: group.branchName,
      },
    } as Task;
    const defaultStore = buildStore({ ...group, branchName: "feature/default" }, "/projects/default", []);
    const secondaryStore = buildStore(group, "/projects/secondary", [completeTask]);
    integratedRouterMocks.getOrCreateProjectStore.mockResolvedValue(secondaryStore);
    const promoteBranchGroup = vi.fn(async () => ({ promoted: true }));
    const getEngine = vi.fn(() => ({
      getWorkingDirectory: () => "/projects/secondary-engine",
      promoteBranchGroup,
    }));
    const router = express.Router();
    registerIntegratedRouters({
      router,
      store: defaultStore,
      options: { engineManager: { getEngine } } as any,
    });

    const app = express();
    app.use(express.json());
    app.use("/api", router);
    const response = await REQUEST(
      app,
      "POST",
      "/api/branch-groups/BG-TOK/promote",
      JSON.stringify({ projectId: "secondary" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(getEngine).toHaveBeenCalledWith("secondary");
    expect(promoteBranchGroup).toHaveBeenCalledWith("BG-TOK");
    expect(secondaryStore.listTasksByBranchGroup).toHaveBeenCalledWith("BG-TOK");
    expect(defaultStore.getBranchGroup).not.toHaveBeenCalled();
    expect(defaultStore.listTasksByBranchGroup).not.toHaveBeenCalled();
  });
});
