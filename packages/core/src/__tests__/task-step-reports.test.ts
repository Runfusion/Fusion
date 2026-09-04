import { describe, expect, it } from "vitest";
import {
  MAX_TASK_STEP_REPORTS,
  MAX_TASK_STEP_REPORT_SUMMARY_CHARS,
  appendTaskStepReport,
} from "../workflows/task-step-reports.js";
import { TASK_COLUMN_DESCRIPTOR_BY_COLUMN } from "../task-store/persistence.js";
import { rowToTask } from "../task-store/serialization.js";
import { updateStepImpl } from "../task-store/merge-queue-ops.js";
import type { Task, TaskStepReport } from "../types.js";
import type { TaskRow } from "../task-store/persistence.js";
import type { TaskStore } from "../store.js";

function input(stepIndex: number, summary: string, id = `report-${stepIndex}`) {
  return { stepIndex, stepName: `Step ${stepIndex}`, summary, id, recordedAt: `2026-08-28T00:00:0${stepIndex % 10}.000Z` };
}

function taskFixture(stepReports?: TaskStepReport[]): Task {
  return {
    id: "FN-208",
    title: "History",
    description: "",
    priority: "normal",
    column: "todo",
    currentStep: 0,
    steps: [],
    dependencies: [],
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    stepReports,
  } as Task;
}

function rowFixture(stepReports: string | null): TaskRow {
  return {
    id: "FN-208",
    lineageId: null,
    title: "History",
    description: "",
    priority: "normal",
    column: "todo",
    status: null,
    currentStep: 0,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    dependencies: "[]",
    steps: "[]",
    stepReports,
    log: "[]",
  } as TaskRow;
}

describe("appendTaskStepReport", () => {
  it("returns the original ledger for blank summaries", () => {
    const existing = [appendTaskStepReport(undefined, input(0, "kept"))![0]!];
    expect(appendTaskStepReport(existing, input(0, "  \n  "))).toBe(existing);
  });

  it("truncates summaries at the character cap with an ellipsis", () => {
    const report = appendTaskStepReport(undefined, input(0, "x".repeat(MAX_TASK_STEP_REPORT_SUMMARY_CHARS + 10)))![0]!;
    expect(report.summary).toHaveLength(MAX_TASK_STEP_REPORT_SUMMARY_CHARS);
    expect(report.summary.endsWith("…")).toBe(true);
  });

  it("increments attempts independently per step", () => {
    let reports = appendTaskStepReport(undefined, input(0, "first", "a"));
    reports = appendTaskStepReport(reports, input(1, "other", "b"));
    reports = appendTaskStepReport(reports, input(0, "second", "c"));
    expect(reports?.map((report) => report.attempt)).toEqual([1, 1, 2]);
  });

  it("drops the oldest report above the ledger cap", () => {
    let reports: TaskStepReport[] | undefined;
    for (let index = 0; index <= MAX_TASK_STEP_REPORTS; index += 1) {
      reports = appendTaskStepReport(reports, input(index, `summary-${index}`, `id-${index}`));
    }
    expect(reports).toHaveLength(MAX_TASK_STEP_REPORTS);
    expect(reports?.[0]?.id).toBe("id-1");
  });

  it("deduplicates an identical latest summary for the same step", () => {
    const existing = appendTaskStepReport(undefined, input(0, "same", "first"));
    expect(appendTaskStepReport(existing, input(0, " same ", "second"))).toBe(existing);
  });
});

function stepStore(initial: Task) {
  let task = structuredClone(initial);
  const store = {
    isWatching: false,
    taskCache: new Map(),
    taskDir: () => "/virtual/FN-208",
    readTaskJson: async () => structuredClone(task),
    parseStepsFromPrompt: async () => task.steps,
    atomicWriteTaskJson: async (_dir: string, next: Task) => { task = structuredClone(next); },
    withTaskLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    emit: () => true,
    getSettingsFast: async () => ({ proactiveTaskChatEnabled: false }),
    appendAgentLog: async () => undefined,
  } as unknown as TaskStore;
  return { store, read: () => structuredClone(task) };
}

function taskWithSteps(): Task {
  return {
    ...taskFixture(),
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement history", status: "in-progress" },
      { name: "Verify", status: "pending" },
    ],
    currentStep: 1,
  };
}

describe("task step report persistence", () => {
  it("round-trips reports through the descriptor and row hydrator", () => {
    const reports = appendTaskStepReport(undefined, input(0, "Delivered history", "stable"))!;
    const descriptor = TASK_COLUMN_DESCRIPTOR_BY_COLUMN.get("stepReports")!;
    const serialized = descriptor.serialize(taskFixture(reports), { lineageId: "lineage" });
    expect(rowToTask(rowFixture(serialized as string)).stepReports).toEqual(reports);
    expect(rowToTask(rowFixture("[]")).stepReports).toBeUndefined();
  });

  it("records a done summary with the live step name", async () => {
    const fixture = stepStore(taskWithSteps());
    await updateStepImpl(fixture.store, "FN-208", 1, "done", { summary: "Added the History tab." });
    expect(fixture.read().stepReports).toMatchObject([
      { stepIndex: 1, stepName: "Implement history", summary: "Added the History tab.", attempt: 1 },
    ]);
  });

  it("does not record reports without a done summary", async () => {
    for (const [status, summary] of [["done", undefined], ["in-progress", "starting"], ["skipped", "not needed"]] as const) {
      const fixture = stepStore(taskWithSteps());
      await updateStepImpl(fixture.store, "FN-208", 1, status, summary ? { summary } : undefined);
      expect(fixture.read().stepReports).toBeUndefined();
    }
  });

  it("does not record a dependency-suppressed completion", async () => {
    const task = taskWithSteps();
    task.steps[0]!.status = "pending";
    const fixture = stepStore(task);
    await updateStepImpl(fixture.store, "FN-208", 1, "done", { summary: "Should not land" });
    expect(fixture.read().stepReports).toBeUndefined();
    expect(fixture.read().steps[1]?.status).toBe("in-progress");
  });

  it("deduplicates repeated done reports and increments changed attempts", async () => {
    const fixture = stepStore(taskWithSteps());
    await updateStepImpl(fixture.store, "FN-208", 1, "done", { summary: "First delivery" });
    await updateStepImpl(fixture.store, "FN-208", 1, "done", { summary: "First delivery" });
    await updateStepImpl(fixture.store, "FN-208", 1, "done", { summary: "Second delivery" });
    expect(fixture.read().stepReports?.map(({ summary, attempt }) => ({ summary, attempt }))).toEqual([
      { summary: "First delivery", attempt: 1 },
      { summary: "Second delivery", attempt: 2 },
    ]);
  });
});
