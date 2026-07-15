/*
FNXC:TaskStepNumbering 2026-07-05-00:00:
Regression test for FN-7612 (Runfusion/Fusion#1921): the task-dialog step
indicators (ActiveAgentsPanel "Step N/Total", TaskTokenStatsPanel "N / Total")
must show the SAME step number as the Activity surface for the same
underlying step. The Activity surface's convention is the engine's raw
0-based `stepIndex` (Step 0 = Preflight), as literally embedded in task log
lines such as "code review requested for Step N" (see executor.ts's
`detectPendingReviewBlock`) and in `createWorkflowStepActivityRun`'s
`stepIndex` context field (step-session-executor.ts). This test builds ONE
shared TaskDetail fixture per data state, derives the "Activity" step number
independently from a log-line convention (not from the shared display
helper, so the assertion isn't tautological), then renders both task-dialog
surfaces from that SAME fixture and asserts their displayed numbers match it.

Before the fix, ActiveAgentsPanel/TaskTokenStatsPanel added `+ 1` to
`task.currentStep`, so this test would FAIL (their number was one higher
than the Activity number) for every non-empty-steps case below. After the
fix (both surfaces derive their number from `getCanonicalStepNumber`, which
returns the raw, clamped `task.currentStep`), the test PASSES.
*/
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { ActiveAgentsPanel } from "../ActiveAgentsPanel";
import { TaskTokenStatsPanel } from "../TaskTokenStatsPanel";
import { getCanonicalStepNumber } from "../../lib/step-display";
import type { Agent } from "../../api";

const fetchTaskDetailMock = vi.fn();

vi.mock("../../api", () => ({
  fetchTaskDetail: (...args: unknown[]) => fetchTaskDetailMock(...args),
}));

vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: () => ({ entries: [], isConnected: true }),
}));
/*
FNXC:TaskStepNumbering 2026-07-11-00:00:
RuntimeFallbackBadge (added in commit 0bed997af / FUX-022) calls the shared useToast() hook directly.
This file renders <ActiveAgentsPanel> (which embeds RuntimeFallbackBadge) outside a ToastProvider, so
mock the hook to avoid "useToast must be used within ToastProvider" failures, matching the TaskCard.test.tsx pattern.
*/
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

/**
 * Derives the Activity-tab's step number the way an operator would read it —
 * from the raw 0-based `stepIndex` embedded in a task log line, mirroring
 * `executor.ts`'s "code review requested for Step N" / verdict-prefix
 * convention. Intentionally independent of `getCanonicalStepNumber` so the
 * test does not just assert the helper agrees with itself.
 */
function activityStepNumberFromLog(task: Pick<Task, "log">): number {
  for (const entry of task.log ?? []) {
    const match = entry.action?.match(/Step (\d+)/);
    if (match) return Number(match[1]);
  }
  throw new Error("fixture is missing an Activity-convention log line");
}

function makeStep(name: string, status: Task["steps"][number]["status"] = "pending") {
  return { name, status };
}

function makeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7612-T",
    prompt: "",
    description: "Step numbering fixture",
    column: "in-progress",
    dependencies: [],
    steps: [
      makeStep("Preflight", "done"),
      makeStep("Implement", "in-progress"),
      makeStep("Test", "pending"),
    ],
    currentStep: 1,
    log: [{ timestamp: "2026-07-05T00:00:00.000Z", action: "code review requested for Step 1" }],
    status: "executing",
    paused: false,
    executionMode: "standard",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

describe("step number alignment between task-dialog and Activity surfaces (FN-7612)", () => {
  const cases: Array<{ name: string; task: TaskDetail }> = [
    {
      name: "current step is Preflight (index 0)",
      task: makeTaskDetail({
        steps: [makeStep("Preflight", "in-progress"), makeStep("Implement", "pending"), makeStep("Test", "pending")],
        currentStep: 0,
        log: [{ timestamp: "2026-07-05T00:00:00.000Z", action: "code review requested for Step 0" }],
      }),
    },
    {
      name: "mid-task in-progress step",
      task: makeTaskDetail({
        steps: [makeStep("Preflight", "done"), makeStep("Implement", "in-progress"), makeStep("Test", "pending"), makeStep("Docs", "pending")],
        currentStep: 1,
        log: [{ timestamp: "2026-07-05T00:00:00.000Z", action: "code review requested for Step 1" }],
      }),
    },
    {
      name: "current step is the last step",
      task: makeTaskDetail({
        steps: [makeStep("Preflight", "done"), makeStep("Implement", "done"), makeStep("Docs", "in-progress")],
        currentStep: 2,
        log: [{ timestamp: "2026-07-05T00:00:00.000Z", action: "code review Step 2: APPROVE" }],
      }),
    },
    {
      name: "currentStep overflow is clamped (stale step index beyond steps.length)",
      task: makeTaskDetail({
        steps: [makeStep("Preflight", "done"), makeStep("Implement", "done")],
        currentStep: 5,
        // The Activity log line reflects the last real step that ran (index 1);
        // both surfaces must clamp to that same bound, never rendering "Step 6/2".
        log: [{ timestamp: "2026-07-05T00:00:00.000Z", action: "code review Step 1: APPROVE" }],
      }),
    },
  ];

  for (const { name, task } of cases) {
    it(`renders the same step number in ActiveAgentsPanel and TaskTokenStatsPanel as Activity (${name})`, async () => {
      const expectedStepNumber = activityStepNumberFromLog(task);
      expect(getCanonicalStepNumber(task).stepNumber).toBe(expectedStepNumber);

      // --- TaskTokenStatsPanel ("N / Total") ---
      const { unmount: unmountStats } = render(
        <TaskTokenStatsPanel loading={false} tokenUsage={undefined} task={task} />,
      );
      const totalSteps = task.steps.length;
      expect(screen.getByText(`${expectedStepNumber} / ${totalSteps}`)).toBeInTheDocument();
      unmountStats();

      // --- ActiveAgentsPanel ("Step N/Total: Name") ---
      fetchTaskDetailMock.mockResolvedValueOnce(task);
      const agent: Agent = {
        id: "agent-fn7612",
        name: "Executor",
        role: "executor",
        state: "running",
        taskId: task.id,
        lastHeartbeatAt: new Date().toISOString(),
      } as Agent;

      render(<ActiveAgentsPanel agents={[agent]} />);

      const expectedStepName = task.steps[expectedStepNumber]?.name;
      await waitFor(() => {
        expect(
          screen.getByText(`Step ${expectedStepNumber}/${totalSteps}: ${expectedStepName}`),
        ).toBeInTheDocument();
      });
    });
  }

  it("shows 'No steps' rather than a bogus number when task.steps is empty", () => {
    const task = makeTaskDetail({ steps: [], currentStep: 0, log: [] });
    expect(getCanonicalStepNumber(task)).toEqual({ stepNumber: 0, totalSteps: 0, hasSteps: false });

    render(<TaskTokenStatsPanel loading={false} tokenUsage={undefined} task={task} />);
    expect(screen.getByText("No steps")).toBeInTheDocument();
  });
});
