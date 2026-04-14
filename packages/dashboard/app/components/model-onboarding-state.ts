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
}

const STORAGE_KEY = "fusion_model_onboarding_state";

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
      // Return state as-is; getOnboardingResumeStep handles fallback labels for unknown steps
      return state;
    }
    return null;
  } catch {
    // Malformed storage - treat as missing
    return null;
  }
}

/**
 * Persist the current onboarding step state.
 * Call this when the user dismisses the modal without completing.
 * @param step - The current step (known OnboardingStep or unknown string for future steps)
 */
export function saveOnboardingState(step: OnboardingStep | string): void {
  if (typeof window === "undefined") return;

  const state: OnboardingState = {
    currentStep: step,
    updatedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing - fail silently
  }
}

/**
 * Clear the persisted onboarding state.
 * Call this when onboarding is fully completed.
 */
export function clearOnboardingState(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Fail silently
  }
}

/**
 * Determine if onboarding can be resumed.
 * Returns true only when persisted state exists and currentStep is not "complete".
 */
export function isOnboardingResumable(): boolean {
  const state = getOnboardingState();
  if (!state) return false;
  // Reject if currentStep is "complete" or not a valid step identifier
  return state.currentStep !== "complete";
}

/**
 * Get the step info needed to display the resume card.
 * Returns null if no resumable state exists.
 */
export function getOnboardingResumeStep(): { currentStep: string; label: string } | null {
  const state = getOnboardingState();
  if (!state || state.currentStep === "complete") {
    return null;
  }

  // Check if it's a known step with a predefined label
  const knownStep = state.currentStep as OnboardingStep;
  const label = ONBOARDING_STEP_LABELS[knownStep] ?? formatUnknownStepLabel(state.currentStep);

  return {
    currentStep: state.currentStep,
    label,
  };
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
