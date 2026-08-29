import { getDailyEnabled, getTimezone, getWeeklyEnabled } from "./settings.js";

export type ReportsCadence = "daily" | "weekly";

export interface CadenceResolution {
  cadence: ReportsCadence;
  timezone: string;
}

export function resolveEnabledCadences(settings: Record<string, unknown>): CadenceResolution[] {
  const timezone = getTimezone(settings);
  const enabled: CadenceResolution[] = [];

  if (getDailyEnabled(settings)) {
    enabled.push({ cadence: "daily", timezone });
  }

  if (getWeeklyEnabled(settings)) {
    enabled.push({ cadence: "weekly", timezone });
  }

  return enabled;
}
