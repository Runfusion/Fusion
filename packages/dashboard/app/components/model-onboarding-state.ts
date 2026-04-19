/**
 * Persisted onboarding step state for resume functionality.
 *
 * Stores the current onboarding step in localStorage so users can resume
 * from where they left off if they dismiss the modal without completing.
 */

export type OnboardingStep = "ai-setup" | "github" | "first-task" | "complete";

interface OnboardingState {
  currentStep: OnboardingStep | string; // string allows for future unknown steps
  updatedAt: string; // ISO-8601 timestamp
  /** Steps that have been completed (visited and passed) */
  completedSteps: OnboardingStep[];
  /** Steps that were intentionally skipped and can be completed later */
  skippedSteps: OnboardingStep[];
  /** Whether the user explicitly dismissed the modal without finishing */
  dismissed: boolean;
  /** Whether the user finished all steps and completed onboarding */
  completed: boolean;
  /** Per-step data for restoring UI state on reopen */
  stepData: Partial<Record<OnboardingStep, Record<string, unknown>>>;
  /** Legacy field: ISO-8601 timestamp when onboarding was marked complete */
  completedAt?: string;
  /** ISO-8601 timestamp when post-onboarding recommendations were dismissed */
  postOnboardingDismissedAt?: string;
}

const STORAGE_KEY = "fusion_model_onboarding_state";

/**
 * Default values for backward compatibility with partial state objects
 */
const DEFAULT_COMPLETED_STEPS: OnboardingStep[] = [];
const DEFAULT_SKIPPED_STEPS: OnboardingStep[] = [];
const DEFAULT_DISMISSED = false;
const DEFAULT_COMPLETED = false;
const DEFAULT_STEP_DATA: Partial<Record<OnboardingStep, Record<string, unknown>>> = {};
const DEFAULT_POST_ONBOARDING_DISMISSED_AT: string | undefined = undefined;

/**
 * Step labels for display in the resume card.
 * Fallback for unknown step IDs uses the raw key with title-case formatting.
 */
export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  "ai-setup": "AI Setup",
  github: "GitHub",
  "first-task": "First Task",
  complete: "Complete",
};

/**
 * Get the currently persisted onboarding state, or null if none exists.
 * Applies defaults for backward compatibility with partial/legacy state objects.
 */
export function getOnboardingState(): OnboardingState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "currentStep" in parsed &&
      typeof (parsed as Record<string, unknown>).currentStep === "string"
    ) {
      const state = parsed as OnboardingState;
      // Apply defaults for backward compatibility with partial state objects
      return applyStateDefaults(state);
    }
    return null;
  } catch {
    // Malformed storage - treat as missing
    return null;
  }
}

/**
 * Apply default values for backward compatibility with partial/legacy state objects.
 */
function applyStateDefaults(state: OnboardingState): OnboardingState {
  const postOnboardingDismissedAt = state.postOnboardingDismissedAt ?? DEFAULT_POST_ONBOARDING_DISMISSED_AT;

  return {
    ...state,
    completedSteps: state.completedSteps ?? DEFAULT_COMPLETED_STEPS,
    skippedSteps: state.skippedSteps ?? DEFAULT_SKIPPED_STEPS,
    dismissed: state.dismissed ?? DEFAULT_DISMISSED,
    completed: state.completed ?? DEFAULT_COMPLETED,
    stepData: state.stepData ?? DEFAULT_STEP_DATA,
    ...(postOnboardingDismissedAt ? { postOnboardingDismissedAt } : {}),
  };
}

/**
 * Persist the current onboarding step state.
 * Call this when the user dismisses the modal without completing.
 * @param step - The current step (known OnboardingStep or unknown string for future steps)
 * @param options - Optional rich payload for extended state tracking
 * @param options.completedSteps - Array of steps that have been completed (for resume functionality)
 * @param options.skippedSteps - Array of steps intentionally skipped (for resume functionality)
 * @param options.dismissed - Whether the user explicitly dismissed without finishing
 * @param options.completed - Whether the user finished all steps
 * @param options.stepData - Per-step data for restoring UI state on reopen
 */
