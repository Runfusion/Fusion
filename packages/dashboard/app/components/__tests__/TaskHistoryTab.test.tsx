import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import realEnApp from "../../../../i18n/locales/en/app.json";
import { TaskHistoryTab } from "../TaskHistoryTab";

const originalInnerWidth = window.innerWidth;
const REVIEW_NO_NOTES_NOTICE = "The reviewer returned verdict APPROVE without a rationale; the bounded notes follow-up returned no usable text.";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { id: "FN-208", title: "History", description: "", priority: "normal", column: "todo", currentStep: 0, steps: [], dependencies: [], log: [], prompt: "# History", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z", ...overrides } as TaskDetail;
}

function result(overrides: Partial<WorkflowStepResult>): WorkflowStepResult {
  return { workflowStepId: "code-review-step", workflowStepName: "Code Review", phase: "pre-merge", reviewKind: "code", status: "passed", ...overrides };
}

async function renderHistory(taskValue = task(), results: WorkflowStepResult[] = [], resources: Record<string, unknown> = realEnApp) {
  const i18n = createInstance().use(initReactI18next);
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { app: resources } }, interpolation: { escapeValue: false } });
  return render(<I18nextProvider i18n={i18n}><TaskHistoryTab task={taskValue} results={results} /></I18nextProvider>);
}

afterEach(() => {
  window.innerWidth = originalInnerWidth;
});

