import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalSettingsStore, resolveGlobalDir } from "@fusion/core";
import type { UpdateChannel } from "@fusion/core";

type CachedUpdateStatus = {
  updateAvailable: boolean;
  latestVersion: string;
  currentVersion: string;
  channel?: UpdateChannel;
};

type UpdateCachePayload = {
  updateAvailable?: unknown;
  latestVersion?: unknown;
  currentVersion?: unknown;
  channel?: unknown;
};

export function getCachedUpdateStatus(currentVersion?: string): CachedUpdateStatus | null {
  try {
    const cachePath = join(resolveGlobalDir(), "update-check.json");
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as UpdateCachePayload;

    if (
      parsed.updateAvailable === true &&
      typeof parsed.latestVersion === "string" &&
      parsed.latestVersion.length > 0 &&
      typeof parsed.currentVersion === "string" &&
      parsed.currentVersion.length > 0
    ) {
      if (
        typeof currentVersion === "string" &&
        currentVersion.length > 0 &&
        parsed.currentVersion !== currentVersion
      ) {
        return null;
      }

      return {
        updateAvailable: true,
        latestVersion: parsed.latestVersion,
        currentVersion: parsed.currentVersion,
        channel: parsed.channel === "beta" ? "beta" : parsed.channel === "stable" ? "stable" : undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function isUpdateCheckEnabled(): Promise<boolean> {
  const store = new GlobalSettingsStore();
  await store.init();
  const settings = await store.getSettings();
  return settings.updateCheckEnabled !== false;
}

/*
FNXC:UpdateChannels 2026-07-19-13:00:
The persisted `updateChannel` global setting selects the release track for every
update surface. `fn update --channel <stable|beta>` both uses AND persists the
choice so the dashboard and desktop follow along. Absent/invalid = "stable".
*/
export async function getConfiguredUpdateChannel(): Promise<UpdateChannel> {
  try {
    const store = new GlobalSettingsStore();
    await store.init();
    const settings = await store.getSettings();
    return settings.updateChannel === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

export async function persistUpdateChannel(channel: UpdateChannel): Promise<void> {
  const store = new GlobalSettingsStore();
  await store.init();
  const settings = await store.getSettings();
  if (settings.updateChannel === channel) return;
  await store.updateSettings({ updateChannel: channel });
}
