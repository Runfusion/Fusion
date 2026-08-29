/*
FNXC:TaskStepNumbering 2026-07-05-00:00:
Canonical step-number convention for the dashboard. Fusion's engine, executor tool
contracts (`fn_task_update`'s `step` arg, `fn_task_log`'s implicit step context, review
verdict/request log lines such as "code review requested for Step N", and
`step-session-executor.ts`'s `createWorkflowStepActivityRun` `stepIndex`) all use a
0-based step number that is IDENTICAL to the literal `### Step N:` numbering in
PROMPT.md, where Step 0 is Preflight. `task.currentStep` and `task.steps[i]` already
live in that same 0-based index space (task.steps[0] IS the Preflight step).

Before this fix, the task-dialog indicators (`ActiveAgentsPanel`, `TaskTokenStatsPanel`)
independently added `+ 1` to `task.currentStep` to render a "1-based" step number, while
the Activity tab / workflow-step activity runs / task log lines rendered the raw 0-based
`stepIndex`/`currentStep`. That meant the SAME underlying step showed as e.g. "Step 1"
in the task dialog and "Step 0" in Activity — an off-by-one that made operators unable
to tell which step was actually running (Runfusion/Fusion#1921).

Fix: every surface that displays a step number must derive it from this single helper,
which returns the raw (PROMPT-numbered, 0-based) step index — clamped into
`[0, totalSteps - 1]` so an out-of-range `currentStep` never renders as "Step 6/5" —
instead of re-deriving its own +1/-1 math. Do NOT reintroduce a per-surface `+ 1`;
if a "1-based ordinal" is ever desired for a NEW surface, it must be computed FROM this
helper's canonical number (`+ 1` at render time, clearly labeled), never from raw
`task.currentStep` directly, so it stays traceable back to the one convention.
*/

/** Minimal shape needed to compute the canonical step-number display. */
export interface StepNumberDisplayTask {
  currentStep?: number | null;
  steps?: unknown[] | null;
}

export interface StepNumberDisplayInfo {
  /** Canonical 0-based step number (PROMPT.md convention — Step 0 is Preflight), clamped to a valid index when steps exist. */
  stepNumber: number;
  /** Total number of steps (`task.steps.length`), 0 when there are no steps. */
  totalSteps: number;
  /** False when the task has no steps at all (nothing to display). */
  hasSteps: boolean;
}

/**
 * Computes the canonical step number for display, matching the PROMPT.md /
 * engine convention (0-based, Step 0 = Preflight) used by the Activity tab,
 * workflow-step activity runs, and task log lines. Every surface that shows a
 * numeric "Step N" for a task must call this instead of doing its own math on
 * `task.currentStep`, so the number is guaranteed to agree everywhere.
 */
export function getCanonicalStepNumber(task: StepNumberDisplayTask | null | undefined): StepNumberDisplayInfo {
  const totalSteps = task?.steps?.length ?? 0;
  if (totalSteps === 0) {
    return { stepNumber: 0, totalSteps: 0, hasSteps: false };
  }
  const raw = task?.currentStep ?? 0;
  const stepNumber = Math.min(Math.max(raw, 0), totalSteps - 1);
  return { stepNumber, totalSteps, hasSteps: true };
}
