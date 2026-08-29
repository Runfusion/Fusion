import { describe, expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";

// These exercise two PR-1363 review fixes on the merge seam without standing up
// a full ProjectEngine: the per-task resolver LIST (multiple awaiters can't
// overwrite each other) and requestInterpreterMerge honoring auto-merge
// eligibility (a graph merge node must not override an autoMerge-off project).

describe("interpreter merge seam", () => {
  // Build a bare object whose prototype is ProjectEngine's, so the helper
  // methods can call each other (this.takeMergeResolvers etc.) without
  // constructing a full engine.
  function bareEngine(extra: Record<string, unknown> = {}): any {
    return Object.assign(Object.create(ProjectEngine.prototype), {
      manualMergeResolvers: new Map<string, unknown[]>(),
      ...extra,
    });
  }

  describe("per-task resolver list", () => {
    it("resolves every awaiter for a task, not just the last one", () => {
      const engine = bareEngine();

      const a = { resolve: vi.fn(), reject: vi.fn() };
      const b = { resolve: vi.fn(), reject: vi.fn() };
      engine.addMergeResolver("FN-1", a);
      engine.addMergeResolver("FN-1", b); // would have overwritten 'a' before the fix

      const result = { merged: true } as any;
      engine.resolveMergeResolvers("FN-1", result);

      expect(a.resolve).toHaveBeenCalledWith(result);
      expect(b.resolve).toHaveBeenCalledWith(result);
      expect(engine.manualMergeResolvers.has("FN-1")).toBe(false);
    });

    it("rejects every awaiter and clears the task entry", () => {
      const engine = bareEngine();

      const a = { resolve: vi.fn(), reject: vi.fn() };
      const b = { resolve: vi.fn(), reject: vi.fn() };
      engine.addMergeResolver("FN-2", a);
      engine.addMergeResolver("FN-2", b);

      const err = new Error("boom");
      engine.rejectMergeResolvers("FN-2", err);

      expect(a.reject).toHaveBeenCalledWith(err);
      expect(b.reject).toHaveBeenCalledWith(err);
      expect(engine.hasMergeResolvers("FN-2")).toBe(false);
    });
  });

  describe("requestInterpreterMerge auto-merge eligibility", () => {
    function fakeEngineWith(opts: { autoEligible: boolean; onMerge?: ReturnType<typeof vi.fn> }) {
      return {
        runtime: {
          getTaskStore: () => ({
            getSettings: async () => ({ autoMerge: opts.autoEligible, globalPause: false, enginePaused: false }),
            getTask: async () => ({ id: "FN-3", column: "in-review", branch: "feat", paused: false, mergeDetails: undefined }),
          }),
        },
        // The real allowInReviewMergeProcessing depends on branch-group context;
        // stub it to isolate the autoMerge-off gate this test cares about.
        allowInReviewMergeProcessing: () => opts.autoEligible,
        onMerge: opts.onMerge ?? vi.fn(),
      };
    }

    it("returns merged:false/noOp and does NOT force a merge when autoMerge is off", async () => {
      const onMerge = vi.fn();
      const fakeEngine = fakeEngineWith({ autoEligible: false, onMerge });
      const result = await (ProjectEngine.prototype as any).requestInterpreterMerge.call(fakeEngine, "FN-3");

      expect(result.merged).toBe(false);
      expect(result.noOp).toBe(true);
      expect(onMerge).not.toHaveBeenCalled(); // the human "merge now" bypass is never invoked
    });

    it("routes through onMerge when the task is auto-merge eligible", async () => {
      const onMerge = vi.fn(async () => ({ merged: true, branch: "feat" }) as any);
      const fakeEngine = fakeEngineWith({ autoEligible: true, onMerge });
      const result = await (ProjectEngine.prototype as any).requestInterpreterMerge.call(fakeEngine, "FN-3");

      expect(onMerge).toHaveBeenCalledWith("FN-3", {});
      expect(result.merged).toBe(true);
    });

    it("throws (never returns a null-task MergeResult) when the task lookup yields nothing", async () => {
      // getTask returning null (deleted task / failed lookup) must not produce a
      // MergeResult whose `task` is a null cast — callers dereference result.task.
      const onMerge = vi.fn();
      const fakeEngine = {
        runtime: {
          getTaskStore: () => ({
            getSettings: async () => ({ autoMerge: true, globalPause: false, enginePaused: false }),
            getTask: async () => null,
          }),
        },
        allowInReviewMergeProcessing: () => true,
        onMerge,
      };

      await expect(
        (ProjectEngine.prototype as any).requestInterpreterMerge.call(fakeEngine, "FN-404"),
      ).rejects.toThrow(/FN-404/);
      expect(onMerge).not.toHaveBeenCalled();
    });

    it("throws when getTask itself rejects (lookup failure), not a null-task result", async () => {
      const onMerge = vi.fn();
      const fakeEngine = {
        runtime: {
          getTaskStore: () => ({
            getSettings: async () => ({ autoMerge: true, globalPause: false, enginePaused: false }),
            getTask: async () => {
              throw new Error("store offline");
            },
          }),
        },
        allowInReviewMergeProcessing: () => true,
        onMerge,
      };

      await expect(
        (ProjectEngine.prototype as any).requestInterpreterMerge.call(fakeEngine, "FN-500"),
      ).rejects.toThrow(/FN-500/);
      expect(onMerge).not.toHaveBeenCalled();
    });
  });
});
