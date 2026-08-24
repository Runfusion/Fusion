import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../run-audit/emit-bounded-run-audit.js";

const audit = vi.hoisted(() => ({ sink: undefined as undefined | (() => unknown) }));
vi.mock("../postgres/data-layer.js", () => ({ recordRunAuditEvent: vi.fn(() => audit.sink?.()) }));

import { pruneTaskLifecycleEvents } from "../task-store/task-lifecycle-event-retention.js";

type SinkMode = "absent" | "throw" | "reject" | "never" | "late";
function configure(mode: SinkMode): () => void {
  let settle: (() => void) | undefined;
  audit.sink = mode === "absent" ? undefined : () => {
    if (mode === "throw") throw new Error("hostile audit");
    if (mode === "reject") return Promise.reject(new Error("hostile audit"));
    if (mode === "never") return new Promise(() => undefined);
    if (mode === "late") return new Promise<void>((resolve) => { settle = resolve; });
  };
  return () => settle?.();
}
async function settle<T>(promise: Promise<T>, mode: SinkMode, late: () => void): Promise<T> {
  if (mode === "never" || mode === "late") await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS);
  late(); return await promise;
}
function layer(candidates: bigint[]) {
  const deleted = vi.fn(async () => undefined);
  const db = {
    select: vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => candidates.map((seq) => ({ seq })) }) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ seq: 99n }] }) }) }) }),
    delete: vi.fn(() => ({ where: deleted })),
  };
  return { projectId: "project-9180", db, deleted };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { audit.sink = undefined; vi.useRealTimers(); });

/*
FNXC:RunAudit 2026-08-20-06:50:
FN-9180 exercises retention through its exported production owner, not the seam alone. The bounded
await occurs after DELETE so an audit failure cannot reclassify a committed prune as a failed sweep.
*/
describe("task lifecycle retention bounded audit health", () => {
  it.each(["absent", "throw", "reject", "never", "late"] as const)("returns the committed prune result for a %s audit sink", async (mode) => {
    const late = configure(mode); const fixture = layer([1n]);
    const result = await settle(pruneTaskLifecycleEvents(fixture as never, "project-9180", { maxDeletes: 1 }), mode, late);
    expect(result).toEqual({ prunedCount: 1, oldestRetainedSeq: 99n, minAckedSeq: null, liveConsumerCount: 0, staleConsumerCount: 0, budgetExhausted: true });
    expect(fixture.deleted).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "throw", "reject", "never", "late"] as const)("preserves the zero-prune result without a DELETE for a %s audit sink", async (mode) => {
    const late = configure(mode); const fixture = layer([]);
    await expect(settle(pruneTaskLifecycleEvents(fixture as never, "project-9180"), mode, late)).resolves.toEqual({ prunedCount: 0, oldestRetainedSeq: 99n, minAckedSeq: null, liveConsumerCount: 0, staleConsumerCount: 0, budgetExhausted: false });
    expect(fixture.deleted).not.toHaveBeenCalled();
  });

  it("attempts retention telemetry only after the bounded DELETE", async () => {
    const order: string[] = []; audit.sink = () => { order.push("audit"); };
    const fixture = layer([1n]); fixture.deleted.mockImplementation(async () => { order.push("delete"); });
    await expect(pruneTaskLifecycleEvents(fixture as never, "project-9180", { maxDeletes: 1 })).resolves.toBeDefined();
    expect(order).toEqual(["delete", "audit"]);
  });
});
