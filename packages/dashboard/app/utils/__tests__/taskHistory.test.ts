import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Task, WorkflowStepResult } from "@fusion/core";
import { buildTaskHistory, TASK_HISTORY_WORKFLOW_IDS } from "../taskHistory";
import { workflowResultBodyParts } from "../workflowResultText";

function task(overrides: Partial<Task> = {}): Task {
  return { id: "FN-208", title: "History", description: "", priority: "normal", column: "todo", currentStep: 0, steps: [], dependencies: [], log: [], createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z", ...overrides } as Task;
}

function result(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return { workflowStepId: "verification", workflowStepName: "Verification", phase: "pre-merge", status: "passed", completedAt: "2026-08-28T01:00:00.000Z", output: "Verified output", ...overrides };
}

function stageEntries(history: ReturnType<typeof buildTaskHistory>, id: string) {
  return history.find((stage) => stage.id === id)!.entries;
}

const completionSummaryTitle = {
  kind: "i18n",
  key: "taskHistory.entry.completionSummary",
  defaultValue: "Completion summary",
};

describe("buildTaskHistory", () => {
  it("always returns three empty stages for a fresh task", () => {
    expect(buildTaskHistory(task(), [])).toEqual([
      { id: "plan", entries: [] }, { id: "code", entries: [] }, { id: "review", entries: [] },
    ]);
  });

  it("projects a fully populated task into Plan, Code, and Review", () => {
    const history = buildTaskHistory(task({
      stepReports: [{ id: "code-1", stepIndex: 1, stepName: "Implement", summary: "Built it", recordedAt: "2026-08-28T02:00:00.000Z", source: "agent", attempt: 1 }],
      mergeDetails: { commitSha: "1234567890abcdef", mergedAt: "2026-08-28T04:00:00.000Z", mergeCommitMessage: "Merge history", filesChanged: 3 },
    }), [
      result({ workflowStepId: "plan-review-step", workflowStepName: "Plan Review", reviewKind: "plan", verdict: "APPROVE", completedAt: "2026-08-28T01:00:00.000Z" }),
      result({ workflowStepId: "code-review-step", workflowStepName: "Code Review", reviewKind: "code", verdict: "APPROVE", completedAt: "2026-08-28T03:00:00.000Z" }),
    ]);
    expect(history.map((stage) => [stage.id, stage.entries.length])).toEqual(["plan", "code", "review"].map((id, index) => [id, 1]));
  });

  it("restores chronological order for newest-first prior review attempts", () => {
    const current = result({
      workflowStepId: "plan-review-step", workflowStepName: "Plan Review", reviewKind: "plan", verdict: "APPROVE", completedAt: "2026-08-28T03:00:00.000Z",
      priorAttempts: [
        result({ workflowStepId: "plan-review-step", workflowStepName: "Plan Review", reviewKind: "plan", verdict: "REVISE", completedAt: "2026-08-28T02:00:00.000Z", output: "Second revision" }),
        result({ workflowStepId: "plan-review-step", workflowStepName: "Plan Review", reviewKind: "plan", verdict: "REVISE", completedAt: "2026-08-28T01:00:00.000Z", output: "First revision" }),
      ],
    });
    expect(stageEntries(buildTaskHistory(task(), [current]), "plan").map((entry) => entry.verdict)).toEqual(["REVISE", "REVISE", "APPROVE"]);
  });

  it("omits a stripped archived carrier while retaining its prior attempt", () => {
    const carrier = result({
      workflowStepId: "code-review-step", workflowStepName: "Code Review", reviewKind: "code", status: "skipped", remediationArchivedAt: "2026-08-28T03:00:00.000Z", output: undefined,
      priorAttempts: [result({ workflowStepId: "code-review-step", workflowStepName: "Code Review", reviewKind: "code", status: "failed", verdict: "REVISE", output: "Fix it" })],
    });
    const entries = stageEntries(buildTaskHistory(task(), [carrier]), "review");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe("Fix it");
  });

  it("renders a mirrored structured Plan Review report exactly once", () => {
    const REPORT = "The plan is internally consistent, scoped to both repositories, accounts for the observed no-op state, preserves fixture bytes, and defines adequate repository-specific verification.";
    const planReview = result({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      reviewKind: "plan",
      source: "optional-group",
      status: "passed",
      verdict: "APPROVE",
      output: REPORT,
      notes: REPORT,
      startedAt: "2026-08-28T12:35:00.000Z",
      completedAt: "2026-08-28T12:36:00.000Z",
    });

    expect(stageEntries(buildTaskHistory(task(), [planReview]), "plan")[0]?.body).toBe(REPORT);
  });

  it("projects post-fix verdict narration once while retaining legacy blank rows", () => {
    const notice = "The reviewer returned verdict APPROVE without a rationale; the bounded notes follow-up returned no usable text.";
    const postFixEntries = stageEntries(buildTaskHistory(task(), [result({
      workflowStepId: "code-review-step",
      workflowStepName: "Code Review",
      reviewKind: "code",
      verdict: "APPROVE",
      output: notice,
      notes: notice,
    })]), "review");
    expect(postFixEntries[0]?.body).toBe(notice);
    expect(workflowResultBodyParts(notice, notice)).toEqual([notice]);

    const legacyEntries = stageEntries(buildTaskHistory(task(), [result({ verdict: "APPROVE", output: " ", notes: " " })]), "review");
    expect(legacyEntries[0]?.body).toBeUndefined();
  });

  it("preserves genuinely different output and notes", () => {
    const entries = stageEntries(buildTaskHistory(task(), [result({ output: "Execution output", notes: "Reviewer notes" })]), "code");
    expect(entries[0]?.body).toBe("Execution output\n\nReviewer notes");
  });

  it("retains a bodyless verdict result for the component-owned fallback", () => {
    const entries = stageEntries(buildTaskHistory(task(), [result({ verdict: "APPROVE", output: " ", notes: " " })]), "review");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "passed", verdict: "APPROVE", body: undefined });
  });

  it("uses findings before the component-owned verdict fallback", () => {
    const entries = stageEntries(buildTaskHistory(task(), [result({
      verdict: "REVISE",
      output: " ",
      notes: " ",
      findings: [{ id: "finding-1", title: "Scope gap", body: "Add the missing case." }],
    })]), "review");
    expect(entries[0]?.body).toBe("**Scope gap**\n\nAdd the missing case.");
  });

  it("does not duplicate task summary when its workflow result exists", () => {
    const entries = stageEntries(buildTaskHistory(task({ summary: "Summary" }), [result({ workflowStepId: "completion-summary", workflowStepName: "Completion summary", output: "Summary" })]), "review");
    expect(entries).toHaveLength(1);
  });

  it("uses a single persisted summary when a completion workflow result has no renderable body", () => {
    const entries = stageEntries(buildTaskHistory(task({ summary: "Persisted summary" }), [result({
      workflowStepId: "completion-summary",
      workflowStepName: "Completion summary",
      output: " ",
      notes: " ",
      findings: [],
    })]), "review");

    expect(entries).toEqual([expect.objectContaining({ body: "Persisted summary", title: completionSummaryTitle })]);
  });

  it("pins a completion workflow result below a later Code Review verdict", () => {
    const history = buildTaskHistory(task(), [
      result({
        workflowStepId: "completion-summary",
        workflowStepName: "Completion summary",
        startedAt: "2026-08-28T01:00:00.000Z",
        completedAt: "2026-08-28T01:01:00.000Z",
      }),
      result({
        workflowStepId: "code-review-step",
        workflowStepName: "Code Review",
        reviewKind: "code",
        verdict: "APPROVE",
        startedAt: "2026-08-28T01:02:00.000Z",
        completedAt: "2026-08-28T01:03:00.000Z",
      }),
    ]);

    expect(stageEntries(history, "code")).toEqual([]);
    expect(stageEntries(history, "review").map((entry) => entry.title)).toEqual([
      { kind: "text", text: "Code Review" },
      completionSummaryTitle,
    ]);
  });

  it("pins the synthetic completion summary last in Review", () => {
    const history = buildTaskHistory(task({ summary: "Persisted completion" }), [
      result({ workflowStepId: "code-review-step", workflowStepName: "Code Review", reviewKind: "code", verdict: "APPROVE" }),
    ]);

    expect(stageEntries(history, "review").map((entry) => entry.id)).toEqual([
      expect.stringMatching(/^workflow:code-review-step:/),
      "task:completion-summary",
    ]);
  });

  it("projects durations only for completed workflow results", () => {
    const entries = stageEntries(buildTaskHistory(task(), [
      result({
        workflowStepId: "code-review-step",
        workflowStepName: "Code Review",
        reviewKind: "code",
        startedAt: "2026-08-28T01:00:00.000Z",
        completedAt: "2026-08-28T01:00:03.500Z",
      }),
      result({
        workflowStepId: "browser-verification-step",
        workflowStepName: "Browser verification",
        reviewKind: "code",
        startedAt: "2026-08-28T01:05:00.000Z",
        completedAt: undefined,
      }),
    ]), "review");

    expect(entries.find((entry) => entry.title.kind === "text" && entry.title.text === "Code Review")?.durationMs).toBe(3_500);
    expect(entries.find((entry) => entry.title.kind === "text" && entry.title.text === "Browser verification")?.durationMs).toBeUndefined();
  });

  it("projects a step report duration from its durable transition log", () => {
    const history = buildTaskHistory(task({
      stepReports: [{ id: "report-1", stepIndex: 0, stepName: "Preflight", summary: "Ready", recordedAt: "2026-08-28T02:00:15.000Z", source: "agent", attempt: 1 }],
      log: [
        { timestamp: "2026-08-28T02:00:00.000Z", action: "Step 0 (Preflight) → in-progress" },
        { timestamp: "2026-08-28T02:00:15.000Z", action: "Step 0 (Preflight) → done" },
      ],
    }), []);

    expect(stageEntries(history, "code")[0]?.durationMs).toBe(15_000);
  });

  it("places post-merge completion results in Review", () => {
    const history = buildTaskHistory(task(), [
      result({ workflowStepId: "completion-summary", workflowStepName: "Completion summary", phase: "post-merge" }),
    ]);

    expect(stageEntries(history, "review")).toHaveLength(1);
    expect(history.map((stage) => stage.id)).not.toContain("merge");
  });

  it("does not synthesize history entries from landed commit metadata", () => {
    const history = buildTaskHistory(task({
      mergeDetails: { commitSha: "1234567890abcdef", mergedAt: "2026-08-28T04:00:00.000Z", mergeTargetBranch: "main" },
    }), []);

    expect(history.flatMap((stage) => stage.entries)).toEqual([]);
    expect(history.map((stage) => stage.id)).not.toContain("merge");
  });

  it("classifies post-merge workflow output as Review", () => {
    const history = buildTaskHistory(task(), [result({ workflowStepId: "post-audit", workflowStepName: "Post merge audit", phase: "post-merge", verdict: "APPROVE" })]);
    expect(stageEntries(history, "review")).toHaveLength(1);
    expect(history.map((stage) => stage.id)).not.toContain("merge");
  });

  it("projects an approved documentation-delivery report once without an approval state", () => {
    const REPORT = "Both repositories now contain the requested empty file.";
    const history = buildTaskHistory(task({ summary: REPORT }), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      verdict: "APPROVE",
      status: "passed",
      output: REPORT,
      startedAt: "2026-08-28T13:53:53.000Z",
      completedAt: "2026-08-28T13:54:19.500Z",
    })]);

    expect(stageEntries(history, "code")).toEqual([]);
    const [entry] = stageEntries(history, "review");
    expect(entry).toMatchObject({ title: completionSummaryTitle, body: REPORT, durationMs: 26_500 });
    expect(entry?.verdict).toBeUndefined();
    expect(entry?.status).toBeUndefined();
  });

  it("projects a documentation-delivery report into Review without a parsed verdict", () => {
    const REPORT = "Documentation report without a verdict.";
    const history = buildTaskHistory(task({ summary: REPORT }), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      verdict: undefined,
      status: "passed",
      output: REPORT,
    })]);

    expect(stageEntries(history, "code")).toEqual([]);
    const [entry] = stageEntries(history, "review");
    expect(entry).toMatchObject({ title: completionSummaryTitle, body: REPORT });
    expect(entry?.verdict).toBeUndefined();
    expect(entry?.status).toBeUndefined();
  });

  it("treats the documentation-delivery inner step as a summary projection", () => {
    const REPORT = "Inner documentation report.";
    const entries = stageEntries(buildTaskHistory(task({ summary: REPORT }), [result({
      workflowStepId: "documentation-delivery-step",
      workflowStepName: "Documentation",
      verdict: "APPROVE",
      output: REPORT,
    })]), "review");

    expect(entries).toEqual([expect.objectContaining({ title: completionSummaryTitle, body: REPORT })]);
    expect(entries[0]?.verdict).toBeUndefined();
    expect(entries[0]?.status).toBeUndefined();
  });

  it("uses a synthetic completion summary when no summary-projection result exists", () => {
    const entries = stageEntries(buildTaskHistory(task({ summary: "Persisted completion" }), [
      result({ workflowStepId: "code-review-step", workflowStepName: "Code Review", reviewKind: "code", verdict: "APPROVE" }),
    ]), "review");

    expect(entries.at(-1)).toMatchObject({ id: "task:completion-summary", title: completionSummaryTitle, body: "Persisted completion" });
  });

  it("suppresses a stripped archived summary carrier and retains a synthetic persisted summary", () => {
    const entries = stageEntries(buildTaskHistory(task({ summary: "Persisted completion" }), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      remediationArchivedAt: "2026-08-28T02:00:00.000Z",
      output: undefined,
      notes: undefined,
      verdict: undefined,
      findings: [],
    })]), "review");

    expect(entries).toEqual([expect.objectContaining({ id: "task:completion-summary", body: "Persisted completion" })]);
  });

  it("keeps all summary-projection attempts and applies the persisted summary only to the last", () => {
    const summary = "Persisted completion";
    const entries = stageEntries(buildTaskHistory(task({ summary }), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      output: "Latest raw report",
      completedAt: "2026-08-28T03:00:00.000Z",
      priorAttempts: [
        result({ workflowStepId: "documentation-delivery", workflowStepName: "Documentation", output: "Middle raw report", completedAt: "2026-08-28T02:00:00.000Z" }),
        result({ workflowStepId: "documentation-delivery", workflowStepName: "Documentation", output: "First raw report", completedAt: "2026-08-28T01:00:00.000Z" }),
      ],
    })]), "review");

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => [entry.body, entry.verdict, entry.status])).toEqual([
      ["First raw report", undefined, undefined],
      ["Middle raw report", undefined, undefined],
      [summary, undefined, undefined],
    ]);
  });

  it("retains a bodyless summary projection for the generic no-body fallback", () => {
    const entries = stageEntries(buildTaskHistory(task(), [result({
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      verdict: "APPROVE",
      output: " ",
      notes: " ",
    })]), "review");

    expect(entries).toEqual([expect.objectContaining({ body: undefined })]);
    expect(entries[0]?.verdict).toBeUndefined();
    expect(entries[0]?.status).toBeUndefined();
  });

  it("keeps local workflow identity literals aligned with core built-ins", () => {
    const testModuleUrl = pathToFileURL(__filename);
    const sources = [
      fileURLToPath(new URL("../../../../core/src/workflows/builtin-plan-review-group.ts", testModuleUrl)),
      fileURLToPath(new URL("../../../../core/src/workflows/builtin-code-review-group.ts", testModuleUrl)),
      fileURLToPath(new URL("../../../../core/src/workflows/builtin-browser-verification-group.ts", testModuleUrl)),
      fileURLToPath(new URL("../../../../core/src/workflows/builtin-completion-summary-node.ts", testModuleUrl)),
      fileURLToPath(new URL("../../../../core/src/workflows/builtin-documentation-delivery-group.ts", testModuleUrl)),
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    for (const value of Object.values(TASK_HISTORY_WORKFLOW_IDS)) expect(sources).toContain(`= "${value}"`);
  });

  it("emits only task-sourced text or taskHistory i18n descriptors", () => {
    const fixtureValues = new Set(["Plan Review", "Code Review"]);
    const history = buildTaskHistory(task({
      stepReports: [{ id: "r", stepIndex: 1, stepName: "Implement", summary: "Built", recordedAt: "2026-08-28T02:00:00.000Z", source: "agent", attempt: 1 }],
      mergeDetails: { commitSha: "abcdef123456", mergedAt: "2026-08-28T04:00:00.000Z", mergeTargetBranch: "main" },
    }), [result({ workflowStepId: "plan-review", workflowStepName: "Plan Review", reviewKind: "plan" }), result({ workflowStepId: "code-review", workflowStepName: "Code Review", reviewKind: "code" })]);
    const labels = history.flatMap((stage) => stage.entries.flatMap((entry) => [entry.title, ...(entry.meta ?? []).map((item) => item.label)]));
    for (const label of labels) {
      if (label.kind === "text") expect(fixtureValues).toContain(label.text);
      else expect(label.key).toMatch(/^taskHistory\./);
    }
  });
});
