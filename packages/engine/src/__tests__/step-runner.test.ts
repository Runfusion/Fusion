/**
 * Unit tests for the U2 substrate seams (plan 2026-06-04-001, KTD-2):
 *   - runTaskStep — per-step driver over step-session physics.
 *   - resetStepToBaseline — verbatim RETHINK mechanics + blast-radius guard.
 *
 * Fast tests: real git / sessions / StepSessionExecutor are never touched —
 * every external is injected via the explicit `deps` object (FN-5048 fake-timer
 * convention is moot here since the seams take no clock). The executor's
 * delegation of the legacy RETHINK block is characterized separately in
 * executor-step-session.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTaskStep,
  resetStepToBaseline,
  makeAncestryBlastRadiusGuard,
  isUsableWorktreeDirectory,
  type StepRunnerTask,
  type SessionRef,
} from "../step-runner.js";

function makeStore() {
  return {
    startStep: vi.fn().mockResolvedValue({
      accepted: true,
      disposition: "started",
      task: makeTask([{ name: "Implement", status: "in-progress" }]),
    }),
    updateStep: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTask(steps: Array<{ name?: string; status?: string }>): StepRunnerTask {
  return { id: "FN-001", steps };
}

function makeSessionRef(opts?: {
  navigateTree?: ReturnType<typeof vi.fn>;
  branchWithSummary?: ReturnType<typeof vi.fn>;
  leafId?: string;
}): SessionRef {
  const navigateTree = opts?.navigateTree ?? vi.fn().mockResolvedValue(undefined);
  const branchWithSummary = opts?.branchWithSummary ?? vi.fn();
  return {
    current: {
      navigateTree,
      sessionManager: {
        branchWithSummary,
        getLeafId: vi.fn().mockReturnValue(opts?.leafId ?? "leaf-pre-step"),
      },
    } as unknown as SessionRef["current"],
  };
}

describe("runTaskStep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the step in-progress then done on success, capturing baseline + checkpoint", async () => {
    const store = makeStore();
    const task = makeTask([{ name: "Implement", status: "pending" }]);
    const gitRevParse = vi.fn().mockResolvedValue("baseSHA123");
    const captureCheckpointId = vi.fn().mockReturnValue("leaf-pre-step");
    const runStep = vi.fn().mockResolvedValue({ success: true });

    const result = await runTaskStep(
      { store, worktreePath: "/wt", runStep, gitRevParse, captureCheckpointId },
      task,
      0,
    );

    expect(result).toEqual({ outcome: "success", baselineSha: "baseSHA123", checkpointId: "leaf-pre-step" });
    // Baseline is captured BEFORE the step runs.
    expect(gitRevParse).toHaveBeenCalledWith("/wt");
    expect(runStep).toHaveBeenCalledWith(0);
    // FNXC:StepLifecycle 2026-07-22-10:30: The accepted start projection must precede terminal completion.
    expect(store.startStep).toHaveBeenCalledWith("FN-001", 0);
    expect(store.updateStep.mock.calls).toEqual([["FN-001", 0, "done"]]);
  });

  it("passes graph projection source through in-progress and done writes", async () => {
    const store = makeStore();
    const runStep = vi.fn().mockResolvedValue({ success: true });

    await runTaskStep(
      {
        store,
        worktreePath: "/wt",
        runStep,
        gitRevParse: async () => "baseSHA",
        captureCheckpointId: () => "leaf",
      },
      makeTask([{ name: "Independent", status: "pending" }]),
      0,
      { projectionSource: "graph" },
    );

    expect(store.startStep).toHaveBeenCalledWith("FN-001", 0, { source: "graph" });
    expect(store.updateStep.mock.calls).toEqual([
      ["FN-001", 0, "done", { source: "graph" }],
    ]);
  });

  it("captures the baseline before running the step (order check)", async () => {
    const store = makeStore();
    const order: string[] = [];
    const gitRevParse = vi.fn().mockImplementation(async () => {
      order.push("baseline");
      return "sha";
    });
    const runStep = vi.fn().mockImplementation(async () => {
      order.push("run");
      return { success: true };
    });

    await runTaskStep(
      { store, worktreePath: "/wt", runStep, gitRevParse, captureCheckpointId: () => "leaf" },
      makeTask([{ status: "pending" }]),
      0,
    );

    expect(order).toEqual(["baseline", "run"]);
  });

  it("leaves the step non-done on failure (no 'done'/'skipped' write)", async () => {
    const store = makeStore();
    const runStep = vi.fn().mockResolvedValue({ success: false, error: "boom" });

    const result = await runTaskStep(
      {
        store,
        worktreePath: "/wt",
        runStep,
        gitRevParse: async () => "baseSHA",
        captureCheckpointId: () => "leaf",
      },
      makeTask([{ status: "pending" }]),
      0,
    );

    expect(result).toEqual({ outcome: "failure", baselineSha: "baseSHA", checkpointId: "leaf" });
    // FNXC:StepLifecycle 2026-07-22-10:30: A failed run preserves the accepted non-terminal start.
    expect(store.startStep).toHaveBeenCalledWith("FN-001", 0);
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.updateStep).not.toHaveBeenCalledWith("FN-001", 0, "done");
    expect(store.updateStep).not.toHaveBeenCalledWith("FN-001", 0, "skipped");
  });

  /*
   * FNXC:StepLifecycle 2026-07-22-10:30:
   * Exercise both sides of the atomic verdict: corrupted in-progress state must not run,
   * while a dependency-valid in-progress restart remains resumable.
   */
  it("does not execute a step whose atomic start is blocked despite an in-progress status", async () => {
    const store = makeStore();
    store.startStep.mockResolvedValue({
      accepted: false,
      disposition: "blocked",
      blockingStepIndex: 0,
      task: makeTask([
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "in-progress" },
      ]),
    });
    const runStep = vi.fn().mockResolvedValue({ success: true });
    const gitRevParse = vi.fn().mockResolvedValue("baseSHA");

    const result = await runTaskStep(
      { store, worktreePath: "/wt", runStep, gitRevParse },
      makeTask([
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "in-progress" },
      ]),
      1,
      { projectionSource: "graph" },
    );

    expect(result).toEqual({ outcome: "failure" });
    expect(runStep).not.toHaveBeenCalled();
    expect(gitRevParse).not.toHaveBeenCalled();
    expect(store.updateStep).not.toHaveBeenCalled();
  });

  it("executes a valid in-progress resume accepted by the atomic start", async () => {
    const store = makeStore();
    store.startStep.mockResolvedValue({
      accepted: true,
      disposition: "resumed",
      task: makeTask([
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ]),
    });
    const runStep = vi.fn().mockResolvedValue({ success: false });

    const result = await runTaskStep(
      { store, worktreePath: "/wt", runStep, gitRevParse: async () => "baseSHA" },
      makeTask([
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ]),
      1,
      { projectionSource: "graph" },
    );

    expect(result.outcome).toBe("failure");
    expect(runStep).toHaveBeenCalledWith(1);
  });

  it("still returns a result when baseline capture fails (best-effort)", async () => {
    const store = makeStore();
    const runStep = vi.fn().mockResolvedValue({ success: true });
    const gitRevParse = vi.fn().mockRejectedValue(new Error("not a git repo"));

    const result = await runTaskStep(
      { store, worktreePath: "/wt", runStep, gitRevParse, captureCheckpointId: () => "leaf" },
      makeTask([{ status: "pending" }]),
      0,
    );

    expect(result.outcome).toBe("success");
    expect(result.baselineSha).toBeUndefined();
    expect(result.checkpointId).toBe("leaf");
  });

  it("defers default baseline capture for missing and non-directory worktree paths", async () => {
    const missingPath = join(tmpdir(), `fn-8464-missing-${Date.now()}`);
    const filePath = join(tmpdir(), `fn-8464-file-${Date.now()}`);
    await writeFile(filePath, "not a directory");
    try {
      for (const worktreePath of [missingPath, filePath]) {
        const result = await runTaskStep(
          { store: makeStore(), worktreePath, runStep: async () => ({ success: true }) },
          makeTask([{ status: "pending" }]),
          0,
        );
        expect(result).toMatchObject({ outcome: "success", baselineSha: undefined });
      }
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it("keeps pre-step baseline capture for a usable worktree directory", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "fn-8464-directory-"));
    const gitRevParse = vi.fn().mockResolvedValue("pre-step-sha");
    const runStep = vi.fn().mockResolvedValue({ success: true });
    try {
      const result = await runTaskStep(
        { store: makeStore(), worktreePath, runStep, gitRevParse },
        makeTask([{ status: "pending" }]),
        0,
      );
      expect(result.baselineSha).toBe("pre-step-sha");
      expect(gitRevParse.mock.invocationCallOrder[0]).toBeLessThan(runStep.mock.invocationCallOrder[0]);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("uses the default checkpoint capture from the session ref when none injected", async () => {
    const store = makeStore();
    const sessionRef = makeSessionRef({ leafId: "leaf-xyz" });
    const result = await runTaskStep(
      {
        store,
        worktreePath: "/wt",
        runStep: async () => ({ success: true }),
        gitRevParse: async () => "sha",
      },
      makeTask([{ status: "pending" }]),
      0,
      { sessionRef },
    );
    expect(result.checkpointId).toBe("leaf-xyz");
  });
});

describe("isUsableWorktreeDirectory", () => {
  it("returns false for empty, missing, and non-directory candidates", async () => {
    const filePath = join(tmpdir(), `fn-8464-helper-file-${Date.now()}`);
    await writeFile(filePath, "not a directory");
    try {
      expect(isUsableWorktreeDirectory(undefined)).toBe(false);
      expect(isUsableWorktreeDirectory(join(tmpdir(), `fn-8464-helper-missing-${Date.now()}`))).toBe(false);
      expect(isUsableWorktreeDirectory(filePath)).toBe(false);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it("returns true for an existing directory", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "fn-8464-helper-directory-"));
    try {
      expect(isUsableWorktreeDirectory(worktreePath)).toBe(true);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });
});

describe("resetStepToBaseline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does git reset + session rewind + step→pending with baseline and checkpoint (code review)", async () => {
    const store = makeStore();
    const navigateTree = vi.fn().mockResolvedValue(undefined);
    const sessionRef = makeSessionRef({ navigateTree });
    // We can't observe the real git command without mocking child_process; verify
    // the session rewind + projection happen. (The git path is exercised through
    // the executor characterization test.)
    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code", summary: "rejected" },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      "leaf-checkpoint",
    );

    expect(result).toEqual({ ok: true });
    expect(navigateTree).toHaveBeenCalledWith("leaf-checkpoint", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 0, "pending");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("git reset to baseSHA"),
      "rejected",
    );
  });

  it("skips the session rewind when no checkpoint is provided (partial path)", async () => {
    const store = makeStore();
    const navigateTree = vi.fn();
    const branchWithSummary = vi.fn();
    const sessionRef = makeSessionRef({ navigateTree, branchWithSummary });

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code" },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(navigateTree).not.toHaveBeenCalled();
    expect(branchWithSummary).not.toHaveBeenCalled();
    // Step still flips to pending.
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 0, "pending");
  });

  it("plan review skips git reset, logs the plan-rewound line, still flips pending", async () => {
    const store = makeStore();
    const navigateTree = vi.fn().mockResolvedValue(undefined);
    const sessionRef = makeSessionRef({ navigateTree });

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "plan", summary: "plan rejected" },
      makeTask([{ status: "in-progress" }]),
      2,
      undefined,
      "leaf-checkpoint",
    );

    expect(result.ok).toBe(true);
    expect(navigateTree).toHaveBeenCalledWith("leaf-checkpoint", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 2, "pending");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      // 0-indexed step 2 is displayed as "Step 2" to match PROMPT.md headings.
      expect.stringContaining("Step 2 plan rewound"),
      "plan rejected",
    );
  });

  it("falls back to branchWithSummary when navigateTree throws", async () => {
    const store = makeStore();
    const navigateTree = vi.fn().mockRejectedValue(new Error("navigate failed"));
    const branchWithSummary = vi.fn();
    const sessionRef = makeSessionRef({ navigateTree, branchWithSummary });

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code", summary: "why" },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      "leaf-checkpoint",
    );

    expect(result.ok).toBe(true);
    expect(branchWithSummary).toHaveBeenCalledWith("leaf-checkpoint", "RETHINK: why");
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 0, "pending");
  });

  // ── KTD-2 blast-radius guard refusal cases ──────────────────────────────

  it("REFUSES and mutates nothing when the guard reports a violation", async () => {
    const store = makeStore();
    const navigateTree = vi.fn();
    const sessionRef = makeSessionRef({ navigateTree });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };
    const blastRadiusGuard = vi.fn().mockResolvedValue("baseSHA is not an ancestor of HEAD");

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code", audit, blastRadiusGuard },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      "leaf-checkpoint",
    );

    expect(result).toEqual({ ok: false, reason: "baseSHA is not an ancestor of HEAD" });
    // No mutation: no rewind, no updateStep, no RETHINK logEntry.
    expect(navigateTree).not.toHaveBeenCalled();
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    // Audit warning emitted (task:integrity-warning, database domain).
    expect(audit.database).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task:integrity-warning",
        target: "FN-001",
        metadata: expect.objectContaining({
          guard: "step-reset-blast-radius",
          reason: "baseSHA is not an ancestor of HEAD",
        }),
      }),
    );
  });

  it("fails closed (refuses) when the guard itself throws", async () => {
    const store = makeStore();
    const sessionRef = makeSessionRef();
    const blastRadiusGuard = vi.fn().mockRejectedValue(new Error("git exploded"));

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code", blastRadiusGuard },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      "leaf",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("git exploded");
    expect(store.updateStep).not.toHaveBeenCalled();
  });

  it("proceeds with the reset when the guard returns null (safe)", async () => {
    const store = makeStore();
    const navigateTree = vi.fn().mockResolvedValue(undefined);
    const sessionRef = makeSessionRef({ navigateTree });
    const blastRadiusGuard = vi.fn().mockResolvedValue(null);

    const result = await resetStepToBaseline(
      { store, worktreePath: "/wt", sessionRef, reviewType: "code", blastRadiusGuard },
      makeTask([{ status: "in-progress" }]),
      0,
      "baseSHA",
      "leaf-checkpoint",
    );

    expect(result.ok).toBe(true);
    expect(navigateTree).toHaveBeenCalledWith("leaf-checkpoint", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-001", 0, "pending");
  });
});

