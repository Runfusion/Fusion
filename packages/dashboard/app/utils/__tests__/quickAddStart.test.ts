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
  it("limits resolved built-ins to Coding Ideas", () => {
    const resolvedBuiltinFirstColumns = [
      ["builtin:coding-ideas", { intake: true, hold: true, manualIntake: true }, true],
      ["builtin:coding", { intake: true, hold: true }, false],
      ["builtin:quick-fix", { intake: true, hold: true }, false],
      ["builtin:stepwise-coding", { intake: true, hold: true }, false],
      ["builtin:review-heavy", { intake: true, hold: true }, false],
      ["builtin:design", { intake: true, hold: true }, false],
      ["builtin:compound-engineering", { intake: true, hold: true }, false],
      ["builtin:marketing", { intake: true, hold: true }, false],
      ["builtin:pr-workflow", { intake: true, hold: true }, false],
    ] as const;

    for (const [id, flags, expected] of resolvedBuiltinFirstColumns) {
      expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({
        id,
        columns: [{ id: "planning", flags }, { id: "done", flags: { complete: true } }],
      })))).toBe(expected);
    }
  });

  it("requires a first visible manual intake and complete runtime metadata", () => {
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow()))).toBe(false);
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "waiting", flags: { intake: true, hold: true, manualIntake: true } },
      { id: "todo", flags: {} },
    ] })))).toBe(true);
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "archived", flags: { archived: true, manualIntake: true } },
      { id: "waiting", flags: { manualIntake: true } },
    ] })))).toBe(true);
    expect(workflowSupportsQuickAddStart(validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "hidden", flags: { hiddenFromBoard: true, manualIntake: true } },
      { id: "planning", flags: { intake: true, hold: true } },
    ] })))).toBe(false);
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
