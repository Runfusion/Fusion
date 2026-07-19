import { describe, expect, it, vi } from "vitest";

import { computeCrossParentDiagnosticClaimId, computeParentIntentClaimId, findSameAgentDuplicates, flagSameAgentDuplicate } from "../duplicate-intake.js";
import type { TaskStore } from "../store.js";

describe("findSameAgentDuplicates", () => {
  const nowMs = Date.now();

  it("returns same-agent high-similarity match within window", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck in secrets sync", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck in secrets sync",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });

  it("filters out entries older than 24h", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 25 * 60 * 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters out candidates with no shared caller identity", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: null }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters archived candidates via duplicate matcher defaults", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "archived", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("respects threshold", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix parser", description: "parse errors on sync job" },
      [{ id: "FN-1", title: "Refactor dashboard layout", description: "button spacing and css", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("matches siblings sharing the same parent task even when sourceAgentId differs", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event for lane selection",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event for per-lane provider/runtime selection",
        description: "Emit run-audit event recording per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "different-agent",
        sourceParentTaskId: "FN-5206",
      }],
      { nowMs, sourceAgentId: "calling-agent" },
    );
    expect(matches[0]?.id).toBe("FN-5544");
  });

  it("recognizes parent-scoped paraphrases through stable intent phrases", () => {
    const input = {
      description: "Add screenshot and activity-trace context capture with privacy scrub coverage before GitHub egress.",
      sourceParentTaskId: "FN-8277",
    };
    const candidate = {
      id: "FN-8309", title: "", description: "Add optional screenshot and short activity-trace context capture, preserving scrub-before-egress.",
      column: "triage", createdAt: nowMs - 60_000, sourceAgentId: null, sourceParentTaskId: "FN-8277",
    } as const;
    const matches = findSameAgentDuplicates(input, [candidate], { nowMs });
    expect(matches.map((match) => match.id)).toEqual(["FN-8309"]);
    expect(findSameAgentDuplicates(input, [{ ...candidate, tombstoned: true }], { nowMs })).toEqual([]);
  });

  it("keeps distinct actions and sibling integrations separate", () => {
    const candidates = [
      { id: "FN-UPLOAD", title: "", description: "Add screenshot upload support", column: "triage" as const, createdAt: nowMs - 60_000, sourceAgentId: null, sourceParentTaskId: "FN-PARENT" },
      { id: "FN-DISCUSS", title: "", description: "Add GitHub Discussions as a filing target", column: "triage" as const, createdAt: nowMs - 60_000, sourceAgentId: null, sourceParentTaskId: "FN-PARENT" },
    ];
    expect(findSameAgentDuplicates({ description: "Add screenshot deletion support", sourceParentTaskId: "FN-PARENT" }, candidates, { nowMs })).toEqual([]);
    expect(findSameAgentDuplicates({ description: "Add GitHub Issues as a filing target", sourceParentTaskId: "FN-PARENT" }, candidates, { nowMs })).toEqual([]);
    expect(findSameAgentDuplicates({
      description: "Add OAuth token revocation for the GitHub API",
      sourceParentTaskId: "FN-PARENT",
    }, [{
      id: "FN-ROTATE", title: "", description: "Add OAuth token rotation for the GitHub API",
      column: "triage", createdAt: nowMs - 60_000, sourceAgentId: null, sourceParentTaskId: "FN-PARENT",
    }], { nowMs })).toEqual([]);
  });

  it("derives stable database claims for paraphrases and distinct claims for sibling actions", () => {
    const claim = (description: string) => computeParentIntentClaimId({ description, sourceParentTaskId: "fn-8277" });
    expect(claim("Add screenshot and short activity-trace context capture")).toBe(
      claim("Capture screenshots with activity-trace context"),
    );
    expect(claim("Add GitHub Discussions as a filing target")).toBe(
      claim("Use GitHub Discussions for optional filing"),
    );
    expect(claim("Add screenshot upload support")).not.toBe(claim("Add screenshot deletion support"));
    expect(claim("Add GitHub Discussions as a target")).not.toBe(claim("Add GitHub Issues as a target"));
    expect(claim("Add new support")).toMatch(/^agent-parent-intent:FN-8277:[a-f0-9]{64}$/);
  });

  it("derives one cross-parent claim for the recently repeated diagnostic", () => {
    const descriptions = [
      "Investigate and repair dashboard typecheck failure: app/utils/capture-screenshot.ts imports unresolved `html2canvas`, causing `pnpm verify:fast` to fail.",
      "Fix dashboard typecheck failure: app/utils/capture-screenshot.ts cannot resolve the html2canvas module during pnpm verify:fast.",
      "Fix dashboard typecheck failure: packages/dashboard/app/utils/capture-screenshot.ts imports unresolved html2canvas. Add or correctly wire the dependency.",
      "Fix dashboard typecheck missing html2canvas dependency/import in packages/dashboard/app/utils/capture-screenshot.ts (TS2307 observed during pnpm verify:fast).",
      "Fix dashboard typecheck dependency resolution for app/utils/capture-screenshot.ts: Cannot find module 'html2canvas' during pnpm verify:fast.",
      "Restore the missing `html2canvas` dependency declaration/lock entry for dashboard screenshot capture so @fusion/dashboard typecheck passes.",
    ];

    const claims = descriptions.map((description) => computeCrossParentDiagnosticClaimId({ description }));

    expect(new Set(claims).size).toBe(1);
    expect(claims[0]).toMatch(/^agent-diagnostic-intent:/);
  });

  it("does not globally claim ordinary work or unrelated work on the same module", () => {
    expect(computeCrossParentDiagnosticClaimId({
      description: "Add screenshot upload support using html2canvas",
    })).toBeNull();
    expect(computeCrossParentDiagnosticClaimId({
      description: "Improve html2canvas capture performance",
    })).toBeNull();
  });

  it("keeps diagnostic paths distinct when they share a basename", () => {
    const first = computeCrossParentDiagnosticClaimId({
      description: "Fix unresolved packages/alpha/index.ts typecheck failure.",
    });
    const second = computeCrossParentDiagnosticClaimId({
      description: "Fix unresolved packages/beta/index.ts typecheck failure.",
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("does not match sibling with different parent task", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: "FN-OTHER",
      }],
      { nowMs, sourceAgentId: "agent-y" },
    );
    expect(matches).toEqual([]);
  });

  it("falls back to sourceAgentId match when parent is unset", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: null,
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });
});

