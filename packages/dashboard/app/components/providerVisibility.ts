const HIDDEN_ONBOARDING_AND_SETTINGS_PROVIDER_IDS = new Set([
  "google-antigravity",
  "antigravity",
  "google-gemini-cli",
]);

export function isProviderVisibleInOnboardingAndSettings(providerId: string): boolean {
  return !HIDDEN_ONBOARDING_AND_SETTINGS_PROVIDER_IDS.has(providerId);
}

export function filterVisibleOnboardingAndSettingsProviders<T extends { id: string }>(
  providers: T[],
): T[] {
  return providers.filter((provider) => isProviderVisibleInOnboardingAndSettings(provider.id));
}

export { HIDDEN_ONBOARDING_AND_SETTINGS_PROVIDER_IDS };
