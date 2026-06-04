// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import type { BranchGroup, Task, TaskStore } from "@fusion/core";
import { request as REQUEST } from "../test-request.js";

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
  return { ...actual, reconcileBranchGroupPr: vi.fn(async () => ({ reconciled: false, prState: "open", prNumber: null, prUrl: null })) };
});

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

function buildStore(group: BranchGroup): TaskStore {
  let current = { ...group };
  return {
    getRootDir: vi.fn(() => "/tmp/project"),
    getBranchGroup: vi.fn(() => current),
    listBranchGroups: vi.fn(() => [current]),
    listTasks: vi.fn(async () => [] as Task[]),
    listTasksByBranchGroup: vi.fn(async () => [] as Task[]),
    updateBranchGroup: vi.fn((_id: string, patch: Partial<BranchGroup>) => {
      current = { ...current, ...patch };
      return current;
    }),
  } as unknown as TaskStore;
}

describe("integrated branch-groups router — GitHub token wiring (Fix #1)", () => {
  beforeEach(() => {
    ctorCalls.length = 0;
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
});