describe("flagSameAgentDuplicate (FN-7658)", () => {
  function createMockStore() {
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const updateTask = vi.fn().mockResolvedValue(undefined);
    return {
      store: { logEntry, recordActivity, updateTask } as unknown as TaskStore,
      logEntry,
      recordActivity,
      updateTask,
    };
  }

  it("logs, records a flag-only activity, and sets the near-duplicate marker without moving the task", async () => {
    const { store, logEntry, recordActivity, updateTask } = createMockStore();

    await flagSameAgentDuplicate(store, "FN-2", ["FN-1"], { "FN-1": 0.9 });

    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry.mock.calls[0]?.[0]).toBe("FN-2");

    expect(recordActivity).toHaveBeenCalledTimes(1);
    const activity = recordActivity.mock.calls[0]?.[0];
    expect(activity).toMatchObject({
      type: "task:auto-archived-duplicate",
      taskId: "FN-2",
      metadata: { siblingTaskIds: ["FN-1"], scores: { "FN-1": 0.9 }, source: "same-agent-flagged" },
    });

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith("FN-2", {
      sourceMetadataPatch: { nearDuplicateOf: "FN-1", nearDuplicateScore: 0.9 },
    });

    // Must NOT call moveTask — flagSameAgentDuplicate leaves the task's column alone.
    expect((store as unknown as { moveTask?: unknown }).moveTask).toBeUndefined();
  });

  it("picks the first sibling id as the canonical near-duplicate marker", async () => {
    const { store, updateTask } = createMockStore();

    await flagSameAgentDuplicate(store, "FN-3", ["FN-1", "FN-2"], { "FN-1": 0.8, "FN-2": 0.95 });

    expect(updateTask).toHaveBeenCalledWith("FN-3", {
      sourceMetadataPatch: { nearDuplicateOf: "FN-1", nearDuplicateScore: 0.8 },
    });
  });
});

describe("flagTriageDuplicate", () => {
  it("flags a triage marker without moving or deleting the task", async () => {
    const { flagTriageDuplicate } = await import("../duplicate-intake.js");
    const store = { logEntry: vi.fn(), recordActivity: vi.fn(), updateTask: vi.fn() } as any;
    await flagTriageDuplicate(store, "FN-2", "FN-1");
    expect(store.updateTask).toHaveBeenCalledWith("FN-2", { sourceMetadataPatch: { nearDuplicateOf: "FN-1", nearDuplicateScore: 1, duplicateSource: "triage-marker", nearDuplicateDismissed: false } });
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ source: "triage-marker-flagged", canonicalTaskId: "FN-1" }) }));
    expect(store.deleteTask).toBeUndefined();
  });
});
