/*
FNXC:Quality 2026-07-14-21:45:
TestRun/TestPlan domain for the Quality plugin. Status enums match the plan lifecycle;
duration fields support the hub/task report viewer without inventing client-side timing.
*/

export type TestRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "error";

export type TestRunSource = "hub" | "task-tab" | "workflow" | "agent-qa";

export type CwdKind = "project-root" | "worktree" | "qa-worktree";

export type QualityPresetId =
  | "project-test"
  | "test-gate"
  | "verify-fast"
  | "file-scoped"
  | "full-suite";

export type TestPlanStatus = "draft" | "active" | "archived";

export interface TestRun {
  id: string;
  projectId: string;
  taskId?: string;
  planId?: string;
  source: TestRunSource;
  presetId?: QualityPresetId;
  command: string;
  cwd: string;
  cwdKind: CwdKind;
  status: TestRunStatus;
  exitCode?: number;
  errorMessage?: string;
  timeoutMs: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stdout: string;
  stderr: string;
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestPlan {
  id: string;
  projectId: string;
  name: string;
  status: TestPlanStatus;
  /** Ordered allowlisted preset ids only */
  steps: QualityPresetId[];
  createdAt: string;
  updatedAt: string;
}

export interface SuggestedCase {
  id: string;
  text: string;
  done: boolean;
  source: "heuristic" | "ai" | "manual";
}

export interface SuggestedCasesSnapshot {
  projectId: string;
  taskId: string;
  cases: SuggestedCase[];
  generatedAt: string;
  method: "heuristic" | "ai" | "mixed";
}

export interface CreateTestRunInput {
  projectId: string;
  taskId?: string;
  planId?: string;
  source: TestRunSource;
  presetId?: QualityPresetId;
  command: string;
  cwd: string;
  cwdKind: CwdKind;
  timeoutMs: number;
  triggeredBy: string;
}

export interface CreateTestPlanInput {
  projectId: string;
  name: string;
  steps: QualityPresetId[];
  status?: TestPlanStatus;
}
