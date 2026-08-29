/**
 * Search entries for the Authentication section.
 *
 * FNXC:SettingsSearch 2026-07-24-23:15:
 * Authentication was storage-less and had no descriptor rows until
 * anthropicAuthPreference (credential precedence) landed as a SettingsSelectRow.
 * Co-locate its index entry so operators can find the control, and so the
 * settings-search-index guard does not treat the section as unregistered.
 */
import type { SettingsSearchEntry } from "../search/types";

export const authenticationSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "authentication",
    key: "anthropicAuthPreference",
    labelKey: "settings.auth.anthropicPreferenceLabel",
    labelFallback: "Anthropic credential to use",
    helpKey: "settings.auth.anthropicPreferenceHint",
    helpFallback:
      "You have both an Anthropic API key and a Claude subscription connected. Choose which one Fusion sends when a lane calls Anthropic directly. Default: API key.",
    keywords: ["anthropic", "api key", "subscription", "oauth", "credential precedence", "claude"],
  },
];
