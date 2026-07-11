import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The pr command resolves its store via project-context.resolveProject (same
// pattern branch-group.ts uses) and fires user-controlled releases via the
// engine's releaseHeldTaskByEvent primitive — the EXACT path the dashboard U7
// routes use (register-integrated-routers.ts). Both are mocked so each
// subcommand can be asserted to route to the right store/engine path.
// FNXC:CliBoardMutation 2026-07-09-00:00: pr.ts imports closeProjectStore +
// asLocalProjectContext from project-context (every run* subcommand closes its
// resolved store in a finally; the CWD-fallback branch wraps an uncached store
// via asLocalProjectContext). Stub both so the whole-module mock stays accurate
// and does not break when pr.ts newly imports another project-context export.
vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn(),
  closeProjectStore: vi.fn(async (context: { store: { close?: () => unknown } }) => {
    try {
      await context.store.close?.();
    } catch {
      // best-effort, mirrors production closeProjectStore
    }
  }),
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
}));

const releaseHeldTaskByEvent = vi.fn();
vi.mock("@fusion/engine", () => ({
  releaseHeldTaskByEvent: (...args: unknown[]) => releaseHeldTaskByEvent(...args),
}));

// @fusion/dashboard is touched by runPrCreate; stub it so importing the module
// never pulls the heavy dashboard graph. `createPr` is controllable so the create
// path can be asserted to write the unified PR entity.
const createPr = vi.fn();
vi.mock("@fusion/dashboard", () => ({
  GitHubClient: class {
    createPr(...args: unknown[]) {
      return createPr(...args);
    }
  },
  generatePrMetadata: vi.fn(),
}));

// gh-cli helpers used by runPrCreate (repo resolution + auth gating).
vi.mock("@fusion/core/gh-cli", () => ({
  classifyGhError: vi.fn(() => ({ message: "err" })),
  getGhErrorMessage: vi.fn(() => "err"),
  getCurrentRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
  isGhAuthenticated: vi.fn(() => true),
  isGhAvailable: vi.fn(() => true),
}));

