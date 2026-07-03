import { useEffect, useRef } from "react";
import { fetchAuthStatus, fetchGlobalSettings } from "../api";
import { isOnboardingCompleted } from "../components/model-onboarding-state";
import { trackOnboardingEvent } from "../components/onboarding-events";
import type { SectionId } from "../components/SettingsModal";

export interface UseAuthOnboardingOptions {
  projectId?: string;
  setupWizardOpen: boolean;
  openModelOnboarding: () => void;
  openSettings: (section?: SectionId) => void;
}

/**
 * Runs auth/onboarding checks and opens the appropriate setup modal.
 *
 * This hook implements a one-shot guard: the auto-trigger logic runs at most
 * once per hook instance (regardless of effect re-runs due to dependency changes).
 * This prevents repeat auto-opens on incidental rerenders or project context churn.
 *
 * Trigger behavior:
 * - First-run (onboarding incomplete): opens model onboarding wizard
 * - Completed onboarding + unauthenticated providers: opens Settings → Authentication
 * - Already configured: no auto-open
 */
export function useAuthOnboarding({
  setupWizardOpen,
  openModelOnboarding,
  openSettings,
}: UseAuthOnboardingOptions): void {
  // One-shot guard: prevents the auto-trigger logic from running more than once
  // per hook instance, even if the effect re-runs due to dependency changes.
  const hasTriggeredRef = useRef(false);
  // Track latest setupWizardOpen so the resolved fetch promise can re-check
  // it without becoming a stale-closure read.
  const setupWizardOpenRef = useRef(setupWizardOpen);
  setupWizardOpenRef.current = setupWizardOpen;

  useEffect(() => {
    // Defer auto-triggering while setup wizard is open.
    // Important: this must run before consuming the one-shot flag.
    if (setupWizardOpen) return;
    /*
    FNXC:Onboarding 2026-06-22-05:06:
    Brand-new users should be prompted to set up AI and GitHub before project details, then continue through Project, Agent, and First Task.
    Allow model onboarding to auto-open without a projectId; its Project step owns opening the project-only setup wizard when needed.
    */
    // Skip if we've already triggered (one-shot guard)
    if (hasTriggeredRef.current) return;
    // Mark as triggered immediately to prevent any race condition on re-runs
    hasTriggeredRef.current = true;

    let shouldOpenOnboarding = false;
    let shouldOpenSettings = false;

    fetchAuthStatus()
      .then(({ providers }) => {
        const hasAuthenticatedProvider = providers.some((provider) => provider.authenticated);

        /*
         * FNXC:Onboarding 2026-07-03-04:00:
         * Always evaluate first-run onboarding from completion state — do NOT gate on
         * `providers.length > 0`. A brand-new install (notably the desktop app on first launch)
         * can report an empty provider list; the old gate skipped onboarding entirely and dropped
         * the operator on an empty dashboard with no AI/GitHub setup. Brand-new users must be guided
         * through AI + GitHub setup before project creation — the model-onboarding wizard owns that
         * AI -> GitHub -> Project sequence.
         */
        return fetchGlobalSettings()
          .then((globalSettings) => {
            const hasDefaultModel = !!(
              globalSettings.defaultProvider && globalSettings.defaultModelId
            );
            // Explicit first-run detection: onboarding is incomplete when
            // modelOnboardingComplete is false or undefined
            const onboardingIncomplete =
              globalSettings.modelOnboardingComplete === false ||
              globalSettings.modelOnboardingComplete === undefined;
            const setupIncomplete = !hasAuthenticatedProvider || !hasDefaultModel;

            if (onboardingIncomplete && setupIncomplete && !isOnboardingCompleted()) {
              shouldOpenOnboarding = true;
            } else if (!hasAuthenticatedProvider && !isOnboardingCompleted()) {
              // Completed onboarding but no authenticated provider → fallback
              // to Settings Authentication section (only if not locally completed)
              shouldOpenSettings = true;
            }
          });
      })
      .then(() => {
        // Execute after the promise chain resolves. Re-check the wizard:
        // the user (or auto-open logic) may have opened it while the auth
        // fetch was in flight, and we don't want to stack modals.
        if (setupWizardOpenRef.current) {
          // Release the one-shot so the effect can retry once the wizard
          // closes (the effect re-runs on the setupWizardOpen dep flip).
          hasTriggeredRef.current = false;
          return;
        }
        if (shouldOpenOnboarding) {
          trackOnboardingEvent("onboarding:auto-triggered", { trigger: "first-run" });
          openModelOnboarding();
        } else if (shouldOpenSettings) {
          trackOnboardingEvent("onboarding:auto-triggered", { trigger: "missing-provider" });
          openSettings("authentication");
        }
      })
      .catch(() => {
        // Fail silently - non-blocking behavior preserves dashboard usability.
        // Onboarding can be manually triggered later via Settings if needed.
      });
  }, [setupWizardOpen, openModelOnboarding, openSettings]);
}
