import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { getRunningOptionalGateBadge, getUnifiedTaskProgress, isPlanReviewRunning } from "../taskProgress";

/*
FNXC:WorkflowSteps 2026-06-25-00:00 — graph-native progress model (plan U3).
These tests pin the render-state contract that the progress bar / Workflow tab rely on:
- names resolve from result.workflowStepName (no DB-row name lookup), with a humanized node-id fallback;
- a "pending" result with a startedAt and no completedAt is the `running` state, vs bare `pending`;
- advisory_failure (non-blocking) is distinct from failed (blocking) and counts as completed;
- disabled optional steps (absent from enabledWorkflowSteps) never appear in the counter/bar.
*/

function makeTask(overrides: Partial<Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">>) {
  return {
    steps: [],
    enabledWorkflowSteps: [],
    workflowStepResults: [],
    ...overrides,
  } as Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">;
}

describe("isPlanReviewRunning", () => {
  it.each([
    { name: "undefined results", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: undefined }, expected: false },
    { name: "pending but not started", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending" }] }, expected: false },
    { name: "started and not completed", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending", startedAt: "2026-07-11T12:00:00.000Z" }] }, expected: true },
    { name: "passed", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }] }, expected: false },
    { name: "failed", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }] }, expected: false },
    { name: "skipped", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "skipped", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }] }, expected: false },
    { name: "advisory failure", task: { enabledWorkflowSteps: ["plan-review"], workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "advisory_failure", startedAt: "2026-07-11T12:00:00.000Z", completedAt: "2026-07-11T12:01:00.000Z" }] }, expected: false },
  ])("returns $expected for $name", ({ task, expected }) => {
    expect(isPlanReviewRunning(makeTask(task as Partial<Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">>))).toBe(expected);
  });
});

/*
FNXC:TaskCardOptionalGateBadge 2026-07-21-22:30:
Lane-owned optional gates badge only in their planning/review columns while running.
*/
describe("getRunningOptionalGateBadge", () => {
  const runningPlanReview = {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "pending" as const,
    startedAt: "2026-07-11T12:00:00.000Z",
  };
  const runningCodeReview = {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    status: "pending" as const,
    startedAt: "2026-07-11T12:00:00.000Z",
  };
  const runningBrowser = {
    workflowStepId: "browser-verification",
    workflowStepName: "Browser Verification",
    status: "pending" as const,
    startedAt: "2026-07-11T12:00:00.000Z",
  };

  /*
  FNXC:TaskCardOptionalGateBadge 2026-07-27-06:10:
  Plan Review badges in EVERY column it can run in. The enumeration is the point: placement is the
  WORKFLOW's call — the built-in coding workflows run this node in the planning column, a custom or
  future workflow may place it elsewhere — so the badge must key on the running gate, not on a lane
  allowlist that silently hides every placement it did not anticipate.
  */
  it("badges Plan Review in every column the gate can run in", () => {
    for (const column of ["triage", "todo", "in-progress"] as const) {
      const badge = getRunningOptionalGateBadge({
        ...makeTask({
          enabledWorkflowSteps: ["plan-review"],
          workflowStepResults: [runningPlanReview],
        }),
        column,
      } as Task);
      expect(badge?.label).toBe("Plan Review");
      expect(badge?.testId).toBe("reviewing");
    }
    // The replan half of the loop badges the same way, wherever the remediation node lives.
    expect(getRunningOptionalGateBadge({
      ...makeTask({
        enabledWorkflowSteps: ["plan-replan"],
        workflowStepResults: [{ ...runningPlanReview, workflowStepId: "plan-replan", workflowStepName: "Plan Replan" }],
      }),
      column: "triage",
    } as Task)).toMatchObject({ label: "Plan Review", testId: "reviewing" });
  });

  it("badges Code Review and Browser Verification on in-review only", () => {
    expect(getRunningOptionalGateBadge({
      ...makeTask({
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [runningCodeReview],
      }),
      column: "in-review",
    } as Task)).toMatchObject({ label: "Code Review", testId: "code-review" });

    expect(getRunningOptionalGateBadge({
      ...makeTask({
        enabledWorkflowSteps: ["browser-verification"],
        workflowStepResults: [runningBrowser],
      }),
      column: "in-review",
    } as Task)).toMatchObject({ label: "Browser Verification", testId: "browser-verification" });

    expect(getRunningOptionalGateBadge({
      ...makeTask({
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [runningCodeReview],
      }),
      column: "in-progress",
    } as Task)).toBeUndefined();
  });

  it("returns undefined when the gate is not running", () => {
    expect(getRunningOptionalGateBadge({
      ...makeTask({
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "pending",
        }],
      }),
      column: "in-review",
    } as Task)).toBeUndefined();
  });
});

