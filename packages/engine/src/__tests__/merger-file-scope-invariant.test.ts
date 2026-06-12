import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type MergeResult, type Task } from "@fusion/core";
import { createMockStore, mockedExecSync } from "./merger-test-helpers.js";
import {
  assertSquashOverlapsFileScope,
  attemptWithSideStrategy,
  commitOrAmendMergeWithFixes,
  enforceSquashFileScopeInvariant,
  executeMergeAttempt,
  FileScopeViolationError,
} from "../merger.js";

function createInvariantStore(scope: string[], taskOverrides: Record<string, unknown> = {}) {
  const store = createMockStore(taskOverrides) as unknown as {
    parseFileScopeFromPrompt: ReturnType<typeof vi.fn>;
    appendAgentLog: ReturnType<typeof vi.fn>;
    moveTask: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    logEntry: ReturnType<typeof vi.fn>;
  };
  store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue(scope);
  store.appendAgentLog = vi.fn().mockResolvedValue(undefined);
  store.moveTask = vi.fn().mockResolvedValue(undefined);
  store.updateTask = vi.fn().mockResolvedValue(undefined);
  store.logEntry = vi.fn().mockResolvedValue(undefined);
  return store;
}

function createMergeResult(): MergeResult {
  const task: Task = {
    id: "FN-4073",
    description: "Test task",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    task,
    branch: "fn/fn-4073",
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };
}

let stagedFilesReader: (cwd: string) => Promise<string[]> = vi.fn(async () => []);

function mockStagedFiles(files: string[]) {
  stagedFilesReader = vi.fn(async (_cwd: string) => files);
}

describe("assertSquashOverlapsFileScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStagedFiles([]);
  });

  it("passes without logging when no declared scope exists", async () => {
    const store = createInvariantStore([]);
    mockStagedFiles(["packages/engine/src/merger.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("passes without logging when staged files fully overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles(["packages/engine/src/merger.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).not.toHaveBeenCalled();
  });

  it("passes when staged files partially overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles([
      "packages/engine/src/merger.ts",
      "packages/core/src/store.ts",
    ]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("throws when staged files have zero overlap with scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).rejects.toMatchObject({
      name: "FileScopeViolationError",
      taskId: "FN-4073",
      stagedFiles: ["packages/core/src/store.ts"],
      declaredScope: ["packages/engine/src/merger.ts"],
    } satisfies Partial<FileScopeViolationError>);
  });

  it("matches nested files against glob entries", async () => {
    const store = createInvariantStore(["packages/foo/**"]);
    mockStagedFiles(["packages/foo/src/bar/baz.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("ignores .changeset files for overlap and still throws without real overlap", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockStagedFiles([".changeset/foo.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).rejects.toMatchObject({
      name: "FileScopeViolationError",
      stagedFiles: [".changeset/foo.md"],
    } satisfies Partial<FileScopeViolationError>);
  });

  it("accepts declared scope as a single changeset file when staged matches exactly", async () => {
    const store = createInvariantStore([".changeset/fn-4767-pr-flow.md"]);
    mockStagedFiles([".changeset/fn-4767-pr-flow.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("accepts declared scope as a changeset glob when staged file matches", async () => {
    const store = createInvariantStore([".changeset/*.md"]);
    mockStagedFiles([".changeset/fn-4767-pr-flow.md"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();
  });

  it("bypasses enforcement and logs once when scopeOverride is true", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], { scopeOverride: true });
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledTimes(1);
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride",
      "text",
      undefined,
      "merger",
    );
  });

  it("includes the override reason in the bypass log", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], {
      scopeOverride: true,
      scopeOverrideReason: "hotfix",
    });
    mockStagedFiles(["packages/core/src/store.ts"]);

    await expect(assertSquashOverlapsFileScope({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride — reason: hotfix",
      "text",
      undefined,
      "merger",
    );
  });
});

