import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateTaskDoneRefusal } from "../executor.js";

describe("FN-4946 shared task_done refusal helper invariant", () => {
  it("keeps a single helper implementation and routes explicit+implicit paths through it", () => {
    const source = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");
    const invocations = source.match(/evaluateTaskDoneRefusal\(/g) ?? [];
    const helperDecl = source.match(/\bfunction evaluateTaskDoneRefusal\b/g) ?? [];

    expect(invocations.length).toBeGreaterThanOrEqual(3);
    expect(helperDecl).toHaveLength(1);
  });

  it("returns pending-code-review-revise for a pending step with REVISE and no summary", () => {
    const result = evaluateTaskDoneRefusal(
      {
        id: "FN-4946-H",
        title: "t",
        description: "",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Step 1", status: "in-progress" }],
        currentStep: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any,
      {},
      new Map([[0, "REVISE"]]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusalClass).toBe("pending-code-review-revise");
  });
});