describe("getUnifiedTaskProgress", () => {
  it("resolves workflow step names from result.workflowStepName without a lookup", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["browser-verification"],
        workflowStepResults: [
          {
            workflowStepId: "browser-verification",
            workflowStepName: "Browser Verification",
            status: "passed",
          },
        ],
      }),
    );

    const item = progress.items.find((i) => i.id === "workflow-browser-verification");
    expect(item?.name).toBe("Browser Verification");
    expect(item?.status).toBe("done");
  });

  /*
  FNXC:TaskCardWorkflowProgress 2026-07-21-22:26:
  Implementation scope is the WIP progress contract: Plan Review / Code Review and other lane-owned gates stay out of the in-progress checklist while full scope keeps the complete pipeline for detail and badges.
  */
  it("implementation scope keeps only WIP steps, not Plan Review or Code Review", () => {
    const task = makeTask({
      steps: [
        { name: "Implement feature", status: "done" },
        { name: "Add tests", status: "in-progress" },
      ] as Task["steps"],
      enabledWorkflowSteps: ["plan-review", "code-review", "browser-verification"],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "passed",
          startedAt: "2026-07-11T12:00:00.000Z",
          completedAt: "2026-07-11T12:01:00.000Z",
        },
        {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "pending",
        },
      ],
    });

    const full = getUnifiedTaskProgress(task);
    expect(full.items.map((item) => item.id)).toEqual([
      "workflow-plan-review",
      "step-0",
      "step-1",
      "workflow-code-review",
      "workflow-browser-verification",
    ]);
    expect(full.total).toBe(5);
    expect(full.completed).toBe(2);

    const implementation = getUnifiedTaskProgress(task, { scope: "implementation" });
    expect(implementation.items.map((item) => item.id)).toEqual(["step-0", "step-1"]);
    expect(implementation.total).toBe(2);
    expect(implementation.completed).toBe(1);
  });

  it("falls back to the workflow step id when no result name is available", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [],
      }),
    );

    const item = progress.items.find((i) => i.id === "workflow-code-review");
    // Enabled-but-not-run has no recorded name → humanize the node id to proper casing,
    // never render the raw lowercase id.
    expect(item?.name).toBe("Code Review");
    // Enabled but never run → pending.
    expect(item?.status).toBe("pending");
  });

  it("humanizes the node id to proper casing for an enabled-but-not-run step", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["browser-verification", "frontend-ux-design", "code-review"],
        workflowStepResults: [],
      }),
    );
    expect(progress.items.find((i) => i.id === "workflow-browser-verification")?.name).toBe("Browser Verification");
    expect(progress.items.find((i) => i.id === "workflow-frontend-ux-design")?.name).toBe("Frontend UX Design");
    expect(progress.items.find((i) => i.id === "workflow-code-review")?.name).toBe("Code Review");
  });

  it("distinguishes running (started, not completed) from pending (not started)", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["running-step", "not-started-step"],
        workflowStepResults: [
          {
            workflowStepId: "running-step",
            workflowStepName: "Running Step",
            status: "pending",
            startedAt: "2026-06-25T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(progress.items.find((i) => i.id === "workflow-running-step")?.status).toBe("running");
    expect(progress.items.find((i) => i.id === "workflow-not-started-step")?.status).toBe("pending");
  });

  it("treats a completed pending entry (startedAt + completedAt) as pending, not running", () => {
    // Defensive: a terminal entry should carry a non-pending status, but if a pending entry has
    // both timestamps it is not actively running.
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["edge"],
        workflowStepResults: [
          {
            workflowStepId: "edge",
            workflowStepName: "Edge",
            status: "pending",
            startedAt: "2026-06-25T00:00:00.000Z",
            completedAt: "2026-06-25T00:01:00.000Z",
          },
        ],
      }),
    );

    expect(progress.items.find((i) => i.id === "workflow-edge")?.status).toBe("pending");
  });

  it("maps advisory_failure (non-blocking) distinctly from failed (blocking)", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["advisory", "gate"],
        workflowStepResults: [
          { workflowStepId: "advisory", workflowStepName: "Advisory", status: "advisory_failure" },
          { workflowStepId: "gate", workflowStepName: "Gate", status: "failed" },
        ],
      }),
    );

    expect(progress.items.find((i) => i.id === "workflow-advisory")?.status).toBe("advisory_failure");
    expect(progress.items.find((i) => i.id === "workflow-gate")?.status).toBe("failed");
    // advisory_failure counts as completed (non-blocking); failed does not.
    expect(progress.completed).toBe(1);
  });

  it("excludes a disabled step (absent from enabledWorkflowSteps) from the count", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        // "disabled-step" is toggled off → not in enabledWorkflowSteps, even though a stale result exists.
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [
          { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed" },
          { workflowStepId: "disabled-step", workflowStepName: "Disabled", status: "passed" },
        ],
      }),
    );

    expect(progress.total).toBe(1);
    expect(progress.items.some((i) => i.id === "workflow-disabled-step")).toBe(false);
  });

  it("includes recorded graph-node progress that is not an optional toggle", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: [],
        workflowStepResults: [
          {
            workflowStepId: "plan",
            workflowStepName: "Plan",
            source: "node",
            status: "passed",
            startedAt: "2026-06-29T21:49:55.355Z",
            completedAt: "2026-06-29T21:51:00.000Z",
          },
          {
            workflowStepId: "execute",
            workflowStepName: "Execute",
            source: "node",
            status: "pending",
            startedAt: "2026-06-29T21:51:00.996Z",
          },
          {
            workflowStepId: "code-review",
            workflowStepName: "Code Review",
            source: "optional-group",
            status: "passed",
            startedAt: "2026-06-29T21:52:00.000Z",
            completedAt: "2026-06-29T21:52:20.000Z",
          },
        ],
      }),
    );

    expect(progress.items.map((item) => [item.id, item.name, item.status])).toEqual([
      ["workflow-plan", "Plan", "done"],
      ["workflow-execute", "Execute", "running"],
    ]);
    expect(progress.total).toBe(2);
    expect(progress.completed).toBe(1);
  });

  it("produces 8 items with the correct completed count for 6 impl steps + 2 workflow steps", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        steps: [
          { name: "Step 1", status: "done" },
          { name: "Step 2", status: "done" },
          { name: "Step 3", status: "done" },
          { name: "Step 4", status: "done" },
          { name: "Step 5", status: "done" },
          { name: "Step 6", status: "done" },
        ],
        enabledWorkflowSteps: ["browser-verification", "code-review"],
        workflowStepResults: [
          { workflowStepId: "browser-verification", workflowStepName: "Browser Verification", status: "passed" },
          { workflowStepId: "code-review", workflowStepName: "Code Review", status: "advisory_failure" },
        ],
      }),
    );

    expect(progress.total).toBe(8);
    expect(progress.items).toHaveLength(8);
    // 6 done impl steps + 1 passed (done) + 1 advisory_failure (non-blocking → completed) = 8.
    expect(progress.completed).toBe(8);
    expect(progress.items.filter((i) => i.source === "step")).toHaveLength(6);
    expect(progress.items.filter((i) => i.source === "workflow")).toHaveLength(2);
  });

  it("orders Plan Review before implementation steps and Code Review after them", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        steps: [
          { name: "Preflight", status: "pending" },
          { name: "Implement", status: "pending" },
        ],
        enabledWorkflowSteps: ["plan-review", "code-review"],
        workflowStepResults: [
          {
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            phase: "pre-merge",
            status: "failed",
            startedAt: "2026-06-29T07:38:49.871Z",
            completedAt: "2026-06-29T07:38:57.744Z",
          },
        ],
      }),
    );

    expect(progress.items.map((item) => item.name)).toEqual([
      "Plan Review",
      "Preflight",
      "Implement",
      "Code Review",
    ]);
    expect(progress.items.map((item) => item.id)).toEqual([
      "workflow-plan-review",
      "step-0",
      "step-1",
      "workflow-code-review",
    ]);
  });

  it("maps impl step statuses straight through and skipped as completed", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        steps: [
          { name: "Done", status: "done" },
          { name: "Skipped", status: "skipped" },
          { name: "In progress", status: "in-progress" },
          { name: "Pending", status: "pending" },
        ],
      }),
    );

    expect(progress.total).toBe(4);
    // done + skipped count as completed; in-progress + pending do not.
    expect(progress.completed).toBe(2);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-15:50:

