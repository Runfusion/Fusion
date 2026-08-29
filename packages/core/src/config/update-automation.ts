import type { GlobalSettings } from "../types.js";

/**
 * FNXC:UpdateAutomation 2026-08-21-02:48:
 * The two update choices must preserve unset values so an explicit false can
 * override an older combined opt-in. Only an unset new value inherits legacy.
 */
export function resolveUpdateAutomationSettings(settings: Pick<GlobalSettings, "autoUpdateAndRestart" | "autoUpdateEnabled" | "autoRestartAfterUpdate">): {
  autoUpdateEnabled: boolean;
  autoRestartAfterUpdate: boolean;
} {
  const legacyEnabled = settings.autoUpdateAndRestart === true;
  return {
    autoUpdateEnabled: settings.autoUpdateEnabled ?? legacyEnabled,
    autoRestartAfterUpdate: settings.autoRestartAfterUpdate ?? legacyEnabled,
  };
}