describe("makeAncestryBlastRadiusGuard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses when a LATER step is already done", async () => {
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([{ status: "in-progress" }, { status: "done" }]),
      stepIndex: 0,
      isAncestor: async () => true,
    });
    const reason = await guard("baseSHA");
    expect(reason).toContain("later step 1 is done");
  });

  it("refuses when a LATER step is already skipped", async () => {
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([{ status: "in-progress" }, { status: "skipped" }]),
      stepIndex: 0,
      isAncestor: async () => true,
    });
    const reason = await guard("baseSHA");
    expect(reason).toContain("later step 1 is skipped");
  });

  it("refuses when the baseline is NOT an ancestor of HEAD", async () => {
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([{ status: "in-progress" }]),
      stepIndex: 0,
      isAncestor: async () => false,
    });
    const reason = await guard("baseSHA");
    expect(reason).toContain("not an ancestor of HEAD");
  });

  it("allows when baseline is an ancestor and no later step is terminal", async () => {
    const isAncestor = vi.fn().mockResolvedValue(true);
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([
        { status: "pending" },
        { status: "in-progress" },
        { status: "pending" },
      ]),
      stepIndex: 1,
      isAncestor,
    });
    const reason = await guard("baseSHA");
    expect(reason).toBeNull();
    expect(isAncestor).toHaveBeenCalledWith("baseSHA", "/wt");
  });

  it("allows (skipping ancestry) when no baseline is supplied", async () => {
    const isAncestor = vi.fn();
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([{ status: "in-progress" }]),
      stepIndex: 0,
      isAncestor,
    });
    const reason = await guard(undefined);
    expect(reason).toBeNull();
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it("treats an earlier done step as harmless (only LATER steps matter)", async () => {
    const guard = makeAncestryBlastRadiusGuard({
      worktreePath: "/wt",
      task: makeTask([{ status: "done" }, { status: "in-progress" }]),
      stepIndex: 1,
      isAncestor: async () => true,
    });
    const reason = await guard("baseSHA");
    expect(reason).toBeNull();
  });
});