THE INVARIANT: the running-gate badge appears in the board's OWN review lane.

CENSUS-INVISIBLE, in a HALF-CONVERTED file. `REVIEW_LANE_COLUMNS` is a `Set` literal — a definition,
not a comparison — sitting under a Plan Review badge whose own column restriction had already been
removed. One converted badge and one unconverted one, deciding sibling questions about the same card.

Keyed on the literal, the code-review / browser-verification / post-merge badges never appeared on a
renamed board: the gate WAS running and the card showed nothing, which reads as an idle card rather
than a missing badge. Cosmetic in consequence, but it is the surface an operator watches to know a
review is in flight.

The caller is wired in the same change — `ListView` already owns `columnFlagsById`, so the resolved
answer was one lookup away. An unwired parameter is the class this program's caller audit found five
times; adding a sixth would have been careless.

REVERT PROOF, measured: restore the literal gate and the renamed-lane case returns undefined.
*/
describe("the running-gate badge resolves the review lane", () => {
  const REVIEW_FLAGS = { mergeBlocker: true } as never;
  /* `makeTask` is file-scoped but `runningCodeReview` is not, so the shape is restated here. My
     first draft hand-rolled `status: "in-progress"` and produced no RUNNING item at all — a gate
     counts as running only when it is `pending` WITH a `startedAt` — so the renamed case failed for
     the wrong reason. The fixture has to match the branch under test. */
  const codeReviewRunning = (column: string) => ({
    ...makeTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "pending" as const,
        startedAt: "2026-07-11T12:00:00.000Z",
      }],
    }),
    column,
  }) as never;

  it("badges a card in a RENAMED review lane", () => {
    /* testId is `code-review`, not the plan-review badge's `reviewing` — I asserted the latter first
       and the failure was mine, not the product's. */
    expect(getRunningOptionalGateBadge(codeReviewRunning("signoff"), REVIEW_FLAGS)?.testId).toBe("code-review");
  });

  it("still does not badge a card outside the review lane", () => {
    // The gate must stay a gate — badging everywhere is its own bug.
    expect(getRunningOptionalGateBadge(codeReviewRunning("building"), { countsTowardWip: true } as never)).toBeUndefined();
  });

  it("keeps the legacy id when no flags are supplied", () => {
    expect(getRunningOptionalGateBadge(codeReviewRunning("in-review"))?.testId).toBe("code-review");
    expect(getRunningOptionalGateBadge(codeReviewRunning("signoff"))).toBeUndefined();
  });
});
