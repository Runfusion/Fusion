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

  it("returns exact task-in-progress reason and actionable guidance in message", () => {
    const result = validateNodeOverrideChange(
      { id: "FN-999", column: "in-progress", nodeId: "node-a" },
      "node-b",
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: "task-in-progress",
    });
    expect(result.message).toContain("FN-999");
    expect(result.message?.toLowerCase()).toContain("wait");
    expect(result.message?.toLowerCase()).toContain("pause");
    expect(result.message?.toLowerCase()).toContain("stop");
  });

  it("blocks setting nodeId on in-progress task even when existing nodeId is undefined", () => {
    const result = validateNodeOverrideChange({ id: "FN-404", column: "in-progress" }, "node-new");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("task-in-progress");
    expect(result.message).toContain("FN-404");
  });

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

  // FNXC:StateMachine 2026-07-07-12:00: Signature 2 (FN-7641 / NEXT-322 / NEXT-375 / NEXT-340)
  // regression — nodeId='end' must finalize-on-proof or return an explicit error, never a
  // silent no-op. Covers in-review with/without merge proof, non-terminal overrides unchanged,
  // clearing the override unchanged, and the still-enforced in-progress guard.
  describe("terminal 'end' node override (FN-7641 Signature 2)", () => {
    it("REPRO: signals requiresFinalize instead of a silent allow for in-review + merge proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-322", column: "in-review", mergeDetails: { mergeConfirmed: true } },
        "end",
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresFinalize).toBe(true);
    });

    it("REPRO: rejects nodeId='end' with an explicit error when there is NO merge proof (never silent)", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-322", column: "in-review" },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("terminal-without-merge-proof");
      expect(result.message).toContain("FN-322");
      expect(result.message).toContain("nodeId='end'");
      expect(result.message?.toLowerCase()).toContain("merge");
    });

    it("rejects nodeId='end' with explicit error when mergeConfirmed is explicitly false", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-375", column: "in-review", mergeDetails: { mergeConfirmed: false } },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("terminal-without-merge-proof");
    });

    it("allows nodeId='end' as a no-op when the task is already done, even without merge proof", () => {
      const result = validateNodeOverrideChange({ id: "FN-340", column: "done" }, "end");
      expect(result).toEqual({ allowed: true });
    });

    it("does not gate non-terminal nodeId overrides even with no merge proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "plan-review",
      );
      expect(result).toEqual({ allowed: true });
    });

    it("does not gate clearing the override (null) even on a terminal-eligible task with no proof", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review", nodeId: "end" },
        null,
      );
      expect(result).toEqual({ allowed: true });
    });

    it("still blocks in-progress tasks before the terminal-node check runs", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "in-progress", mergeDetails: { mergeConfirmed: true } },
        "end",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("task-in-progress");
    });

    it("uses a caller-supplied isTerminalNodeId resolver instead of the literal 'end' fallback", () => {
      const isTerminalNodeId = (nodeId: string) => nodeId === "custom-terminal";

      const noProof = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "custom-terminal",
        { isTerminalNodeId },
      );
      expect(noProof.allowed).toBe(false);
      expect(noProof.reason).toBe("terminal-without-merge-proof");

      const literalEndNotTerminalHere = validateNodeOverrideChange(
        { id: "FN-1", column: "in-review" },
        "end",
        { isTerminalNodeId },
      );
      expect(literalEndNotTerminalHere).toEqual({ allowed: true });
    });

    it("todo/in-progress non-terminal cards with merge proof are unaffected by the terminal gate", () => {
      const result = validateNodeOverrideChange(
        { id: "FN-1", column: "todo", mergeDetails: { mergeConfirmed: true } },
        "execute",
      );
      expect(result).toEqual({ allowed: true });
    });
  });
});
