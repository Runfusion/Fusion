import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSessionRegistry,
  reconcileSelfOwnedActiveSessionForRemoval,
  ActiveSessionPathHeldByForeignTaskError,
} from "../agents/active-session-registry.js";

describe("activeSessionRegistry", () => {
  beforeEach(() => {
    activeSessionRegistry.clear();
  });

  it("registers and unregisters paths", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(activeSessionRegistry.isPathActive("/tmp/w1")).toBe(true);

    activeSessionRegistry.unregisterPath("/tmp/w1");
    expect(activeSessionRegistry.isPathActive("/tmp/w1")).toBe(false);
  });

  it("supports multiple paths for same task", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    activeSessionRegistry.registerPath("/tmp/w2", { taskId: "FN-1", kind: "workflow-step", ownerKey: "FN-1#workflow-step" });

    expect(activeSessionRegistry.pathsForTask("FN-1").sort()).toEqual(["/tmp/w1", "/tmp/w2"]);
  });

  it("returns null for unregistered path", () => {
    expect(activeSessionRegistry.lookupByPath("/tmp/missing")).toBeNull();
  });

  // FNXC:Workspace 2026-06-22-04:10 (Phase C review A2 — taskId-aware lease across kinds):
  // registerPath must NOT silently clobber an entry held by a DIFFERENT task (that was the
  // cross-phase clobber bug: a merging task's land lease overwriting an executing task's
  // acquire lease on a shared sub-repo). A foreign-task overwrite now THROWS; the existing
  // foreign holder is preserved.
  it("rejects a foreign-task overwrite (does not clobber the held entry)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(() =>
      activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "workflow-step", ownerKey: "FN-2#workflow-step" }),
    ).toThrow(ActiveSessionPathHeldByForeignTaskError);
    // The original holder is untouched.
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  // Same-task re-registration stays idempotent (an executor re-claiming/refreshing its own path).
  it("allows same-task re-registration (idempotent re-claim)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    expect(() =>
      activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "step-session", ownerKey: "FN-1#step-session" }),
    ).not.toThrow();
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.kind).toBe("step-session");
  });

  it("reconcileStaleSelfOwned returns no-entry when path is unregistered", () => {
    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/missing", "FN-1")).toEqual({
      reconciled: false,
      reason: "no-entry",
    });
  });

  it("reconcileStaleSelfOwned returns foreign-task for mismatched owner", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "executor", ownerKey: "FN-2" });

    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/w1", "FN-1")).toEqual({
      reconciled: false,
      reason: "foreign-task",
    });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-2");
  });

  it("reconcileStaleSelfOwned unregisters matching self-owned entry", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(activeSessionRegistry.reconcileStaleSelfOwned("/tmp/w1", "FN-1")).toEqual({
      reconciled: true,
      reason: "reconciled",
    });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns no-entry when path is unregistered", () => {
    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/missing", "FN-1", () => false),
    ).toEqual({ action: "no-entry" });
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns foreign-task without clearing", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "executor", ownerKey: "FN-2" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false),
    ).toEqual({ action: "foreign-task", ownerTaskId: "FN-2" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-2");
  });

  it("reconcileSelfOwnedActiveSessionForRemoval returns live-binding-refuses without clearing", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => true),
    ).toEqual({ action: "live-binding-refuses", ownerTaskId: "FN-1" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("reconcileSelfOwnedActiveSessionForRemoval clears stale same-task entry", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "reconciled" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("reconcileSelfOwnedActiveSessionForRemoval is idempotent", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "reconciled" });
    expect(
      reconcileSelfOwnedActiveSessionForRemoval(activeSessionRegistry, "/tmp/w1", "FN-1", () => false, {
        minIdleMs: 0,
      }),
    ).toEqual({ action: "no-entry" });
  });

  it("FN-5256: refuses reconcile when processActiveProbe returns true", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      { processActiveProbe: () => true, minIdleMs: 0 },
    );
    expect(outcome).toEqual({ action: "process-active-refuses", ownerTaskId: "FN-1" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("FN-5256: refuses reconcile when registration is younger than minIdleMs", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    const registeredAt = activeSessionRegistry.lookupByPath("/tmp/w1")!.registeredAt;

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      { minIdleMs: 5000, now: () => registeredAt + 100 },
    );
    expect(outcome).toMatchObject({ action: "too-recent-refuses", ownerTaskId: "FN-1", minIdleMs: 5000 });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-1");
  });

  it("FN-5256: reconciles when all signals clean (default min-idle window elapsed)", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    const registeredAt = activeSessionRegistry.lookupByPath("/tmp/w1")!.registeredAt;

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => false,
      {
        processActiveProbe: () => false,
        minIdleMs: 5000,
        now: () => registeredAt + 6000,
      },
    );
    expect(outcome).toEqual({ action: "reconciled" });
    expect(activeSessionRegistry.lookupByPath("/tmp/w1")).toBeNull();
  });

  it("FN-5256: live-binding takes precedence over process-active and too-recent", () => {
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });

    const outcome = reconcileSelfOwnedActiveSessionForRemoval(
      activeSessionRegistry,
      "/tmp/w1",
      "FN-1",
      () => true,
      { processActiveProbe: () => true, minIdleMs: 5000 },
    );
    expect(outcome).toEqual({ action: "live-binding-refuses", ownerTaskId: "FN-1" });
  });
});
