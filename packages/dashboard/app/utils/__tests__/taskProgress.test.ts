import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { getUnifiedTaskProgress } from "../taskProgress";

/*
FNXC:WorkflowSteps 2026-06-25 — graph-native progress model (plan U3).
These tests pin the render-state contract that the progress bar / Workflow tab rely on:
- names resolve from result.workflowStepName (no DB-row name lookup), with a raw-id fallback;
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

  it("falls back to the workflow step id when no result name is available", () => {
    const progress = getUnifiedTaskProgress(
      makeTask({
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [],
      }),
    );

    const item = progress.items.find((i) => i.id === "workflow-code-review");
    expect(item?.name).toBe("code-review");
    // Enabled but never run → pending.
    expect(item?.status).toBe("pending");
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
