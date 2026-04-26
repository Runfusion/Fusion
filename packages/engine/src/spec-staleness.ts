/**
 * Spec Staleness Evaluator
 *
 * Evaluates whether a task's PROMPT.md has become stale based on file modification time.
 * When spec staleness enforcement is enabled, tasks whose specification age exceeds
 * the configured threshold must be re-planned before execution.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "@fusion/core";

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
export async function evaluateSpecStaleness(
  options: EvaluateSpecStalenessOptions,
): Promise<SpecStalenessResult> {
  const { settings, promptPath, nowMs } = options;

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
