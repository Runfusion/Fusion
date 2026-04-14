import { useEffect, useRef } from "react";
import { fetchAuthStatus, fetchGlobalSettings } from "../api";
import type { SectionId } from "../components/SettingsModal";

export interface UseAuthOnboardingOptions {
  projectId?: string;
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
  projectId,
  openModelOnboarding,
  openSettings,
}: UseAuthOnboardingOptions): void {
  // One-shot guard: prevents the auto-trigger logic from running more than once
  // per hook instance, even if the effect re-runs due to dependency changes.
  const hasTriggeredRef = useRef(false);

  useEffect(() => {
    // Skip if we've already triggered (one-shot guard)
    if (hasTriggeredRef.current) return;
    // Mark as triggered immediately to prevent any race condition on re-runs
    hasTriggeredRef.current = true;

    let shouldOpenOnboarding = false;
    let shouldOpenSettings = false;

    fetchAuthStatus()
      .then(({ providers }) => {
        const hasAuthenticatedProvider = providers.some((provider) => provider.authenticated);
        const needsSetup = providers.length > 0 && !hasAuthenticatedProvider;

        if (needsSetup || (providers.length > 0 && hasAuthenticatedProvider)) {
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

              if (onboardingIncomplete && setupIncomplete) {
                shouldOpenOnboarding = true;
              } else if (!hasAuthenticatedProvider) {
                // Completed onboarding but no authenticated provider → fallback
                // to Settings Authentication section
                shouldOpenSettings = true;
              }
            });
        }
      })
      .then(() => {
        // Execute after the promise chain resolves
        if (shouldOpenOnboarding) {
          openModelOnboarding();
        } else if (shouldOpenSettings) {
          openSettings("authentication");
        }
      })
      .catch(() => {
        // Fail silently - non-blocking behavior preserves dashboard usability.
        // Onboarding can be manually triggered later via Settings if needed.
      });
  }, [projectId, openModelOnboarding, openSettings]);
}
