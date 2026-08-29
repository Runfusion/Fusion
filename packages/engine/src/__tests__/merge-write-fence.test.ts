import { describe, expect, it, vi } from "vitest";
import {
  assertMergeGenerationOwned,
  createMergeWriteFence,
  isMergeAbortedError,
} from "../merge/merge-write-fence.js";

describe("merge write fence", () => {
  it("reads ownership at every individual boundary", async () => {
    const controller = new AbortController();
    const fence = createMergeWriteFence({ taskId: "FN-8958", signal: controller.signal });
    expect(fence.isOrphaned()).toBe(false);
    await fence.write("log", () => controller.abort());
    expect(fence.isOrphaned()).toBe(true);
    await expect(fence.write("log", () => { throw new Error("must not run"); })).resolves.toBeUndefined();
    expect(fence.suppressedCount).toBe(1);
  });

  it("emits once at first suppression and keeps an in-process count", async () => {
    const record = vi.fn();
    const controller = new AbortController(); controller.abort();
    const fence = createMergeWriteFence({ taskId: "FN-8958", signal: controller.signal, recordAudit: record });
    await fence.write("log", () => undefined);
    await fence.write("lifecycle", () => undefined);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]).toEqual(["log", "suppressed", 1]);
    expect(fence.suppressedCount).toBe(2);
  });

  it("emits rejection-first with count zero and has a common abort predicate", () => {
    const record = vi.fn(); const controller = new AbortController(); controller.abort();
    const fence = createMergeWriteFence({ taskId: "FN-8958", signal: controller.signal, recordAudit: record });
    let error: unknown;
    try { fence.assertOwned(); } catch (caught) { error = caught; }
    expect(isMergeAbortedError(error)).toBe(true);
    expect(record.mock.calls[0]).toEqual(["finalization", "rejected", 0]);
    expect(() => assertMergeGenerationOwned(controller.signal, "FN-8958")).toThrow(/AI merge aborted/);
  });
});
