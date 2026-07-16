import { describe, expect, it } from "vitest";
import {
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isProjectSettingsKey,
} from "../settings-schema.js";

describe("database backup settings scope", () => {
  const databaseKeys = ["autoBackupEnabled", "autoBackupSchedule", "autoBackupRetention", "autoBackupDir"] as const;
  const memoryKeys = ["memoryBackupEnabled", "memoryBackupSchedule", "memoryBackupRetention", "memoryBackupDir", "memoryBackupScope"] as const;

  it("keeps shared database backup policy global and memory snapshots project scoped", () => {
    for (const key of databaseKeys) {
      expect(GLOBAL_SETTINGS_KEYS).toContain(key);
      expect(PROJECT_SETTINGS_KEYS).not.toContain(key);
      expect(isGlobalSettingsKey(key)).toBe(true);
      expect(isProjectSettingsKey(key)).toBe(false);
    }
    for (const key of memoryKeys) {
      expect(PROJECT_SETTINGS_KEYS).toContain(key);
      expect(GLOBAL_SETTINGS_KEYS).not.toContain(key);
      expect(isProjectSettingsKey(key)).toBe(true);
      expect(isGlobalSettingsKey(key)).toBe(false);
    }
  });
});
