import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const previewPlan = vi.fn();
const finalize = vi.fn();
const init = vi.fn();
const getExperimentSessionStore = vi.fn(() => ({}));
const backendShutdown = vi.fn(async () => undefined);

const mockErrors = vi.hoisted(() => ({
  CherryPickConflictError: class extends Error {
    code = "cherry_pick_conflict" as const;
    groupId = "g1";
    commit = "abc";
    stderr = "conflict";
  },
}));

vi.mock("@fusion/core", () => ({
  createTaskStoreForBackend: vi.fn(async () => ({ taskStore: { init, getExperimentSessionStore }, shutdown: backendShutdown })),
  TaskStore: makeConstructibleMock(() => ({ init, getExperimentSessionStore })),
}));

vi.mock("@fusion/engine", () => ({
  defaultGitOps: vi.fn(() => ({})),
  ExperimentFinalizeService: makeConstructibleMock(() => ({ previewPlan, finalize })),
  ExperimentFinalizeStateError: class extends Error { code = "state_error" as const; },
  ExperimentFinalizeNoKeptRunsError: class extends Error { code = "no_kept_runs" as const; },
  ExperimentFinalizePlanError: class extends Error { code = "plan_error" as const; },
  ExperimentFinalizeMergeBaseError: class extends Error { code = "merge_base_error" as const; },
  ExperimentFinalizeBranchExistsError: class extends Error { code = "branch_exists" as const; },
  ExperimentFinalizeCherryPickConflictError: mockErrors.CherryPickConflictError,
}));

import { runExperimentFinalize } from "../commands/experiment-finalize.js";

describe("runExperimentFinalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    init.mockResolvedValue(undefined);
    getExperimentSessionStore.mockReturnValue({});
  });

  it("dry-run calls previewPlan and not finalize", async () => {
    previewPlan.mockResolvedValue({ sessionId: "EXP-1", mergeBaseCommit: "mb", groups: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runExperimentFinalize({ sessionId: "EXP-1", dryRun: true });

    expect(getExperimentSessionStore).toHaveBeenCalled();
    expect(previewPlan).toHaveBeenCalledWith({ sessionId: "EXP-1", integrationBranch: undefined });
    expect(finalize).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(backendShutdown).toHaveBeenCalledTimes(1);
  });

  it("plan-file loads override and passes to finalize", async () => {
    finalize.mockResolvedValue({ sessionId: "EXP-1", branches: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tempDir = await mkdtemp(join(tmpdir(), "fn-4222-"));
    const planPath = join(tempDir, "plan.json");
    await writeFile(planPath, JSON.stringify({ groups: [{ runRecordIds: ["RUN-1"] }] }), "utf8");

    await runExperimentFinalize({ sessionId: "EXP-1", planFile: planPath });

    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ planOverride: { groups: [{ runRecordIds: ["RUN-1"] }] } }));
    logSpy.mockRestore();
  });

  it("cherry-pick conflict exits with code 6", async () => {
    finalize.mockRejectedValue(new mockErrors.CherryPickConflictError("conflict"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runExperimentFinalize({ sessionId: "EXP-1" })).rejects.toThrow("exit:6");
    expect(errSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("json output is parseable", async () => {
    previewPlan.mockResolvedValue({ sessionId: "EXP-1", mergeBaseCommit: "mb", groups: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runExperimentFinalize({ sessionId: "EXP-1", dryRun: true, json: true });

    expect(() => JSON.parse((logSpy.mock.calls[0] ?? ["{}"])[0] as string)).not.toThrow();
    logSpy.mockRestore();
  });

  it("unexpected errors exit with code 1", async () => {
    finalize.mockRejectedValue(new Error("boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

    await expect(runExperimentFinalize({ sessionId: "EXP-1" })).rejects.toThrow("exit:1");

    exitSpy.mockRestore();
  });
});
