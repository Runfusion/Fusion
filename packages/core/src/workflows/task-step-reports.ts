import { randomUUID } from "node:crypto";
import type { TaskStepReport } from "../types.js";

export const MAX_TASK_STEP_REPORTS = 200;
export const MAX_TASK_STEP_REPORT_SUMMARY_CHARS = 4_000;

export interface AppendTaskStepReportInput {
  stepIndex: number;
  stepName: string;
  summary: string;
  recordedAt?: string;
  id?: string;
}

/**
 * Appends one bounded report while preserving existing ledger identity on no-op writes.
 */
export function appendTaskStepReport(
  existing: TaskStepReport[] | undefined,
  input: AppendTaskStepReportInput,
): TaskStepReport[] | undefined {
  const trimmed = input.summary.trim();
  if (!trimmed) return existing;

  const reports = existing ?? [];
  const latestForStep = [...reports].reverse().find((report) => report.stepIndex === input.stepIndex);
  if (latestForStep?.summary === trimmed) return existing;

  const summary = trimmed.length > MAX_TASK_STEP_REPORT_SUMMARY_CHARS
    ? `${trimmed.slice(0, MAX_TASK_STEP_REPORT_SUMMARY_CHARS - 1)}…`
    : trimmed;
  const attempt = reports.reduce(
    (count, report) => count + (report.stepIndex === input.stepIndex ? 1 : 0),
    0,
  ) + 1;
  const next: TaskStepReport[] = [
    ...reports,
    {
      id: input.id ?? randomUUID(),
      stepIndex: input.stepIndex,
      stepName: input.stepName,
      summary,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      source: "agent",
      attempt,
    },
  ];
  return next.slice(-MAX_TASK_STEP_REPORTS);
}
