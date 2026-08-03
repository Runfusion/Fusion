import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateTaskDoneRefusal } from "../executor.js";

describe("FN-4946 shared task_done refusal helper invariant", () => {
  it("keeps a single helper implementation and routes explicit+implicit paths through it", () => {
    /*
    FNXC:CodeOrganization 2026-08-03-07:30:
    Wave18 peels evaluateTaskDoneRefusal into executor/task-done-refusal.ts; executor.ts
    re-exports it. The single-implementation invariant still holds: one export function
    declaration in the domain module, multiple call sites in the executor facade.

    FNXC:CodeOrganization 2026-08-03-13:45:
    Implicit completion path peels into completion-predicates.ts; count call sites across
    facade + that peel so the ratchet still covers explicit and implicit routes.

    FNXC:CodeOrganization 2026-08-03-13:10:
    Explicit fn_task_done path peels into create-task-done-tool.ts; include that call site
    so the ratchet still counts both routes after the U4 tool peel.
    */
    const facade = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");
    const implicitPeel = readFileSync(new URL("../executor/completion-predicates.ts", import.meta.url), "utf8");
    const explicitPeel = readFileSync(new URL("../executor/create-task-done-tool.ts", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../executor/task-done-refusal.ts", import.meta.url), "utf8");
    const isCallSite = (line: string) =>
      /evaluateTaskDoneRefusal\s*\(/.test(line)
      && !line.includes("from \"./executor/task-done-refusal")
      && !line.includes('from "./task-done-refusal')
      && !/^\s*(import|export)\b/.test(line.trim())
      && !/evaluateTaskDoneRefusal,/.test(line);
    // Call sites only — skip re-export/import lines.
    const callLines = [
      ...facade.split("\n").filter(isCallSite),
      ...implicitPeel.split("\n").filter(isCallSite),
      ...explicitPeel.split("\n").filter(isCallSite),
    ];
    const helperDecl = helper.match(/\bexport function evaluateTaskDoneRefusal\b/g) ?? [];

    // Exact count: explicit (create-task-done-tool) + implicit (completion-predicates).
    expect(callLines.length).toBe(2);
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