export function saveOnboardingState(
  step: OnboardingStep | string,
  options?: {
    completedSteps?: OnboardingStep[];
    skippedSteps?: OnboardingStep[];
    dismissed?: boolean;
    completed?: boolean;
    stepData?: Partial<Record<OnboardingStep, Record<string, unknown>>>;
  }
): void {
  if (typeof window === "undefined") return;

  // If no options provided, use simple overwrite (backward compatible)
  if (!options) {
    const state: OnboardingState = {
      currentStep: step,
      updatedAt: new Date().toISOString(),
      completedSteps: DEFAULT_COMPLETED_STEPS,
      skippedSteps: DEFAULT_SKIPPED_STEPS,
      dismissed: DEFAULT_DISMISSED,
      completed: DEFAULT_COMPLETED,
      stepData: DEFAULT_STEP_DATA,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage quota exceeded or private browsing - fail silently
    }
    return;
  }

  // With options, merge with existing state
  try {
    const existing = getOnboardingState();
    const now = new Date().toISOString();

    // Determine completed and dismissed flags
    // completed takes precedence over dismissed
    const completed = options.completed ?? DEFAULT_COMPLETED;
    let dismissed = options.dismissed ?? DEFAULT_DISMISSED;

    // If completed is true, dismissed should be false
    if (completed) {
      dismissed = false;
    }

    // Merge completedSteps
    const completedSteps = options.completedSteps ?? existing?.completedSteps ?? DEFAULT_COMPLETED_STEPS;
    const skippedSteps = options.skippedSteps ?? existing?.skippedSteps ?? DEFAULT_SKIPPED_STEPS;

    // Merge stepData per-step key
    const stepData: Partial<Record<OnboardingStep, Record<string, unknown>>> = {
      ...(existing?.stepData ?? DEFAULT_STEP_DATA),
    };
    if (options.stepData) {
      for (const [stepKey, data] of Object.entries(options.stepData)) {
        if (data !== undefined) {
          stepData[stepKey as OnboardingStep] = {
            ...(stepData[stepKey as OnboardingStep] ?? {}),
            ...data,
          };
        }
      }
    }

    const state: OnboardingState = {
      currentStep: step,
      updatedAt: now,
      completedSteps,
      skippedSteps,
      dismissed,
      completed,
      stepData,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Mark a specific step as completed.
 * Reads current state, adds step to completedSteps (deduped), and saves.
 * If no state exists, initializes a fresh state with completedSteps containing only this step.
 * @param step - The step to mark as completed
 */
export function markStepCompleted(step: OnboardingStep): void {
  if (typeof window === "undefined") return;

  try {
    const existing = getOnboardingState();
    const now = new Date().toISOString();

    if (!existing) {
      // Initialize fresh state with this step completed
      const state: OnboardingState = {
        currentStep: step,
        updatedAt: now,
        completedSteps: [step],
        skippedSteps: DEFAULT_SKIPPED_STEPS,
        dismissed: DEFAULT_DISMISSED,
        completed: DEFAULT_COMPLETED,
        stepData: DEFAULT_STEP_DATA,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return;
    }

    // Add step to completedSteps (deduped)
    const completedSteps = existing.completedSteps.includes(step)
      ? existing.completedSteps
      : [...existing.completedSteps, step];

    const state: OnboardingState = {
      ...existing,
      completedSteps,
      skippedSteps: existing.skippedSteps.filter((s) => s !== step),
      updatedAt: now,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Mark a specific step as skipped.
 * Reads current state, adds step to skippedSteps (deduped), and saves.
 * If no state exists, initializes a fresh state with skippedSteps containing only this step.
 * @param step - The step to mark as skipped
 */
export function markStepSkipped(step: OnboardingStep): void {
  if (typeof window === "undefined") return;

  try {
    const existing = getOnboardingState();
    const now = new Date().toISOString();

    if (!existing) {
      const state: OnboardingState = {
        currentStep: step,
        updatedAt: now,
        completedSteps: DEFAULT_COMPLETED_STEPS,
        skippedSteps: [step],
        dismissed: DEFAULT_DISMISSED,
        completed: DEFAULT_COMPLETED,
        stepData: DEFAULT_STEP_DATA,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return;
    }

    const skippedSteps = existing.skippedSteps.includes(step)
      ? existing.skippedSteps
      : [...existing.skippedSteps, step];

    const state: OnboardingState = {
      ...existing,
      skippedSteps,
      completedSteps: existing.completedSteps.filter((s) => s !== step),
      updatedAt: now,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Clear the persisted onboarding state.
 * Call this when onboarding is fully completed.
 * @param options - Optional options for clearing behavior
 * @param options.preserveProgress - If true, sets completed=true while preserving completedSteps and stepData
 */
export function clearOnboardingState(options?: { preserveProgress?: boolean }): void {
  if (typeof window === "undefined") return;

  try {
    // Default behavior: remove the key entirely (backward compatible)
    if (!options?.preserveProgress) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    // With preserveProgress: set completed=true while preserving progress data
    const existing = getOnboardingState();
    const now = new Date().toISOString();

    if (!existing) {
      // No existing state - create minimal completed state
      const state: OnboardingState = {
        currentStep: "complete",
        updatedAt: now,
        completedSteps: DEFAULT_COMPLETED_STEPS,
        skippedSteps: DEFAULT_SKIPPED_STEPS,
        dismissed: false,
        completed: true,
        stepData: DEFAULT_STEP_DATA,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return;
    }

    // Preserve existing progress data but mark as completed
    const state: OnboardingState = {
      ...existing,
      currentStep: "complete",
      updatedAt: now,
      dismissed: false,
      completed: true,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Fail silently
  }
}

/**
 * Mark onboarding as completed by setting the completedAt timestamp.
 * Unlike clearOnboardingState(), this preserves the state so the completion
 * timestamp can be queried later. Call this when user completes onboarding
 * (via Finish Setup, Create Task, or Import from GitHub).
 * @deprecated Use clearOnboardingState({ preserveProgress: true }) for new code
 */
export function markOnboardingCompleted(): void {
  if (typeof window === "undefined") return;

  try {
    const existing = getOnboardingState();
    const now = new Date().toISOString();
    const state: OnboardingState = existing
      ? { ...existing, completedAt: now, completed: true, dismissed: false, updatedAt: now }
      : {
          currentStep: "complete",
          updatedAt: now,
          completedAt: now,
          completedSteps: DEFAULT_COMPLETED_STEPS,
          skippedSteps: DEFAULT_SKIPPED_STEPS,
          dismissed: false,
          completed: true,
          stepData: DEFAULT_STEP_DATA,
        };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Check if onboarding has been marked as completed.
 * Returns true when either:
 * - The `completed` boolean is true (new format)
 * - The `completedAt` timestamp is set (legacy format)
 * A dismissed (but not completed) onboarding returns false.
 */
export function isOnboardingCompleted(): boolean {
  const state = getOnboardingState();
  if (!state) return false;

  // Check new boolean field first
  if (state.completed === true) return true;

  // Fall back to legacy timestamp field
  return typeof state.completedAt === "string" && state.completedAt.length > 0;
}

/**
 * Mark the post-onboarding recommendations as dismissed.
 */
export function dismissPostOnboardingRecommendations(): void {
  if (typeof window === "undefined") return;

  try {
    const existing = getOnboardingState();
    const now = new Date().toISOString();

    const state: OnboardingState = existing
      ? {
          ...existing,
          updatedAt: now,
          postOnboardingDismissedAt: now,
        }
      : {
          currentStep: "complete",
          updatedAt: now,
          completedSteps: DEFAULT_COMPLETED_STEPS,
          skippedSteps: DEFAULT_SKIPPED_STEPS,
          dismissed: false,
          completed: false,
          stepData: DEFAULT_STEP_DATA,
          postOnboardingDismissedAt: now,
        };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Whether post-onboarding recommendations were dismissed.
 */
export function isPostOnboardingDismissed(): boolean {
  const state = getOnboardingState();
  if (!state) return false;

  return typeof state.postOnboardingDismissedAt === "string" && state.postOnboardingDismissedAt.length > 0;
}

/**
 * Remove persisted post-onboarding dismissal state.
 */
export function clearPostOnboardingDismissal(): void {
  if (typeof window === "undefined") return;

  try {
    const existing = getOnboardingState();
    if (!existing) return;

    const { postOnboardingDismissedAt: _postOnboardingDismissedAt, ...stateWithoutDismissal } = existing;
    const state: OnboardingState = {
      ...stateWithoutDismissal,
      updatedAt: new Date().toISOString(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Get the ISO-8601 timestamp when onboarding was marked complete.
 * Returns null if onboarding has not been completed or no state exists.
 * @deprecated Use isOnboardingCompleted() and getOnboardingState().completed instead
 */
export function getOnboardingCompletedAt(): string | null {
  const state = getOnboardingState();
  if (!state || !state.completedAt) return null;
  return state.completedAt;
}

/**
 * Determine if onboarding can be resumed.
 * Returns true only when persisted state exists, currentStep is not "complete",
 * and onboarding has not been completed (either via `completed` boolean or `completedAt` timestamp).
 */
export function isOnboardingResumable(): boolean {
  const state = getOnboardingState();
  if (!state) return false;

  // Reject if completed (either new boolean or legacy timestamp)
  if (isOnboardingCompleted()) return false;

  // Reject if currentStep is "complete" or not a valid step identifier
  return state.currentStep !== "complete";
}

/**
 * Get the step info needed to display the resume card.
 * Returns null if no resumable state exists (including if onboarding was completed).
 * @returns Object containing:
 *   - currentStep: The step where the user left off
 *   - label: Human-readable step label
 *   - completedSteps: Array of steps the user has completed (for showing progress)
 */
export function getOnboardingResumeStep(): { currentStep: string; label: string; completedSteps: OnboardingStep[] } | null {
  const state = getOnboardingState();
  // Return null if no state, completed, or step is "complete"
  if (!state || isOnboardingCompleted() || state.currentStep === "complete") {
    return null;
  }

  // Check if it's a known step with a predefined label
  const knownStep = state.currentStep as OnboardingStep;
  const label = ONBOARDING_STEP_LABELS[knownStep] ?? formatUnknownStepLabel(state.currentStep);

  return {
    currentStep: state.currentStep,
    label,
    completedSteps: state.completedSteps,
  };
}

/**
 * Get the list of completed steps from stored state.
 * Returns empty array if no state exists or completedSteps is missing.
 */
export function getCompletedSteps(): OnboardingStep[] {
  const state = getOnboardingState();
  if (!state) return DEFAULT_COMPLETED_STEPS;
  return state.completedSteps;
}

/**
 * Get the list of skipped steps from stored state.
 * Returns empty array if no state exists or skippedSteps is missing.
 */
export function getSkippedSteps(): OnboardingStep[] {
  const state = getOnboardingState();
  if (!state) return DEFAULT_SKIPPED_STEPS;
  return state.skippedSteps;
}

/**
 * Get stored per-step data for a specific step.
 * Returns null if no state exists or the step has no data.
 * @param step - The step to get data for
 */
export function getStepData(step: OnboardingStep): Record<string, unknown> | null {
  const state = getOnboardingState();
  if (!state || !state.stepData) return null;
  return state.stepData[step] ?? null;
}

/**
 * Generate a human-readable label for an unknown step ID.
 * This handles future step IDs that may be added after this code was written.
 */
function formatUnknownStepLabel(stepId: string): string {
  // Convert kebab-case or snake_case to Title Case
  return stepId
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
