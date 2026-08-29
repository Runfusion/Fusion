import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the cwd + store handed to the response agent runner and the git-ops
// resolver, so these tests can assert which directory the respond run actually
// targets and that getTask-less structural stores are withheld from the runner.
const agentRunnerCalls = vi.hoisted(
  () => [] as Array<{ taskId: string; cwd: string; store: unknown }>,
);
const gitOpsResolvers = vi.hoisted(() => [] as Array<(entity: unknown) => string>);

vi.mock("../merge/pr-response-run-ops.js", () => ({
  makePrResponseAgentRunner: vi.fn(
    (_settings: unknown, taskId: string, cwd: string, store: unknown) => {
      agentRunnerCalls.push({ taskId, cwd, store });
      return vi.fn();
    },
  ),
  makePrResponseGitOps: vi.fn((getCwd: (entity: unknown) => string) => {
    gitOpsResolvers.push(getCwd);
    return {
      getChangedContent: vi.fn(),
      getWorktreeHeadOid: vi.fn(),
      fetchAndFastForwardPush: vi.fn(),
    };
  }),
}));

vi.mock("../merge/pr-response-run.js", () => ({
  runPrResponseRun: vi.fn(async () => ({ value: "resolved-all" })),
}));

import { buildRespondCallback } from "../merge/pr-nodes.js";

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
    const store = makeStore("/projects/repo-a/.worktrees/fn-1");
    const respond = buildRespondCallback(() => store as never, makeOps(getCwd));

    const result = await respond({ entity } as never);

    expect(result).toEqual({ value: "resolved-all" });
    expect(agentRunnerCalls).toEqual([
      { taskId: "FN-1", cwd: "/projects/repo-a/.worktrees/fn-1", store },
    ]);
    expect(gitOpsResolvers).toHaveLength(1);
    expect(gitOpsResolvers[0](entity)).toBe("/projects/repo-a/.worktrees/fn-1");
  });

  it("falls back to the CLI getCwd resolver when the task has no recorded worktree", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const store = makeStore(undefined);
    const respond = buildRespondCallback(() => store as never, makeOps(getCwd));

    await respond({ entity } as never);

    expect(agentRunnerCalls).toEqual([{ taskId: "FN-1", cwd: "/single-project/checkout", store }]);
    expect(gitOpsResolvers[0](entity)).toBe("/single-project/checkout");
  });

  it("propagates a real store read failure instead of silently running in the fallback cwd (routable respond-error at the node)", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const respond = buildRespondCallback(
      () => makeStore(undefined, { getTaskThrows: true }) as never,
      makeOps(getCwd),
    );

    await expect(respond({ entity } as never)).rejects.toThrow("missing task");
    expect(agentRunnerCalls).toEqual([]);
    expect(gitOpsResolvers).toEqual([]);
  });

  it("falls back to the CLI getCwd resolver on structural stores without getTask, and withholds the store from the agent runner", async () => {
    const getCwd = vi.fn(() => "/single-project/checkout");
    const storeWithoutGetTask = { getSettings: vi.fn(async () => ({})) };
    const respond = buildRespondCallback(() => storeWithoutGetTask as never, makeOps(getCwd));

    await respond({ entity } as never);

    expect(agentRunnerCalls).toEqual([
      { taskId: "FN-1", cwd: "/single-project/checkout", store: undefined },
    ]);
  });
});
