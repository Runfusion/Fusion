/**
 * Slice 2 (Hybrid Anchoring) goal-context seam for system prompts.
 *
 * This module formats active goals into a compact, deterministic prompt section
 * containing ID + title only. It intentionally omits descriptions/bodies to
 * keep prompt footprint small and byte-stable for downstream session builders.
 *
 * Truncation is deterministic: goals are re-sorted oldest-first and newer goals
 * are dropped first under cap/budget pressure so longest-standing strategy
 * remains anchored. Wiring this seam into heartbeat/executor prompt assembly is
 * handled separately by FN-5653.
 */
import * as core from "@fusion/core";
import type { Goal } from "@fusion/core";

/**
 * Maximum number of goals this seam will ever inject.
 *
 * Mirrors the core active-goal limit and is asserted not to exceed it.
 */
export const MAX_INJECTED_GOALS = 5;

const resolvedActiveGoalLimit =
  "ACTIVE_GOAL_LIMIT" in core && typeof core.ACTIVE_GOAL_LIMIT === "number"
    ? core.ACTIVE_GOAL_LIMIT
    : MAX_INJECTED_GOALS;

if (MAX_INJECTED_GOALS > resolvedActiveGoalLimit) {
  throw new Error(
    `MAX_INJECTED_GOALS (${MAX_INJECTED_GOALS}) cannot exceed ACTIVE_GOAL_LIMIT (${resolvedActiveGoalLimit})`,
  );
}

/**
 * Default maximum character budget for the rendered Active Goals section.
 */
export const DEFAULT_GOAL_INJECTION_CHAR_BUDGET = 600;

/**
 * Structured truncation event emitted when capping and/or budget pressure drops goals.
 */
export interface GoalInjectionTruncationEvent {
  reason: "cap" | "budget";
  requested: number;
  emitted: number;
  droppedGoalIds: string[];
  charBudget: number;
  producedChars: number;
}

/**
 * Pure input contract for the goal-context seam.
 *
 * Callers fetch active goals (typically from GoalStore) and pass them in so
 * this helper remains deterministic, side-effect-free, and trivially testable.
 */
export interface GoalInjectionInput {
  activeGoals: Goal[];
  maxGoals?: number;
  charBudget?: number;
  onTruncated?: (event: GoalInjectionTruncationEvent) => void;
}

/**
 * Output payload for system prompt assembly.
 */
export interface GoalInjectionResult {
  text: string;
  emittedGoalIds: string[];
  truncated: GoalInjectionTruncationEvent | null;
}

function normalizeTitle(title: string): string {
  return title.replace(/\s*\n+\s*/g, " ").trim();
}

function renderGoalContext(goals: Goal[]): string {
  const lines = goals.map((goal) => `- ${goal.id}: ${normalizeTitle(goal.title)}`);
  return `## Active Goals\n\n${lines.join("\n")}`;
}

/**
 * Build a deterministic Active Goals prompt section from caller-provided goals.
 *
 * The function defensively re-sorts by `createdAt` ascending then `id`
 * ascending (tie-break) so output is stable even if callers pass shuffled input.
 * It does not read GoalStore directly.
 */
export function buildGoalContextSection(input: GoalInjectionInput): GoalInjectionResult {
  const { activeGoals, onTruncated } = input;
  if (activeGoals.length === 0) {
    return { text: "", emittedGoalIds: [], truncated: null };
  }

  const sortedGoals = [...activeGoals].sort((a, b) => {
    const byCreated = a.createdAt.localeCompare(b.createdAt);
    if (byCreated !== 0) {
      return byCreated;
    }
    return a.id.localeCompare(b.id);
  });

  const resolvedMaxGoals = Math.min(input.maxGoals ?? MAX_INJECTED_GOALS, MAX_INJECTED_GOALS);
  const charBudget = input.charBudget ?? DEFAULT_GOAL_INJECTION_CHAR_BUDGET;

  const droppedGoalIds: string[] = [];
  let selectedGoals = sortedGoals.slice(0, resolvedMaxGoals);

  if (sortedGoals.length > resolvedMaxGoals) {
    droppedGoalIds.push(...sortedGoals.slice(resolvedMaxGoals).map((goal) => goal.id));
  }

  let text = renderGoalContext(selectedGoals);
  let usedBudgetDrop = false;

  while (selectedGoals.length > 1 && text.length > charBudget) {
    const dropped = selectedGoals[selectedGoals.length - 1];
    selectedGoals = selectedGoals.slice(0, -1);
    droppedGoalIds.push(dropped.id);
    text = renderGoalContext(selectedGoals);
    usedBudgetDrop = true;
  }

  let truncated: GoalInjectionTruncationEvent | null = null;
  if (droppedGoalIds.length > 0) {
    truncated = {
      reason: usedBudgetDrop ? "budget" : "cap",
      requested: activeGoals.length,
      emitted: selectedGoals.length,
      droppedGoalIds,
      charBudget,
      producedChars: text.length,
    };
    onTruncated?.(truncated);
  }

  return {
    text,
    emittedGoalIds: selectedGoals.map((goal) => goal.id),
    truncated,
  };
}
