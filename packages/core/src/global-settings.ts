/**
 * Global settings store — manages user-level settings in `~/.pi/kb/settings.json`.
 *
 * Global settings persist across all kb projects for the current user.
 * They include UI theme preferences, default AI model selection, and
 * notification configuration.
 *
 * @see {@link GlobalSettings} for the full list of global fields.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { GlobalSettings } from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

/** Default directory for global kb settings: `~/.pi/kb/` */
export function defaultGlobalDir(): string {
  return join(homedir(), ".pi", "kb");
}

export class GlobalSettingsStore {
  private readonly settingsPath: string;
  private readonly dir: string;

  /** Promise chain for serializing read-modify-write cycles */
  private lock: Promise<void> = Promise.resolve();

  /**
   * Create a GlobalSettingsStore.
   * @param dir — Directory to store settings.json. Defaults to `~/.pi/kb/`.
   *              Accepts a custom path for testing.
   */
  constructor(dir?: string) {
    this.dir = dir ?? defaultGlobalDir();
    this.settingsPath = join(this.dir, "settings.json");
  }

  /**
   * Ensure the settings directory exists. Creates it recursively if needed.
   * If the settings file doesn't exist, creates it with defaults.
   * Returns true if the file was created for the first time.
   */
  async init(): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.settingsPath)) {
      await this.atomicWrite(DEFAULT_GLOBAL_SETTINGS);
      return true;
    }
    return false;
  }

  /**
   * Read global settings from disk. Returns defaults merged with persisted values.
   * If the file doesn't exist or is invalid, returns defaults without throwing.
   */
  async getSettings(): Promise<GlobalSettings> {
    try {
      const raw = await readFile(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
      return { ...DEFAULT_GLOBAL_SETTINGS, ...parsed };
    } catch {
      // File missing, unreadable, or invalid JSON → return defaults
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }
  }

  /**
   * Update global settings by merging a partial patch into the existing values.
   * Only fields present in the patch are overwritten; other fields are preserved.
   * Uses atomic write (write-to-temp-then-rename) and serialized locking.
   *
   * @returns The full updated settings after merge.
   */
  async updateSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    return this.withLock(async () => {
      const current = await this.getSettings();
      const updated = { ...current, ...patch };
      await mkdir(this.dir, { recursive: true });
      await this.atomicWrite(updated);
      return updated;
    });
  }

  /**
   * Get the path to the settings file (useful for diagnostics/logging).
   */
  getSettingsPath(): string {
    return this.settingsPath;
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Atomically write settings to disk. Writes to a temp file first,
   * then renames into place (atomic on POSIX).
   */
  private async atomicWrite(settings: GlobalSettings): Promise<void> {
    const tmpPath = this.settingsPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(settings, null, 2));
    await rename(tmpPath, this.settingsPath);
  }

  /**
   * Serialize operations via promise chain to prevent lost-update races.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.lock;
    this.lock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
  }
}
