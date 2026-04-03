/**
 * Global settings store — manages user-level settings in `~/.pi/fusion/settings.json`.
 *
 * Global settings persist across all kb projects for the current user.
 * They include UI theme preferences, default AI model selection, and
 * notification configuration.
 *
 * **Schema protection**: The store preserves any keys found in the settings
 * file that are not part of the current `GlobalSettings` schema. This prevents
 * data loss when schema changes remove fields — the values remain on disk and
 * can be restored if the field is re-added later. See `readRaw()`.
 *
 * @see {@link GlobalSettings} for the full list of global fields.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { GlobalSettings } from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

/** Legacy directory for global settings before the rename to fusion. */
export function legacyGlobalDir(): string {
  return join(homedir(), ".pi", "kb");
}

/** Default directory for global fusion settings: `~/.pi/fusion/` */
export function defaultGlobalDir(): string {
  return join(homedir(), ".pi", "fusion");
}

/**
 * Resolve the active global directory.
 *
 * If the new `~/.pi/fusion` directory does not exist but the legacy
 * `~/.pi/kb` directory does, move the legacy directory into place so
 * existing settings and central metadata continue to work after upgrade.
 */
export function resolveGlobalDir(dir?: string): string {
  if (dir) return dir;

  const preferredDir = defaultGlobalDir();
  const legacyDir = legacyGlobalDir();

  if (!existsSync(preferredDir) && existsSync(legacyDir)) {
    try {
      mkdirSync(dirname(preferredDir), { recursive: true });
      renameSync(legacyDir, preferredDir);
    } catch {
      return legacyDir;
    }
  }

  return preferredDir;
}

export class GlobalSettingsStore {
  private readonly settingsPath: string;
  private readonly dir: string;

  /** Promise chain for serializing read-modify-write cycles */
  private lock: Promise<void> = Promise.resolve();

  /**
   * Create a GlobalSettingsStore.
   * @param dir — Directory to store settings.json. Defaults to `~/.pi/fusion/`.
   *              Accepts a custom path for testing.
   */
  constructor(dir?: string) {
    this.dir = resolveGlobalDir(dir);
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
   * Read the raw JSON object from disk without applying defaults.
   * Returns all keys present in the file, including any that are no longer
   * part of the current GlobalSettings schema. Returns an empty object if
   * the file is missing or invalid.
   *
   * This is the foundation of schema protection — unknown keys survive
   * read-modify-write cycles because they flow through this method.
   */
  async readRaw(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.settingsPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Read global settings from disk. Returns defaults merged with persisted values.
   * If the file doesn't exist or is invalid, returns defaults without throwing.
   */
  async getSettings(): Promise<GlobalSettings> {
    const parsed = await this.readRaw();
    return { ...DEFAULT_GLOBAL_SETTINGS, ...parsed } as GlobalSettings;
  }

  /**
   * Update global settings by merging a partial patch into the existing values.
   * Only fields present in the patch are overwritten; other fields are preserved.
   * Uses atomic write (write-to-temp-then-rename) and serialized locking.
   *
   * **Schema protection**: reads the raw file (including unknown keys) before
   * merging, so fields that were removed from the TypeScript schema are not
   * silently dropped during save cycles.
   *
   * @returns The full updated settings after merge.
   */
  async updateSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    return this.withLock(async () => {
      const raw = await this.readRaw();
      const merged = { ...DEFAULT_GLOBAL_SETTINGS, ...raw, ...patch };
      await mkdir(this.dir, { recursive: true });
      await this.atomicWrite(merged as GlobalSettings);
      return merged as GlobalSettings;
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