describe("TaskHistoryTab", () => {
  it("renders Plan, Code, and Review sections and counts immediately", async () => {
    await renderHistory();
    for (const id of ["plan", "code", "review"]) {
      expect(screen.getByTestId(`task-history-stage-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`task-history-count-${id}`)).toHaveTextContent("0");
    }
    expect(screen.queryByTestId("task-history-stage-merge")).not.toBeInTheDocument();
  });

  it("shows every stage-specific empty state without interaction", async () => {
    await renderHistory();
    expect(screen.getByText(/No planning reports recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No implementation summaries recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No review reports recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/No merge reports recorded/)).not.toBeInTheDocument();
  });

  it("shows review attempts chronologically with dates and markdown", async () => {
    await renderHistory(task(), [result({ verdict: "APPROVE", output: "**Approved** body", completedAt: "2026-08-28T03:00:00.000Z", priorAttempts: [result({ status: "failed", verdict: "REVISE", output: "Revise body", completedAt: "2026-08-28T01:00:00.000Z" })] })]);
    expect(screen.getByTestId("task-history-count-review")).toHaveTextContent("2");
    expect(screen.getByText("Revise body")).toBeInTheDocument();
    expect(screen.getByText("Approved", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Code Review", level: 5 })).toHaveLength(2);
    expect(screen.getAllByRole("time")).toHaveLength(2);
  });

  it("renders a completed workflow duration beside its timestamp", async () => {
    await renderHistory(task(), [result({
      startedAt: "2026-08-28T03:00:00.000Z",
      completedAt: "2026-08-28T03:00:02.500Z",
    })]);

    expect(screen.getByTestId("task-history-entry-duration")).toHaveTextContent("Took 2.5 s");
    expect(screen.getByRole("time")).toBeInTheDocument();
  });

  it("omits the timing wrapper for an untimed report", async () => {
    const rendered = await renderHistory(task(), [result({ output: "Untimed review" })]);

    expect(screen.queryByTestId("task-history-entry-duration")).not.toBeInTheDocument();
    expect(rendered.container.querySelector(".task-history-entry-timing")).toBeNull();
  });

  it("renders a step-report duration from matching task-log transitions", async () => {
    await renderHistory(task({
      stepReports: [{ id: "step-0", stepIndex: 0, stepName: "Preflight", summary: "Ready", recordedAt: "2026-08-28T03:00:15.000Z", source: "agent", attempt: 1 }],
      log: [
        { timestamp: "2026-08-28T03:00:00.000Z", action: "Step 0 (Preflight) → in-progress" },
        { timestamp: "2026-08-28T03:00:15.000Z", action: "Step 0 (Preflight) → done" },
      ],
    }));

    expect(screen.getByTestId("task-history-entry-duration")).toHaveTextContent("Took 15.0 s");
  });

  it("keeps durations visible at the narrow breakpoint", async () => {
    window.innerWidth = 375;
    await renderHistory(task(), [result({
      startedAt: "2026-08-28T03:00:00.000Z",
      completedAt: "2026-08-28T03:00:02.500Z",
    })]);

    expect(screen.getByTestId("task-history-entry-duration")).toHaveTextContent("Took 2.5 s");
  });

  it("updates the Code count when step reports arrive", async () => {
    const rendered = await renderHistory(task());
    expect(screen.getByTestId("task-history-count-code")).toHaveTextContent("0");
    rendered.rerender(<TaskHistoryTab task={task({ stepReports: [{ id: "one", stepIndex: 1, stepName: "Build", summary: "Built it", recordedAt: "2026-08-28T02:00:00.000Z", source: "agent", attempt: 1 }] })} results={[]} />);
    expect(screen.getByTestId("task-history-count-code")).toHaveTextContent("1");
  });

  it("uses the Code empty state when no step summary exists", async () => {
    await renderHistory(task({ steps: [{ name: "Completed without report", status: "done" }] }));
    expect(screen.getByText(/Summaries appear when implementation steps report/)).toBeInTheDocument();
  });

  it("keeps narrow static stage headings and counts visible", async () => {
    window.innerWidth = 375;
    await renderHistory();
    const section = screen.getByTestId("task-history-stage-plan");
    expect(within(section).getByRole("heading", { name: "Plan", level: 4 })).toHaveClass("task-history-stage-title");
    expect(within(section).getByTestId("task-history-count-plan")).toHaveTextContent("0");
  });

  it("has no accordion button or aria-expanded affordance", async () => {
    await renderHistory();
    const panel = screen.getByTestId("task-history-tab");
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(panel.querySelector("[aria-expanded]")).not.toBeInTheDocument();
  });

  it("renders a mirrored structured Plan Review report exactly once", async () => {
    const REPORT = "The plan is internally consistent, scoped to both repositories, accounts for the observed no-op state, preserves fixture bytes, and defines adequate repository-specific verification.";
    await renderHistory(task(), [result({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      reviewKind: "plan",
      source: "optional-group",
      verdict: "APPROVE",
      output: REPORT,
      notes: REPORT,
      startedAt: "2026-08-28T12:35:00.000Z",
      completedAt: "2026-08-28T12:36:00.000Z",
    })]);
    expect(screen.getAllByText(REPORT)).toHaveLength(1);
    expect(screen.queryByTestId("task-history-entry-no-notes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-history-entry-no-body")).not.toBeInTheDocument();
  });

  it.each([
    ["desktop", originalInnerWidth],
    ["mobile", 375],
  ])("renders post-fix reviewer narration without fallback copy at %s width", async (_viewport, width) => {
    window.innerWidth = width;
    await renderHistory(task(), [result({
      verdict: "APPROVE",
      output: REVIEW_NO_NOTES_NOTICE,
      notes: REVIEW_NO_NOTES_NOTICE,
    })]);
    expect(screen.getAllByText(REVIEW_NO_NOTES_NOTICE)).toHaveLength(1);
    expect(screen.queryByTestId("task-history-entry-no-notes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-history-entry-no-body")).not.toBeInTheDocument();
  });

  it("shows explicit no-notes copy for a legacy Plan Review verdict", async () => {
    await renderHistory(task(), [result({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      reviewKind: "plan",
      verdict: "APPROVE",
      output: "",
      notes: "",
      completedAt: "2026-08-28T22:16:38.000Z",
    })]);
    expect(screen.getByTestId("task-history-entry-no-notes")).toHaveTextContent("The reviewer recorded no notes for this verdict.");
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByRole("time")).toHaveAttribute("dateTime", "2026-08-28T22:16:38.000Z");
    expect(screen.queryByText("No report body was recorded.")).not.toBeInTheDocument();
  });

  it("shows the same verdict-aware fallback at the narrow breakpoint", async () => {
    window.innerWidth = 375;
    await renderHistory(task(), [result({ verdict: "APPROVE", output: "", notes: "" })]);
    expect(screen.getByTestId("task-history-entry-no-notes")).toBeInTheDocument();
    expect(screen.queryByTestId("task-history-entry-no-body")).not.toBeInTheDocument();
  });

  it("renders a mirrored workspace aggregate once without fallback copy", async () => {
    const aggregate = "### [repo-a] APPROVE\nRepository A is correct.\n\n### [repo-b] APPROVE\nRepository B is correct.";
    await renderHistory(task(), [result({ verdict: "APPROVE", output: aggregate, notes: aggregate })]);
    expect(screen.getAllByText(/Repository A is correct/)).toHaveLength(1);
    expect(screen.getAllByText(/Repository B is correct/)).toHaveLength(1);
    expect(screen.queryByTestId("task-history-entry-no-notes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-history-entry-no-body")).not.toBeInTheDocument();
  });

  it("keeps generic missing-body copy for non-verdict reports", async () => {
    await renderHistory(task({
      stepReports: [{ id: "empty", stepIndex: 1, stepName: "Build", summary: "", recordedAt: "2026-08-28T02:00:00.000Z", source: "agent", attempt: 1 }],
      mergeDetails: { commitSha: "abcdef", mergedAt: "2026-08-28T04:00:00.000Z" },
    }));
    expect(screen.getAllByTestId("task-history-entry-no-body")).toHaveLength(1);
    expect(screen.queryByTestId("task-history-entry-no-notes")).not.toBeInTheDocument();
  });

  it.each([
    ["desktop", originalInnerWidth],
    ["mobile", 375],
  ])("renders one unbadged completion summary without a Merge stage at %s width", async (_viewport, width) => {
    const REPORT = "Both repositories now contain a root-level empty bonjour.txt file.";
    window.innerWidth = width;
    await renderHistory(task({ summary: REPORT }), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      verdict: "APPROVE",
      status: "passed",
      output: REPORT,
      startedAt: "2026-08-28T13:53:53.000Z",
      completedAt: "2026-08-28T13:54:19.500Z",
    })]);

    const reviewStage = screen.getByTestId("task-history-stage-review");
    const completionHeading = within(reviewStage).getByRole("heading", { name: "Completion summary", level: 5 });
    const completionEntry = completionHeading.closest("article");
    expect(screen.getAllByText(REPORT)).toHaveLength(1);
    expect(screen.queryByText("Documentation")).not.toBeInTheDocument();
    expect(within(reviewStage).getAllByRole("heading", { level: 5, name: "Completion summary" })).toHaveLength(1);
    expect(completionEntry?.querySelectorAll(".workflow-result-badge")).toHaveLength(0);
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-history-entry-duration")).toHaveTextContent("Took 26.5 s");
    expect(screen.getByTestId("task-history-count-review")).toHaveTextContent("1");
    expect(screen.getByTestId("task-history-count-code")).toHaveTextContent("0");
    expect(screen.queryByTestId("task-history-stage-merge")).not.toBeInTheDocument();
    expect(screen.queryByText(/No merge reports recorded/)).not.toBeInTheDocument();
  });

  it("keeps a Code Review badge while leaving the completion summary unbadged", async () => {
    await renderHistory(task({ summary: "Documentation report" }), [
      result({ workflowStepId: "code-review-step", workflowStepName: "Code Review", verdict: "APPROVE", output: "Code review report" }),
      result({ workflowStepId: "documentation-delivery", workflowStepName: "Documentation", verdict: "APPROVE", output: "Documentation report" }),
    ]);

    const reviewStage = screen.getByTestId("task-history-stage-review");
    const completionHeading = within(reviewStage).getByRole("heading", { name: "Completion summary", level: 5 });
    const codeReviewHeading = within(reviewStage).getByRole("heading", { name: "Code Review", level: 5 });
    expect(reviewStage.querySelectorAll(".workflow-result-badge")).toHaveLength(1);
    expect(codeReviewHeading.closest("article")?.querySelector(".workflow-result-badge")).toHaveTextContent("Approved");
    expect(completionHeading.closest("article")?.querySelector(".workflow-result-badge")).toBeNull();
  });

  it("uses generic no-body copy for a bodyless summary projection", async () => {
    await renderHistory(task(), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      verdict: "APPROVE",
      output: "",
      notes: "",
    })]);

    expect(screen.getByTestId("task-history-entry-no-body")).toBeInTheDocument();
    expect(screen.queryByTestId("task-history-entry-no-notes")).not.toBeInTheDocument();
  });

  it("renders stage and body fallbacks through localization keys", async () => {
    const resources = structuredClone(realEnApp) as typeof realEnApp;
    resources.taskHistory.stage.plan = "PLAN_SENTINEL";
    resources.taskHistory.entry.noBody = "NO_BODY_SENTINEL";
    resources.taskHistory.entry.verdictNoNotes = "NO_NOTES_SENTINEL";
    resources.taskHistory.entry.duration = "DURATION_SENTINEL {{duration}}";
    await renderHistory(task({
      stepReports: [{ id: "empty", stepIndex: 1, stepName: "Build", summary: "", recordedAt: "2026-08-28T02:00:00.000Z", source: "agent", attempt: 1 }],
      mergeDetails: { commitSha: "abcdef", mergedAt: "2026-08-28T04:00:00.000Z" },
    }), [result({ verdict: "APPROVE", output: "", notes: "", startedAt: "2026-08-28T03:00:00.000Z", completedAt: "2026-08-28T03:00:01.000Z" })], resources);
    expect(screen.getByText("PLAN_SENTINEL")).toBeInTheDocument();
    expect(screen.getAllByText("NO_BODY_SENTINEL")).toHaveLength(1);
    expect(screen.getByText("NO_NOTES_SENTINEL")).toBeInTheDocument();
    expect(screen.getByText("DURATION_SENTINEL 1.0 s")).toBeInTheDocument();
  });
});