const { resolveProject } = await import("../project-context.js");
const {
  runPrCreate,
  runPrList,
  runPrShow,
  runPrApprove,
  runPrRespond,
  runPrRetry,
  runPrMerge,
  runPrClose,
  runPrAutomerge,
} = await import("../commands/pr.js");

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR-001",
    sourceType: "task",
    sourceId: "FN-001",
    repo: "owner/repo",
    headBranch: "fusion/fn-001",
    baseBranch: "main",
    state: "open",
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    autoMerge: false,
    unverified: false,
    responseRounds: 0,
    mergeable: "clean",
    reviewDecision: "APPROVED",
    checksRollup: "success",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("fn pr commands", () => {
  const originalExit = process.exit;
  let storeMock: Record<string, ReturnType<typeof vi.fn>>;

  function mockStore(store: Record<string, ReturnType<typeof vi.fn>>) {
    storeMock = store;
    vi.mocked(resolveProject).mockResolvedValue({
      store: store as never,
      projectPath: "/tmp/project",
      projectName: "proj",
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    releaseHeldTaskByEvent.mockResolvedValue({ released: true, toColumn: "merged" });
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  // ── create → legacy prInfo + unified PR entity ──────────────────────────────

  it("runPrCreate writes the unified PR entity (not just legacy prInfo)", async () => {
    const prInfo = {
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      status: "open",
      title: "T",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
    };
    delete process.env.GITHUB_REPOSITORY;
    createPr.mockResolvedValue(prInfo);
    const getTask = vi.fn().mockResolvedValue({
      id: "FN-001",
      title: "Task one",
      description: "do a thing",
      column: "in-review",
      prInfo: undefined,
    });
    const updatePrInfo = vi.fn();
    const ensurePrEntityForSource = vi.fn().mockReturnValue(makeEntity({ id: "PR-NEW", state: "creating" }));
    const updatePrEntity = vi.fn().mockReturnValue(makeEntity({ id: "PR-NEW" }));
    const logEntry = vi.fn();
    mockStore({ getTask, updatePrInfo, ensurePrEntityForSource, updatePrEntity, logEntry });

    await runPrCreate("FN-001", { ai: false });

    // Legacy field is still written (additive, migration-safe).
    expect(updatePrInfo).toHaveBeenCalledWith("FN-001", prInfo);
    // Unified entity is created via the same store path the pr-create node uses.
    expect(ensurePrEntityForSource).toHaveBeenCalledWith({
      sourceType: "task",
      sourceId: "FN-001",
      repo: "owner/repo",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      state: "creating",
    });
    // …then flipped to open with the persisted PR number/url.
    expect(updatePrEntity).toHaveBeenCalledWith("PR-NEW", {
      state: "open",
      prNumber: 7,
      prUrl: "https://github.com/owner/repo/pull/7",
    });
  });

  // ── read commands ──────────────────────────────────────────────────────────

  it("runPrList reads active entities from the store", async () => {
    const listActivePrEntities = vi.fn().mockReturnValue([makeEntity()]);
    mockStore({ listActivePrEntities });
    await runPrList();
    expect(listActivePrEntities).toHaveBeenCalledOnce();
  });

  it("runPrShow reads the entity + thread states by id", async () => {
    const getPrEntity = vi.fn().mockReturnValue(makeEntity());
    const listPrThreadStates = vi.fn().mockReturnValue([]);
    mockStore({ getPrEntity, listPrThreadStates });
    await runPrShow("PR-001");
    expect(getPrEntity).toHaveBeenCalledWith("PR-001");
    expect(listPrThreadStates).toHaveBeenCalledWith("PR-001");
  });

  it("runPrShow exits when the entity is missing", async () => {
    mockStore({ getPrEntity: vi.fn().mockReturnValue(null), listPrThreadStates: vi.fn() });
    await expect(runPrShow("PR-404")).rejects.toThrow("process.exit:1");
  });

  // ── user-controlled release actions → releaseHeldTaskByEvent ────────────────

  it.each([
    { fn: runPrApprove, eventTag: "pr-approve" },
    { fn: runPrRespond, eventTag: "pr-respond" },
    { fn: runPrRetry, eventTag: "pr-retry" },
    { fn: runPrMerge, eventTag: "pr-merge" },
    { fn: runPrClose, eventTag: "pr-close" },
  ])("routes $eventTag to releaseHeldTaskByEvent on the source task", async ({ fn, eventTag }) => {
    const getPrEntity = vi.fn().mockReturnValue(makeEntity());
    mockStore({ getPrEntity });
    await fn("PR-001");
    expect(getPrEntity).toHaveBeenCalledWith("PR-001");
    expect(releaseHeldTaskByEvent).toHaveBeenCalledWith(storeMock, "FN-001", eventTag);
  });

  it("merge is rejected on a conflicting entity (no release fired)", async () => {
    mockStore({ getPrEntity: vi.fn().mockReturnValue(makeEntity({ mergeable: "conflicting" })) });
    await expect(runPrMerge("PR-001")).rejects.toThrow("process.exit:1");
    expect(releaseHeldTaskByEvent).not.toHaveBeenCalled();
  });

  it("release actions are rejected on a terminal entity", async () => {
    mockStore({ getPrEntity: vi.fn().mockReturnValue(makeEntity({ state: "merged" })) });
    await expect(runPrApprove("PR-001")).rejects.toThrow("process.exit:1");
    expect(releaseHeldTaskByEvent).not.toHaveBeenCalled();
  });

  it("release action exits non-zero when the release does not fire", async () => {
    mockStore({ getPrEntity: vi.fn().mockReturnValue(makeEntity()) });
    releaseHeldTaskByEvent.mockResolvedValue({ released: false, rejection: "not-external-event-hold" });
    await expect(runPrApprove("PR-001")).rejects.toThrow("process.exit:1");
  });

  // ── automerge → store.updatePrEntity ────────────────────────────────────────

  it("runPrAutomerge toggles entity.autoMerge via updatePrEntity", async () => {
    const getPrEntity = vi.fn().mockReturnValue(makeEntity({ autoMerge: false }));
    const updatePrEntity = vi.fn().mockReturnValue(makeEntity({ autoMerge: true }));
    mockStore({ getPrEntity, updatePrEntity });
    await runPrAutomerge("PR-001", undefined);
    expect(updatePrEntity).toHaveBeenCalledWith("PR-001", { autoMerge: true });
  });

  it("runPrAutomerge honors an explicit off toggle", async () => {
    const getPrEntity = vi.fn().mockReturnValue(makeEntity({ autoMerge: true }));
    const updatePrEntity = vi.fn().mockReturnValue(makeEntity({ autoMerge: false }));
    mockStore({ getPrEntity, updatePrEntity });
    await runPrAutomerge("PR-001", false);
    expect(updatePrEntity).toHaveBeenCalledWith("PR-001", { autoMerge: false });
  });
});

// Surface-parity consistency test: every PR action the dashboard exposes (U7's
// register-pull-requests-routes.ts / register-integrated-routers.ts) must have a
// `fn pr` subcommand — a capability can't exist on one surface only.
describe("PR surface parity (dashboard ⊆ CLI)", () => {
  const cliSource = readFileSync(resolve(__dirname, "../bin.ts"), "utf8");

  // The dashboard's PR action set, derived from the U7 routes:
  //   GET /  (list), GET /:id (show), POST :id/approve|merge|retry|close,
  //   POST :id/automerge, plus the create capability (pr-create node).
  // pr-respond is the CLI-exposed rework round (same release authority).
  const dashboardActions = [
    "create",
    "list",
    "show",
    "approve",
    "retry",
    "merge",
    "close",
    "automerge",
  ];

  it.each(dashboardActions)("`fn pr %s` is wired in bin.ts", (action) => {
    expect(cliSource).toContain(`case "${action}":`);
  });

  it("respond (review-response loop) is also exposed", () => {
    expect(cliSource).toContain('case "respond":');
  });
});
