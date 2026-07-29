/**
 * Spec Staleness Evaluator
 *
 * Evaluates whether a task's PROMPT.md has become stale based on file modification time.
 * When spec staleness enforcement is enabled, tasks whose specification age exceeds
 * the configured threshold must be re-planned before execution.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Settings, Task } from "@fusion/core";

/** Default maximum age for a specification before it is considered stale (6 hours in ms). */
const DEFAULT_SPEC_STALENESS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Result of a spec staleness evaluation.
 *
 * When `skipped` is true, the evaluation could not determine staleness due to
 * missing/unreadable files, and callers should fall back to existing filesystem
 * validation logic without throwing.
 */
export interface SpecStalenessResult {
  /** Whether the specification is considered stale and requires re-planning. */
  isStale: boolean;
  /** Age of the PROMPT.md in milliseconds at evaluation time. Undefined when skipped. */
  ageMs: number | undefined;
  /** Maximum allowed age in milliseconds. Undefined when skipped. */
  maxAgeMs: number | undefined;
  /** Human-readable reason for the decision. Empty string when skipped. */
  reason: string;
  /**
   * Whether evaluation was skipped due to missing/unreadable PROMPT.md.
   * When true, `isStale` is always false and callers should not stale-reroute.
   */
  skipped: boolean;
}

/**
 * Input options for spec staleness evaluation.
 */
export interface EvaluateSpecStalenessOptions {
  /** Merged project settings containing staleness configuration. */
  settings: Settings;
  /** Absolute path to the task's PROMPT.md file. */
  promptPath: string;
  /**
   * Optional current timestamp in milliseconds (for deterministic testing).
   * Defaults to `Date.now()` when not provided.
   */
  nowMs?: number;
  /**
   * FNXC:SpecStalenessPostU11 2026-07-29-18:25 (U11 #2515 audit):
   * The task's own planner lane. Callers that can resolve the workflow pass it so
   * the preserved-progress exemption keys on the ROLE; omitting it keeps the legacy
   * intake id and today's behavior exactly.
   */
  plannerLane?: SpecStalenessPlannerLane;
  /**
   * Optional task metadata. When provided, evaluation skips already-started,
   * parked work so preserved progress is not sent back through triage solely
   * because the original PROMPT.md mtime exceeded the staleness threshold.
   */
  task?: Pick<Task, "id" | "column" | "status" | "currentStep" | "steps" | "pausedReason">;
}

/**
 * Evaluate whether a task's specification (PROMPT.md) is stale.
 *
 * ## Configuration
 *
 * - `specStalenessEnabled`: When `true`, enforces staleness checking.
 *   When `false`/`undefined`, always returns `isStale: false` with no file access.
 *
 * - `specStalenessMaxAgeMs`: Maximum age in milliseconds before a spec is stale.
 *   Defaults to `6 * 60 * 60 * 1000` (6 hours) when not set or invalid.
 *
 * ## Staleness Logic
 *
 * A spec is stale when `ageMs > maxAgeMs`.
 * The boundary condition `ageMs === maxAgeMs` is NOT stale (exclusive comparison).
 *
 * ## Skipped Behavior
 *
 * When PROMPT.md cannot be read (missing, unreadable, or stat fails):
 * - Returns `skipped: true`, `isStale: false`
 * - Does NOT throw — callers should fall back to existing filesystem validation
 * - This ensures missing-file semantics remain authoritative in the scheduler/executor
 *
 * ## Disabled Behavior
 *
 * When `specStalenessEnabled !== true`:
 * - Returns immediately with `isStale: false`, `skipped: false`, empty reason
 * - No file system access is performed
 *
 * @param options - Evaluation options including settings and PROMPT.md path
 * @returns Spec staleness decision with staleness flag, metrics, and skip indicator
 */
/**
 * FNXC:SpecStalenessPostU11 2026-07-29-18:10 (U11 #2515 audit):
 * The planner lane, injected. This function is PURE and SYNCHRONOUS — one caller
 * invokes it inside a scheduler filter — so it cannot resolve an IR itself.
 * Defaults to the legacy intake id, which keeps every existing caller
 * byte-identical.
 */
