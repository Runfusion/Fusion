import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: vi.fn().mockReturnValue([]),
  rmSync: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
}));

import { PoolDoubleLeaseError, WorktreePool } from "../worktree/worktree-pool.js";

// FN-5000:
// - A prior "delay prepareForTask" sketch was invalid because acquire() is synchronous,
//   so both racers complete acquire before any async barrier can interleave execution.
// - The release-during-peer-acquire case documents the incident-shaped bug surface.
// - The two-acquire case locks the surviving invariant: one non-null result, one null.
// - The rehydrate case covers rehydrate collision behavior.
describe("WorktreePool double-lease guard", () => {
  let pool: WorktreePool;

  beforeEach(() => {
    pool = new WorktreePool();
  });

  it("prevents rehydrate from re-adding a leased path", () => {
    const violations: Array<{ phase: string; existingHolder: string }> = [];
    pool.setInvariantViolationHandler((violation) => {
      violations.push({ phase: violation.phase, existingHolder: violation.existingHolder });
    });

    pool.release("/tmp/wt-race");
    const firstLease = pool.acquire("FN-A");
    expect(firstLease).toBe("/tmp/wt-race");

    pool.rehydrate(["/tmp/wt-race"]);

    expect(pool.acquire("FN-B")).toBeNull();
    expect(pool.size).toBe(0);
    expect(pool.getLeasedPaths().get("/tmp/wt-race")).toBe("FN-A");
    expect(violations).toEqual([{ phase: "rehydrate", existingHolder: "FN-A" }]);
  });

  it("throws PoolDoubleLeaseError when corrupted idle state tries to re-lease a leased path", () => {
    const violations: Array<{ phase: string; requestingTaskId: string; existingHolder: string }> = [];
    pool.setInvariantViolationHandler((violation) => {
      violations.push({
        phase: violation.phase,
        requestingTaskId: violation.requestingTaskId,
        existingHolder: violation.existingHolder,
      });
    });

    pool.release("/tmp/wt-race");
    expect(pool.acquire("FN-A")).toBe("/tmp/wt-race");
    (pool as any).idle.add("/tmp/wt-race");

    expect(() => pool.acquire("FN-B")).toThrow(PoolDoubleLeaseError);
    expect(violations).toEqual([{ phase: "acquire", requestingTaskId: "FN-B", existingHolder: "FN-A" }]);
  });

  it("FN-4954: release during peer acquire hands out the same path twice", () => {
    const violations: Array<{ phase: string; requestingTaskId: string; existingHolder: string }> = [];
    pool.setInvariantViolationHandler((violation) => {
      violations.push({
        phase: violation.phase,
        requestingTaskId: violation.requestingTaskId,
        existingHolder: violation.existingHolder,
      });
    });

    pool.release("/tmp/wt-A");

    const pathA = pool.acquire("FN-A");
    expect(pathA).toBe("/tmp/wt-A");
    expect(pool.size).toBe(0);

    // FN-4928/FN-4939 shape: stale/error cleanup releases with a mismatched task id.
    pool.release(pathA!, "FN-B");

    const pathB = pool.acquire("FN-B");
    expect(pathB).toBe("/tmp/wt-A");
    expect(violations).toEqual([{ phase: "release", requestingTaskId: "FN-B", existingHolder: "FN-A" }]);
  });

  it("FN-4954: two synchronous acquire() calls against a single-item pool yield exactly one non-null", () => {
    pool.release("/tmp/wt-A");

    const results = [pool.acquire("FN-A"), pool.acquire("FN-B")];

    const nonNull = results.filter((r): r is string => r !== null);
    expect(nonNull).toEqual(["/tmp/wt-A"]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(pool.size).toBe(0);
  });

  it("does not throw for same-task re-entry when no idle path exists", () => {
    pool.release("/tmp/wt-race");
    expect(pool.acquire("FN-A")).toBe("/tmp/wt-race");
    expect(() => pool.acquire("FN-A")).not.toThrow();
    expect(pool.acquire("FN-A")).toBeNull();
  });

  it("keeps release best-effort when releasing task differs", () => {
    const violations: Array<{ phase: string; requestingTaskId: string }> = [];
    pool.setInvariantViolationHandler((violation) => violations.push({ phase: violation.phase, requestingTaskId: violation.requestingTaskId }));

    pool.release("/tmp/wt-race");
    expect(pool.acquire("FN-A")).toBe("/tmp/wt-race");

    pool.release("/tmp/wt-race", "FN-B");
    expect(pool.has("/tmp/wt-race")).toBe(true);
    expect(pool.getLeasedPaths().size).toBe(0);
    expect(violations).toEqual([{ phase: "release", requestingTaskId: "FN-B" }]);
  });
});