describe("enforceSquashFileScopeInvariant audit emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStagedFiles(["packages/core/src/store.ts"]);
  });

  it("emits run_audit event on file-scope violation but continues", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      return "";
    });

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("Warning only — continuing merge."),
      "text",
      expect.stringContaining("declaredScope:"),
      "merger",
    );
    expect(auditor.git).toHaveBeenCalledTimes(1);
    expect(auditor.git).toHaveBeenCalledWith({
      type: "merge:file-scope-violation",
      target: "FN-4073",
      metadata: {
        resetLabel: "file-scope invariant violation",
        stagedFiles: ["packages/core/src/store.ts"],
        declaredScope: ["packages/engine/src/merger.ts"],
        stagedFileCount: 1,
        declaredScopeCount: 1,
        warningOnly: true,
      },
    });
  });

  it("does not emit when scopeOverride bypasses invariant", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], { scopeOverride: true });
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };
    mockedExecSync.mockImplementation(() => "packages/core/src/store.ts");

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).resolves.toBeUndefined();

    expect(auditor.git).not.toHaveBeenCalled();
  });

  it("does not fail when audit emission fails", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    const auditor = { git: vi.fn().mockRejectedValue(new Error("audit boom")) };
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      return "";
    });

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
      auditor: auditor as any,
    })).resolves.toBeUndefined();

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("File-scope invariant violation"),
      "text",
      expect.stringContaining("declaredScope:"),
      "merger",
    );
  });

  it("keeps backward compatibility when auditor is omitted", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      return "";
    });

    await expect(enforceSquashFileScopeInvariant({
      store: store as never,
      taskId: "FN-4073",
      rootDir: "/tmp/root",
      stagedFilesReader,
      task: await (store as any).getTask("FN-4073"),
      resetLabel: "file-scope invariant violation",
    })).resolves.toBeUndefined();
  });
});

describe("file-scope invariant wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns but allows the standard merge AI path when staged files are out of scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      return "";
    });

    const result = createMergeResult();
    await expect(executeMergeAttempt({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-branch",
      attemptNum: 1,
      options: {},
      result,
      settings: { ...DEFAULT_SETTINGS },
    }, { aiWasInvoked: false })).resolves.toEqual(expect.any(Boolean));

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("Warning only — continuing merge."),
      "text",
      expect.stringContaining("declaredScope:"),
      "merger",
    );
    expect(mockedExecSync).not.toHaveBeenCalledWith("git reset --merge", expect.objectContaining({ cwd: "/tmp/root" }));
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("allows the -X fallback commit when staged files partially overlap scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git merge -X ours --squash")) return "";
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr === "git diff --cached --name-only") return "packages/engine/src/merger.ts\npackages/core/src/store.ts";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(attemptWithSideStrategy({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      sourceIssueRef: undefined,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-main",
      attemptNum: 3,
      options: {},
      result: createMergeResult(),
      settings: { ...DEFAULT_SETTINGS },
    }, "ours")).resolves.toBe(true);

    expect(store.appendAgentLog).not.toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("File-scope invariant violation"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("bypasses the -X fallback invariant when scopeOverride is true and logs the reason", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"], {
      scopeOverride: true,
      scopeOverrideReason: "hotfix",
    });
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git merge -X ours --squash")) return "";
      if (cmdStr.includes("git diff --name-only --diff-filter=U")) return "";
      if (cmdStr.includes("git diff --cached --quiet")) return "1";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(attemptWithSideStrategy({
      store: store as never,
      rootDir: "/tmp/root",
      taskId: "FN-4073",
      branch: "fn/fn-4073",
      commitLog: "feat: branch work",
      diffStat: "1 file changed",
      includeTaskId: true,
      sourceIssueRef: undefined,
      smartConflictResolution: true,
      mergeConflictStrategy: "smart-prefer-main",
      attemptNum: 3,
      options: {},
      result: createMergeResult(),
      settings: { ...DEFAULT_SETTINGS },
    }, "ours")).resolves.toBe(true);

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      "file-scope invariant bypassed via scopeOverride — reason: hotfix",
      "text",
      undefined,
      "merger",
    );
  });

  it("warns but allows verification-fix finalization when staged files are out of scope", async () => {
    const store = createInvariantStore(["packages/engine/src/merger.ts"]);
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr === "git diff --cached --name-only") return "packages/core/src/store.ts";
      if (cmdStr === "git diff --name-only") return "";
      if (cmdStr === "git status -z --porcelain") return "";
      if (cmdStr === "git diff --cached --raw") return "";
      if (cmdStr === "git rev-parse HEAD") return "head-before";
      if (cmdStr.includes("git commit ")) return "";
      return "";
    });

    await expect(commitOrAmendMergeWithFixes(
      "/tmp/root",
      "FN-4073",
      "fn/fn-4073",
      "feat: branch work",
      true,
      "head-before",
      "",
      "1 file changed",
      { ...DEFAULT_SETTINGS },
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(),
      store as never,
    )).resolves.toMatchObject({ ok: true, reason: "committed" });

    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-4073",
      expect.stringContaining("Warning only — continuing merge."),
      "text",
      expect.stringContaining("stagedFiles:"),
      "merger",
    );
    expect(mockedExecSync).not.toHaveBeenCalledWith("git reset --merge", expect.objectContaining({ cwd: "/tmp/root" }));
  });
});
