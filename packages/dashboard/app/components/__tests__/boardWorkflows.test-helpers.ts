/*
FNXC:WorkflowResolvedColumns 2026-07-30-07:20:
THE DEFAULT BOARD-WORKFLOWS FIXTURE, shared so it cannot drift per file.

`ListView` early-returns a workflow skeleton when the board has no workflows, and that skeleton
carries the same `list-view` class as the real body. A fixture with `workflows: []` therefore renders
something that satisfies "the list rendered" while containing none of the list's controls.

`workflows: []` used to be correct — the `flagEnabled: false` path rendered legacy columns and needed
no workflow at all. U12 deleted that path, so an empty array now means "this board has no lanes". Two
separate test files kept their own empty copy and both went quietly wrong: App.test.tsx went red for
five days, and two board-mobile-view-switch cases kept PASSING while asserting against a skeleton.

Hence one shared fixture rather than another private copy. Mirrors the builtin coding lanes with the
trait flags the board actually reads; tests that need a different board should spread and override.

NOTE ON board-mobile-view-switch.test.tsx: it still has its own `workflows: []` copy, deliberately.
Its two cases assert SYNCHRONOUSLY, before ListView's async workflow fetch resolves, so they match
the skeleton by construction — adopting this fixture does not change that, and making them await the
real body turned up a separate harness failure I could not resolve. They are weak, not broken;
tracked on #2829 rather than churned here.
*/
export const DEFAULT_BOARD_WORKFLOWS = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "todo", name: "Todo", flags: { hold: true, intake: true } },
        { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
        {
          id: "in-review",
          name: "In Review",
          flags: { countsTowardWip: true, mergeBlocker: true, mergeOrchestration: true, humanReview: true },
        },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};
