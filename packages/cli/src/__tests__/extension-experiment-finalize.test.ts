import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowAuthoringEngineMock } from "./helpers/engine-workflow-authoring-mock.js";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const previewPlanMock = vi.hoisted(() => vi.fn());
const finalizeMock = vi.hoisted(() => vi.fn());

const mockErrors = vi.hoisted(() => ({
  StateError: class extends Error { code = "state_error" as const; },
  NoKeptError: class extends Error { code = "no_kept_runs" as const; },
  PlanError: class extends Error { code = "plan_error" as const; },
  MergeBaseError: class extends Error { code = "merge_base_error" as const; },
  BranchExistsError: class extends Error { code = "branch_exists" as const; },
  CherryPickError: class extends Error {
    code = "cherry_pick_conflict" as const;
    groupId = "g-1";
    commit = "abc";
    stderr = "conflict";
  },
}));

vi.mock("@fusion/core", () => ({
  TaskStore: makeConstructibleMock(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getExperimentSessionStore: vi.fn(() => ({})),
  })),
  COLUMNS: [],
  COLUMN_LABELS: {},
  validateNodeOverrideChange: vi.fn(),
  RESEARCH_RUN_STATUSES: [],
  isResearchExperimentalEnabled: vi.fn(() => true),
  resolveResearchSettings: vi.fn(() => ({})),
  canAgentTakeImplementationTaskForExplicitRouting: vi.fn(() => true),
  formatRoleMismatchReason: vi.fn(() => ""),
  resolveAgentProvisioningPolicy: vi.fn(() => ({ approvalMode: "auto" })),
  TASK_PRIORITIES: ["low", "normal", "high", "urgent"],
  getProjectRootFromWorktree: vi.fn(() => null),
}));

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: vi.fn(),
  // FNXC:CliTests 2026-07-13-09:40: Missing dashboard barrel exports added for mock completeness (scripts/check-mock-completeness.mjs gate).
  GitLabClient: vi.fn(),
  resolveGitlabAuth: vi.fn(() => ({})),
  buildGitLabTaskProvenance: vi.fn(() => ({})),
  isGitLabAlreadyImported: vi.fn(),
  buildGitLabTaskDescription: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  ...workflowAuthoringEngineMock,
  createFnAgent: vi.fn(),
  fetchWebContent: vi.fn(),
  emitGoalRetrievalAudit: vi.fn(),
  createWorkflowAuthoringTools: vi.fn(() => ({})),
  workflowListParams: {},
  workflowGetParams: {},
  workflowValidateParams: {}, // FNXC:Round10 FN-7911 added this export to @fusion/engine barrel
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
  normalizeAgentLogPaging: vi.fn(() => ({ limit: 100, offset: 0 })),
  renderAgentLogEntries: vi.fn(() => ""),
  defaultGitOps: vi.fn(() => ({})),
  ExperimentFinalizeService: makeConstructibleMock(() => ({ previewPlan: previewPlanMock, finalize: finalizeMock })),
  ExperimentFinalizeStateError: mockErrors.StateError,
  ExperimentFinalizeNoKeptRunsError: mockErrors.NoKeptError,
  ExperimentFinalizePlanError: mockErrors.PlanError,
  ExperimentFinalizeMergeBaseError: mockErrors.MergeBaseError,
  ExperimentFinalizeBranchExistsError: mockErrors.BranchExistsError,
  ExperimentFinalizeCherryPickConflictError: mockErrors.CherryPickError,
}));

import kbExtension, {
  __setCachedStoreForTesting,
  closeCachedStores,
} from "../extension.js";

describe("extension fn_experiment_finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /*
    FNXC:CliTests 2026-07-16-08:58:
    FN-8102 injects the experiment-session store through the extension cache so
    the test reaches ExperimentFinalizeService instead of booting a real store.
    The mocked engine error classes therefore remain the exact identities used
    by the extension's instanceof error-to-code mapping.
    */
    __setCachedStoreForTesting(process.cwd(), {
      getExperimentSessionStore: vi.fn(() => ({})),
    } as any);
  });

  afterEach(async () => {
    await closeCachedStores();
  });

  function getTool() {
    const tools = new Map<string, any>();
    kbExtension({
      registerTool(def: any) {
        tools.set(def.name, def);
      },
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      on: vi.fn(),
    } as any);
    return tools.get("fn_experiment_finalize");
  }

  it("supports dry-run preview", async () => {
    const tool = getTool();
    previewPlanMock.mockResolvedValue({ sessionId: "EXP-1", groups: [], mergeBaseCommit: "abc" });

    const result = await tool.execute("id", { sessionId: "EXP-1", dryRun: true }, undefined, undefined, { cwd: process.cwd() });

    expect(previewPlanMock).toHaveBeenCalledWith({ sessionId: "EXP-1", integrationBranch: undefined });
    expect(result.isError).toBeUndefined();
    expect(result.details.plan.sessionId).toBe("EXP-1");
  });

  it("supports finalize success", async () => {
    const tool = getTool();
    finalizeMock.mockResolvedValue({ sessionId: "EXP-2", branches: [{ name: "b1" }] });

    const result = await tool.execute("id", { sessionId: "EXP-2", summary: "done" }, undefined, undefined, { cwd: process.cwd() });

    expect(finalizeMock).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Finalized EXP-2");
  });

  it("surfaces no kept runs error", async () => {
    const tool = getTool();
    finalizeMock.mockRejectedValue(new mockErrors.NoKeptError("no kept"));

    const result = await tool.execute("id", { sessionId: "EXP-3" }, undefined, undefined, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("no_kept_runs");
  });

  it("surfaces cherry-pick conflict details", async () => {
    const tool = getTool();
    finalizeMock.mockRejectedValue(new mockErrors.CherryPickError("conflict"));

    const result = await tool.execute("id", { sessionId: "EXP-4" }, undefined, undefined, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: "cherry_pick_conflict", groupId: "g-1", commit: "abc", stderr: "conflict" });
  });

  it("returns tool result contract", async () => {
    const tool = getTool();
    previewPlanMock.mockResolvedValue({ sessionId: "EXP-5", groups: [], mergeBaseCommit: "abc" });

    const result = await tool.execute("id", { sessionId: "EXP-5", dryRun: true }, undefined, undefined, { cwd: process.cwd() });

    expect(Array.isArray(result.content)).toBe(true);
    expect(typeof result.content[0].text).toBe("string");
  });
});