export interface SpecStalenessPlannerLane {
  intake: string;
}

const LEGACY_SPEC_STALENESS_LANE: SpecStalenessPlannerLane = { intake: "triage" };

export function shouldSkipSpecStalenessForPreservedProgress(
  task: EvaluateSpecStalenessOptions["task"] | undefined,
  plannerLane: SpecStalenessPlannerLane = LEGACY_SPEC_STALENESS_LANE,
): boolean {
  /*
  FNXC:SpecStalenessPostU11 2026-07-29-18:10 (U11 #2515 audit):
  A card resting in the PLANNER LANE never earns the preserved-progress exemption —
  its leftover steps belong to a previous planning pass, so its spec is exactly what
  needs re-checking. Keyed on the literal `triage`, that clause stopped matching when
  #2515 removed the column from the default lineage, and a card in the merged
  Planning column with leftover steps and no planning-stage status was EXEMPTED from
  staleness evaluation entirely: the scheduler's stale-spec rebound never fired and
  the card could be dispatched against a superseded spec.

  Not exotic — finalize clears `status` to null after the handoff while the previous
  pass's steps remain on the row. That is the FN-8596 shape.

  The two STATUS conditions are untouched on purpose: `needs-replan` and `planning`
  are statuses, not columns, and U11 moved a column.
  */
  if (!task || task.column === plannerLane.intake || task.status === "needs-replan" || task.status === "planning") {
    return false;
  }
  if ((task.currentStep ?? 0) > 0) {
    return true;
  }
  return !!task.steps?.some((step) => step.status === "done" || step.status === "in-progress");
}

export async function evaluateSpecStaleness(
  options: EvaluateSpecStalenessOptions,
): Promise<SpecStalenessResult> {
  const { settings, promptPath, nowMs, task } = options;

  // Disabled mode: strict no-op — no file access
  if (settings.specStalenessEnabled !== true) {
    return {
      isStale: false,
      ageMs: undefined,
      maxAgeMs: undefined,
      reason: "",
      skipped: false,
    };
  }

  if (shouldSkipSpecStalenessForPreservedProgress(task, options.plannerLane)) {
    return {
      isStale: false,
      ageMs: undefined,
      maxAgeMs: undefined,
      reason: "Specification staleness skipped for task with preserved execution progress",
      skipped: true,
    };
  }

  // Resolve max age with fallback to default
  const configuredMaxAgeMs = settings.specStalenessMaxAgeMs;
  const maxAgeMs =
    typeof configuredMaxAgeMs === "number" && configuredMaxAgeMs > 0
      ? configuredMaxAgeMs
      : DEFAULT_SPEC_STALENESS_MAX_AGE_MS;

  const now = nowMs ?? Date.now();

  // Attempt to stat PROMPT.md for mtime
  let mtimeMs: number;
  try {
    const fileStat = await stat(promptPath);
    mtimeMs = fileStat.mtimeMs;
  } catch {
    // File missing or unreadable — skip staleness evaluation
    // Callers should fall back to existing filesystem validation
    return {
      isStale: false,
      ageMs: undefined,
      maxAgeMs: undefined,
      reason: "",
      skipped: true,
    };
  }

  const ageMs = now - mtimeMs;

  // Exclusive comparison: ageMs === maxAgeMs is NOT stale
  const isStale = ageMs > maxAgeMs;

  const reason = isStale
    ? `Specification stale (age=${ageMs}ms, max=${maxAgeMs}ms) — moved to triage for re-planning`
    : "";

  return {
    isStale,
    ageMs,
    maxAgeMs,
    reason,
    skipped: false,
  };
}

/**
 * Get the PROMPT.md path for a task given the tasks directory and task ID.
 *
 * @param tasksDir - The project's tasks directory (e.g., `.fusion/tasks`)
 * @param taskId - The task ID (e.g., `FN-001`)
 * @returns Absolute path to the task's PROMPT.md file
 */
export function getPromptPath(tasksDir: string, taskId: string): string {
  return join(tasksDir, taskId, "PROMPT.md");
}
