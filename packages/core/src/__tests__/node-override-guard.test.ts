import { describe, expect, it } from "vitest";

import { validateNodeOverrideChange } from "../node-override-guard.js";

describe("validateNodeOverrideChange", () => {
  it("allows when newNodeId is undefined (not being changed)", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "in-progress", nodeId: "node-a" },
      undefined,
    );
    expect(result).toEqual({ allowed: true });
  });

  it.each(["triage", "todo", "in-review", "done", "archived"])(
    "allows setting nodeId on a task in %s",
    (column) => {
      const result = validateNodeOverrideChange({ id: "FN-1", column }, "node-b");
      expect(result).toEqual({ allowed: true });
    },
  );

  it("allows clearing nodeId (null) on a task in todo", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "todo", nodeId: "node-a" },
      null,
    );
    expect(result).toEqual({ allowed: true });
  });

  it("allows changing nodeId from one value to another in todo", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-1", column: "todo", nodeId: "node-a" },
      "node-b",
    );
    expect(result).toEqual({ allowed: true });
  });

  it.each(["node-a", null, "same-node"])(
    "blocks nodeId updates on an in-progress task for value %p",
    (newNodeId) => {
      const result = validateNodeOverrideChange(
        { id: "FN-999", column: "in-progress", nodeId: "same-node" },
        newNodeId,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("task-in-progress");
      expect(result.message).toContain("FN-999");
      expect(result.message?.toLowerCase()).toContain("in progress");
      expect(result.message).toContain("pause/stop");
    },
  );

  it("allows nodeId change on in-progress task when newNodeId is undefined (no-op)", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-2", column: "in-progress", nodeId: "node-a" },
      undefined,
    );
    expect(result).toEqual({ allowed: true });
  });

  it("blocks setting nodeId to same value on in-progress when passed as explicit string", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-2", column: "in-progress", nodeId: "node-a" },
      "node-a",
    );
    expect(result.allowed).toBe(false);
  });
});
