import { describe, expect, it } from "vitest";
import { resolveQuickAddStartInitialColumn, resolveQuickAddStartTargetColumn, validateQuickAddStartWorkflow, workflowSupportsQuickAddStart } from "../quickAddStart";

const workflow = (overrides: Record<string, unknown> = {}) => ({
  id: "custom",
  name: "Custom",
  columns: [
    { id: "ideas", name: "Ideas", flags: { hold: true } },
    { id: "todo", name: "Todo", flags: {} },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
  ...overrides,
});

describe("quick add Start workflow guards", () => {
  it("requires complete runtime metadata before builtin or hold eligibility", () => {
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas" })))).toBe(true);
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow()))).toBe(true);
    expect(validateQuickAddStartWorkflow(workflow({ id: "__all_workflows__" }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "", flags: {} }] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "a", flags: {} }, { id: "a", flags: {} }] }))).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({ columns: [{ id: "a", flags: null }] }))).toBeNull();
  });

  it("derives Todo only from a captured, visible Coding Ideas definition", () => {
    const canonical = validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas" }));
    expect(canonical).not.toBeNull();
    expect(resolveQuickAddStartInitialColumn(canonical!)).toBe("todo");

    for (const columns of [
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { hiddenFromBoard: true } }],
      [{ id: "todo", flags: {} }, { id: "ideas", flags: { hold: true } }],
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { intake: true } }],
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { complete: true } }],
    ]) {
      const invalidTarget = validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas", columns }));
      expect(invalidTarget).not.toBeNull();
      expect(resolveQuickAddStartInitialColumn(invalidTarget!)).toBeNull();
    }

    expect(resolveQuickAddStartInitialColumn(validateQuickAddStartWorkflow(workflow())!)).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({
      id: "builtin:coding-ideas",
      columns: [{ id: "ideas", flags: {} }, { id: "todo", flags: {} }, { id: "todo", flags: {} }],
    }))).toBeNull();
  });

  it("only chooses a later visible working destination", () => {
    const valid = validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "ideas", name: "Ideas", flags: { hold: true } },
      { id: "review", name: "Review", flags: { hold: true } },
      { id: "done", name: "Done", flags: { complete: true } },
      { id: "todo", name: "Todo", flags: {} },
    ] }));
    expect(valid).not.toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "ideas")).toBe("todo");
    expect(resolveQuickAddStartTargetColumn(valid!, "todo")).toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "unknown")).toBeNull();
  });
});
