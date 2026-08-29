// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { CliRelaunchRegistry } from "../cli-session-transport.js";

describe("CliRelaunchRegistry", () => {
  it("records the latest relaunch request and emits to subscribers", () => {
    const registry = new CliRelaunchRegistry();
    const listener = vi.fn();

    registry.on(listener);
    registry.record("cli-1", "proj-a", "FN-6464");

    expect(registry.getLatest("cli-1")).toEqual({
      sessionId: "cli-1",
      projectId: "proj-a",
      taskId: "FN-6464",
    });
    expect(listener).toHaveBeenCalledWith({
      sessionId: "cli-1",
      projectId: "proj-a",
      taskId: "FN-6464",
    });
  });

  it("unsubscribes listeners", () => {
    const registry = new CliRelaunchRegistry();
    const listener = vi.fn();

    const unsubscribe = registry.on(listener);
    unsubscribe();
    registry.record("cli-1", "proj-a", "FN-6464");

    expect(listener).not.toHaveBeenCalled();
  });
});
