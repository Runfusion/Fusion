import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS } from "../run-audit/emit-bounded-run-audit.js";
import { reconcilePhantomCommittedReservationsAsync } from "../task-store/async/async-phantom-reservations.js";

type SinkMode = "absent" | "recorded" | "throw" | "reject" | "never" | "late-resolve" | "late-reject";

function createFixture(mode: SinkMode) {
  let settle: (() => void) | undefined;
  const sink = vi.fn(() => {
    if (mode === "throw") throw new Error("forced audit failure");
    if (mode === "reject") return Promise.reject(new Error("forced audit failure"));
    if (mode === "never") return new Promise(() => undefined);
    if (mode === "late-resolve") return new Promise<void>((resolve) => { settle = resolve; });
    if (mode === "late-reject") return new Promise<void>((_resolve, reject) => { settle = () => reject(new Error("late audit failure")); });
    return undefined;
  });
  const ids = ["FN-9182-a", "FN-9182-b"];
  const reservations = ids.map((taskId) => ({ taskId, liveId: null, projectArchiveId: null, coldArchiveId: null }));
  const query = {
    from: vi.fn(), leftJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn(async () => reservations),
  };
  query.from.mockReturnValue(query); query.leftJoin.mockReturnValue(query); query.where.mockReturnValue(query);
  const txQuery = { from: vi.fn(), leftJoin: vi.fn(), where: vi.fn(async () => ids.map((taskId) => ({ taskId }))) };
  txQuery.from.mockReturnValue(txQuery); txQuery.leftJoin.mockReturnValue(txQuery);
  let deleteCount = 0;
  const tx = {
    select: vi.fn(() => txQuery),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => {
      deleteCount += 1;
      return deleteCount === 1 ? ids.map((taskId) => ({ taskId })) : [];
    }) })) })),
  };
  const layer = {
    projectId: "project-9182",
    db: { select: vi.fn(() => query) },
    transactionImmediate: async (work: (value: typeof tx) => unknown) => work(tx),
  };
  return {
    store: {
      getAsyncLayer: () => layer,
      taskDir: (id: string) => `/definitely-missing-fn-9182/${id}`,
      ...(mode === "absent" ? {} : { recordRunAuditEvent: sink }),
    },
    sink,
    settle: () => settle?.(),
    ids,
  };
}

afterEach(() => vi.useRealTimers());

describe("phantom reservation audit outcomes", () => {
  it.each(["absent", "recorded", "throw", "reject"] as const)("preserves reconciliation payloads for %s sinks", async (mode) => {
    const fixture = createFixture(mode);
    const result = await reconcilePhantomCommittedReservationsAsync(fixture.store as never);
    if (mode === "throw" || mode === "reject") {
      expect(result).toEqual({ reconciled: [], skipped: fixture.ids.map((id) => ({ id, reason: "audit-failed: forced audit failure" })) });
    } else {
      expect(result).toEqual({ reconciled: fixture.ids, skipped: [] });
    }
    if (mode !== "absent") expect(fixture.sink).toHaveBeenCalledTimes(2);
  });

  it.each(["never", "late-resolve", "late-reject"] as const)("bounds %s audit sinks as per-reservation skipped results", async (mode) => {
    vi.useFakeTimers();
    const fixture = createFixture(mode);
    const operation = reconcilePhantomCommittedReservationsAsync(fixture.store as never);
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS * fixture.ids.length);
    fixture.settle();
    await expect(operation).resolves.toEqual({
      reconciled: [],
      skipped: fixture.ids.map((id) => ({ id, reason: "audit-failed: timed-out" })),
    });
    expect(fixture.sink).toHaveBeenCalledTimes(2);
  });
});
