import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the cwd handed to the response agent runner and the git-ops resolver,
// so these tests can assert which directory the respond run actually targets.
const agentRunnerCalls = vi.hoisted(() => [] as Array<{ taskId: string; cwd: string }>);
const gitOpsResolvers = vi.hoisted(() => [] as Array<(entity: unknown) => string>);

vi.mock("../pr-response-run-ops.js", () => ({
  makePrResponseAgentRunner: vi.fn((_settings: unknown, taskId: string, cwd: string) => {
    agentRunnerCalls.push({ taskId, cwd });
    return vi.fn();
  }),
  makePrResponseGitOps: vi.fn((getCwd: (entity: unknown) => string) => {
    gitOpsResolvers.push(getCwd);
    return {
      getChangedContent: vi.fn(),
      getWorktreeHeadOid: vi.fn(),
      fetchAndFastForwardPush: vi.fn(),
    };
  }),
}));

vi.mock("../pr-response-run.js", () => ({
  runPrResponseRun: vi.fn(async () => ({ value: "resolved-all" })),
}));

import { buildRespondCallback } from "../pr-nodes.js";

const entity = {
  id: "pr-entity-1",
  sourceType: "task",
  sourceId: "FN-1",
  repo: "owner/repo",
  headBranch: "fusion/fn-1",
  state: "open",
  autoMerge: false,
  unverified: false,
  responseRounds: 0,
  createdAt: 1,
  updatedAt: 1,
  prNumber: 7,
} as never;

function makeOps(getCwd: (e: unknown) => string) {
  return {
    getReviewThreads: vi.fn(async () => []),
    getViewerLogin: vi.fn(async () => "viewer"),
    checkPrStillOpen: vi.fn(async () => ({ open: true, headOid: null })),
    replyToThread: vi.fn(),
    resolveThread: vi.fn(),
    getCwd,
    getTaskId: () => "FN-1",
  } as never;
}

function makeStore(worktree?: string, opts?: { getTaskThrows?: boolean }) {
  return {
    getSettings: vi.fn(async () => ({})),
    getTask: opts?.getTaskThrows
      ? vi.fn(async () => {
          throw new Error("missing task");
        })
      : vi.fn(async () => ({ id: "FN-1", worktree })),
  };
}

beforeEach(() => {
  agentRunnerCalls.length = 0;
  gitOpsResolvers.length = 0;
});

describe("buildRespondCallback cwd resolution (gh-4)", () => {
  it("prefers the task's recorded worktree over the CLI getCwd resolver (process.cwd() in central installs)", async () => {
    const getCwd = vi.fn(() => "/central/install-dir");
    const respond = buildRespondCallback(
      () => makeStore("/projects/repo-a/.worktrees/fn-1") as never,
      makeOps(getCwd),
    );

    const result = await respond({ entity } as never);

    expect(result).toEqual({ value: "resolved-all" });
    expect(agentRunnerCalls).toEqual([{ taskId: "FN-1", cwd: "/projects/repo-a/.worktrees/fn-1" }]);
    expect(gitOpsResolvers).toHaveLength(1);
    expect(gitOpsResolvers[0](entity)).toBe("/projects/repo-a/.worktrees/fn-1");
  });

  it("falls back to the CLI getCwd resolver when the task has no recorded worktree", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const respond = buildRespondCallback(() => makeStore(undefined) as never, makeOps(getCwd));

    await respond({ entity } as never);

    expect(agentRunnerCalls).toEqual([{ taskId: "FN-1", cwd: "/single-project/checkout" }]);
    expect(gitOpsResolvers[0](entity)).toBe("/single-project/checkout");
  });

  it("falls back to the CLI getCwd resolver when the task lookup fails", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const respond = buildRespondCallback(
      () => makeStore(undefined, { getTaskThrows: true }) as never,
      makeOps(getCwd),
    );

    await respond({ entity } as never);

    expect(agentRunnerCalls).toEqual([{ taskId: "FN-1", cwd: "/single-project/checkout" }]);
  });

  it("falls back to the CLI getCwd resolver on structural stores without getTask (PrNodeStore does not declare it)", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const storeWithoutGetTask = { getSettings: vi.fn(async () => ({})) };
    const respond = buildRespondCallback(() => storeWithoutGetTask as never, makeOps(getCwd));

    await respond({ entity } as never);

    expect(agentRunnerCalls).toEqual([{ taskId: "FN-1", cwd: "/single-project/checkout" }]);
  });
});
