import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  PlanningLifecycleLockTransportError,
  planningLifecycleLockTransportAvailability,
  withPlanningLifecycleAdvisoryLock,
  withPlanningLifecycleAdvisoryLocks,
} from "../../postgres/advisory-locks.js";
import { resolveBackendWithOptions } from "../../postgres/backend-resolver.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_planning_lock",
  poolMax: 1,
});

function lock(
  projectId: string,
  taskId: string,
  callback: () => Promise<void>,
  timeoutMs = 1_000,
  onLockAcquisitionAttempt?: () => void,
): Promise<void> {
  return withPlanningLifecycleAdvisoryLock({
    projectId,
    taskId,
    directSessionUrl: h.testUrl(),
    provenance: "migration-override",
    runtimeUrl: h.testUrl(),
    migrationUrl: h.testUrl(),
    timeoutMs,
    onLockAcquisitionAttempt,
  }, callback);
}

pgDescribe("planning lifecycle advisory lock", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("serializes the same project/task key on dedicated sessions", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstIsHolding = new Promise<void>((resolve) => { firstEntered = resolve; });
    const order: string[] = [];

    const first = lock("project-a", "FN-1", async () => {
      order.push("first-enter");
      firstEntered();
      await firstCanFinish;
      order.push("first-exit");
    });
    await firstIsHolding;

    let secondAttempted!: () => void;
    const secondAttemptIsDispatched = new Promise<void>((resolve) => { secondAttempted = resolve; });
    const second = lock("project-a", "FN-1", async () => {
      order.push("second-enter");
    }, 1_000, secondAttempted);

    await secondAttemptIsDispatched;
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("shares key space with a single-key holder across a sorted multi-key session", async () => {
    let releaseMulti!: () => void;
    const multiCanFinish = new Promise<void>((resolve) => { releaseMulti = resolve; });
    let multiEntered!: () => void;
    const multiIsHolding = new Promise<void>((resolve) => { multiEntered = resolve; });
    const multi = withPlanningLifecycleAdvisoryLocks({
      projectId: "project-a",
      taskIds: ["FN-2", "FN-1", "FN-2"],
      directSessionUrl: h.testUrl(),
      provenance: "migration-override",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
      timeoutMs: 1_000,
    }, async () => {
      multiEntered();
      await multiCanFinish;
    });
    await multiIsHolding;

    let singleAttempted!: () => void;
    const singleDispatched = new Promise<void>((resolve) => { singleAttempted = resolve; });
    const single = lock("project-a", "FN-1", async () => {}, 1_000, singleAttempted);
    await singleDispatched;
    releaseMulti();
    await Promise.all([multi, single]);
  });

  it("releases every multi-key lock when its callback fails", async () => {
    await expect(withPlanningLifecycleAdvisoryLocks({
      projectId: "project-a",
      taskIds: ["FN-1", "FN-2"],
      directSessionUrl: h.testUrl(),
      provenance: "migration-override",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
    }, async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");

    await Promise.all([
      lock("project-a", "FN-1", async () => {}),
      lock("project-a", "FN-2", async () => {}),
    ]);
  });

  it("shares the structural availability predicate used by acquisition", () => {
    expect(planningLifecycleLockTransportAvailability({
      directSessionUrl: null,
      provenance: null,
    })).toEqual({ available: false, reason: "direct-session-unavailable" });
    expect(planningLifecycleLockTransportAvailability({
      directSessionUrl: h.testUrl(),
      provenance: "migration-override",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
    })).toEqual({ available: true });
  });

  it("does not contend across project or task keys", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstIsHolding = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = lock("project-a", "FN-1", async () => {
      firstEntered();
      await firstCanFinish;
    });
    await firstIsHolding;

    await Promise.all([
      lock("project-b", "FN-1", async () => {}),
      lock("project-a", "FN-2", async () => {}),
    ]);
    releaseFirst();
    await first;
  });

  it("unlocks and closes the dedicated session when the callback throws", async () => {
    await expect(lock("project-a", "FN-1", async () => {
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");

    await expect(lock("project-a", "FN-1", async () => {})).resolves.toBeUndefined();
  });

  it.each(["embedded-lifecycle", "migration-override"] as const)(
    "accepts a verified %s direct-session provenance",
    async (provenance) => {
      await expect(withPlanningLifecycleAdvisoryLock({
        projectId: "project-a",
        taskId: "FN-1",
        directSessionUrl: h.testUrl(),
        provenance,
        runtimeUrl: h.testUrl(),
        migrationUrl: h.testUrl(),
        timeoutMs: 1_000,
      }, async () => {})).resolves.toBeUndefined();
    },
  );

  it("uses a direct-only runtime URL to acquire and release the lock", async () => {
    const backend = resolveBackendWithOptions({ databaseUrl: h.testUrl() });
    let callbackRan = false;
    await withPlanningLifecycleAdvisoryLock({
      projectId: "project-a",
      taskId: "FN-runtime-direct",
      directSessionUrl: backend.directSessionUrl ?? null,
      provenance: backend.directSessionProvenance ?? null,
      runtimeUrl: backend.runtimeUrl,
      migrationUrl: backend.migrationUrl,
    }, async () => { callbackRan = true; });
    expect(callbackRan).toBe(true);
    await expect(withPlanningLifecycleAdvisoryLock({
      projectId: "project-a",
      taskId: "FN-runtime-direct",
      directSessionUrl: backend.directSessionUrl ?? null,
      provenance: backend.directSessionProvenance ?? null,
      runtimeUrl: backend.runtimeUrl,
      migrationUrl: backend.migrationUrl,
    }, async () => {})).resolves.toBeUndefined();
  });

  it("bounds lock contention with a typed transport error", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstIsHolding = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = lock("project-a", "FN-1", async () => {
      firstEntered();
      await firstCanFinish;
    });
    await firstIsHolding;

    await expect(lock("project-a", "FN-1", async () => {}, 50))
      .rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
    releaseFirst();
    await first;
  });

  it("fails closed for unavailable, pooled, missing, and mismatched endpoints", async () => {
    const base = {
      projectId: "project-a",
      taskId: "FN-1",
      provenance: "migration-override" as const,
      timeoutMs: 50,
    };
    const callback = async () => {};

    await expect(withPlanningLifecycleAdvisoryLock({
      ...base,
      directSessionUrl: null,
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
    }, callback)).rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
    await expect(withPlanningLifecycleAdvisoryLock({
      ...base,
      directSessionUrl: "postgresql://localhost:5432/db?pgbouncer=true",
      runtimeUrl: "postgresql://localhost:5432/db?pgbouncer=true",
      migrationUrl: "postgresql://localhost:5432/db?pgbouncer=true",
    }, callback)).rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
    await expect(withPlanningLifecycleAdvisoryLock({
      ...base,
      directSessionUrl: `${h.testUrl()}_other`,
      provenance: "runtime-direct",
      runtimeUrl: h.testUrl(),
      migrationUrl: h.testUrl(),
    }, callback)).rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
    await expect(withPlanningLifecycleAdvisoryLock({
      ...base,
      directSessionUrl: "postgresql://127.0.0.1:1/unavailable",
      runtimeUrl: "postgresql://127.0.0.1:1/unavailable",
      migrationUrl: "postgresql://127.0.0.1:1/unavailable",
    }, callback)).rejects.toBeInstanceOf(PlanningLifecycleLockTransportError);
  });
});
