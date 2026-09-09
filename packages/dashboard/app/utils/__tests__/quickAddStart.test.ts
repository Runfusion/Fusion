import { describe, expect, it } from "vitest";
import { resolveQuickAddStartInitialColumn, resolveQuickAddStartTargetColumn, resolveQuickAddStartWorkflowTarget, validateQuickAddStartWorkflow, workflowSupportsQuickAddStart } from "../quickAddStart";

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
      ["builtin:coding-ideas-v2", { intake: true, hold: true, manualIntake: true }, true],
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
    const canonical = validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas-v2" }));
    expect(canonical).not.toBeNull();
    expect(resolveQuickAddStartInitialColumn(canonical!)).toBe("todo");

    for (const columns of [
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { hiddenFromBoard: true } }],
      [{ id: "todo", flags: {} }, { id: "ideas", flags: { hold: true } }],
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { intake: true } }],
      [{ id: "ideas", flags: { hold: true } }, { id: "todo", flags: { complete: true } }],
    ]) {
      const invalidTarget = validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas-v2", columns }));
      expect(invalidTarget).not.toBeNull();
      expect(resolveQuickAddStartInitialColumn(invalidTarget!)).toBeNull();
    }

    expect(resolveQuickAddStartInitialColumn(validateQuickAddStartWorkflow(workflow())!)).toBeNull();
    expect(validateQuickAddStartWorkflow(workflow({
      id: "builtin:coding-ideas-v2",
      columns: [{ id: "ideas", flags: {} }, { id: "todo", flags: {} }, { id: "todo", flags: {} }],
    }))).toBeNull();
  });

  it("resolves the Ideas shape identically for the successor and a custom workflow", () => {
    const columns = [
      { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
      { id: "todo", name: "Planning", flags: { hold: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ];
    const successor = validateQuickAddStartWorkflow(workflow({ id: "builtin:coding-ideas-v2", columns }));
    const custom = validateQuickAddStartWorkflow(workflow({ id: "WF-IDEAS-COPY", columns }));

    expect(resolveQuickAddStartInitialColumn(successor!)).toBe("todo");
    expect(resolveQuickAddStartInitialColumn(custom!)).toBe("todo");
  });

  it("keeps trait routing for other manual-intake workflows", () => {
    const other = validateQuickAddStartWorkflow(workflow({
      id: "WF-MANUAL-INTAKE",
      columns: [
        { id: "capture", name: "Capture", flags: { intake: true, manualIntake: true } },
        { id: "ready", name: "Ready", flags: { hold: true } },
      ],
    }));

    expect(resolveQuickAddStartInitialColumn(other!)).toBe("ready");
    expect(resolveQuickAddStartWorkflowTarget(other)).toBe("ready");
  });

  it("hides Start when the successor metadata is reordered", () => {
    const reordered = validateQuickAddStartWorkflow(workflow({
      id: "builtin:coding-ideas-v2",
      columns: [
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    }));

    expect(resolveQuickAddStartWorkflowTarget(reordered)).toBeNull();
  });

  it("proves a Start target from the manual intake lane", () => {
    const valid = validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "waiting", name: "Waiting", flags: { intake: true, manualIntake: true } },
      { id: "building", name: "Building", flags: {} },
      { id: "done", name: "Done", flags: { complete: true } },
    ] }));
    expect(resolveQuickAddStartWorkflowTarget(valid)).toBe("building");
    const noTarget = validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "waiting", name: "Waiting", flags: { intake: true, manualIntake: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ] }));
    expect(resolveQuickAddStartWorkflowTarget(noTarget)).toBeNull();
  });

  /*
  FNXC:QuickAddStart 2026-08-26-19:19:
  Was "only chooses a later visible working destination", which asserted that the promotion skipped
  `hold` lanes to reach the first working column. Column adjacency never permitted that jump, so the
  move it described was rejected server-side. The promotion is one legal forward step.
  */
  it("promotes exactly one legal forward step, hold lanes included", () => {
    const valid = validateQuickAddStartWorkflow(workflow({ columns: [
      { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
      { id: "review", name: "Review", flags: { hold: true } },
      { id: "done", name: "Done", flags: { complete: true } },
      { id: "todo", name: "Todo", flags: {} },
    ] }));
    expect(valid).not.toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "ideas")).toBe("review");
    expect(resolveQuickAddStartTargetColumn(valid!, "review")).toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "todo")).toBeNull();
    expect(resolveQuickAddStartTargetColumn(valid!, "unknown")).toBeNull();
  });

  /*
  FNXC:QuickAddStart 2026-08-26-19:19:
  Regression: a duplicated Ideas workflow reported as "Start does not start the task". Start
  resolved its destination from a named built-in id, so a copy fell
  through to a promotion that skipped the Planning hold lane and targeted the WIP lane — a move
  `intake -> wip` that column adjacency always rejects. Surfaces: both Start callers share these
  helpers (QuickEntryBox composer and NewTaskModal), so the invariant is asserted here once for the
  built-in, its duplicate, and the metadata shapes that must fail closed.
  */
  describe("duplicated Ideas workflows", () => {
    const clone = (overrides: Record<string, unknown> = {}) => validateQuickAddStartWorkflow(workflow({
      id: "WF-014",
      name: "Coding ideas",
      columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In review", flags: { mergeBlocker: true, humanReview: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
      ...overrides,
    }));

    it("creates in its own Planning lane instead of jumping into the WIP lane", () => {
      const duplicate = clone();
      expect(duplicate).not.toBeNull();
      expect(workflowSupportsQuickAddStart(duplicate)).toBe(true);
      expect(resolveQuickAddStartInitialColumn(duplicate!)).toBe("todo");
      expect(resolveQuickAddStartWorkflowTarget(duplicate)).toBe("todo");
      // The rejected move that made Start a no-op must be unreachable from the intake lane.
      expect(resolveQuickAddStartTargetColumn(duplicate!, "ideas")).not.toBe("in-progress");
    });

    it("fails closed to the promotion path when the planning lane is unprovable", () => {
      // The server classifies a Start create by the FIRST DECLARED hold column, so an intake that
      // also holds, or a hidden earlier hold lane, means our visible candidate is the wrong column.
      const intakeAlsoHolds = clone({ columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true, hold: true, manualIntake: true } },
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ] });
      expect(resolveQuickAddStartInitialColumn(intakeAlsoHolds!)).toBeNull();
      expect(resolveQuickAddStartWorkflowTarget(intakeAlsoHolds)).toBe("todo");

      const hiddenEarlierHold = clone({ columns: [
        { id: "parked", name: "Parked", flags: { hold: true, hiddenFromBoard: true } },
        { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ] });
      expect(resolveQuickAddStartInitialColumn(hiddenEarlierHold!)).toBeNull();

      const noPlanningLane = clone({ columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true, manualIntake: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ] });
      expect(resolveQuickAddStartInitialColumn(noPlanningLane!)).toBeNull();
      expect(resolveQuickAddStartWorkflowTarget(noPlanningLane)).toBe("in-progress");

      const autoTriagingIntake = clone({ columns: [
        { id: "ideas", name: "Ideas", flags: { intake: true } },
        { id: "todo", name: "Planning", flags: { hold: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ] });
      expect(resolveQuickAddStartInitialColumn(autoTriagingIntake!)).toBeNull();
      expect(resolveQuickAddStartWorkflowTarget(autoTriagingIntake)).toBeNull();
    });
  });
});
