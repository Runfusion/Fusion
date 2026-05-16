import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeSessionRegistry } from "../active-session-registry.js";

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

  it("overwrites duplicate registration with warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-1", kind: "executor", ownerKey: "FN-1" });
    activeSessionRegistry.registerPath("/tmp/w1", { taskId: "FN-2", kind: "workflow-step", ownerKey: "FN-2#workflow-step" });

    expect(activeSessionRegistry.lookupByPath("/tmp/w1")?.taskId).toBe("FN-2");
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });
});
