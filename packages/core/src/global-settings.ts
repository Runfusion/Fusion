/**
 * Global settings store — manages user-level settings in `~/.fusion/settings.json`.
 *
 * Global settings persist across all fn projects for the current user.
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
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { GlobalSettings } from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";

/** Legacy directory for global settings (original name before rename to `.fusion`). */
export function legacyGlobalDir(): string {
  return join(homedir(), ".pi", "fusion");
}

/** Legacy directory for global settings from the earliest fn version (`.pi/kb`). */
export function legacyGlobalDirOriginal(): string {
  return join(homedir(), ".pi", "kb");
}

/** Default directory for global fusion settings: `~/.fusion/` */
export function defaultGlobalDir(): string {
  return join(homedir(), ".fusion");
}

/**
 * Resolve the active global directory.
 *
 * Migration chain:
 * 1. If `~/.fusion` exists → use it
 * 2. Else if `~/.pi/fusion` exists → rename to `~/.fusion` and use it
 * 3. Else if `~/.pi/kb` exists → rename to `~/.fusion` and use it
 * 4. Else → return `~/.fusion` (will be created on first use)
 */
export function resolveGlobalDir(dir?: string): string {
  const hasExplicitDir = typeof dir === "string" && dir.length > 0;

  if (!hasExplicitDir && process.env.VITEST === "true") {
    throw new Error(
      "resolveGlobalDir() called without explicit dir during test execution. Pass a temp directory to avoid writing to real ~/.fusion/",
    );
  }

  if (hasExplicitDir) return dir;

  const preferredDir = defaultGlobalDir();

  // Case 1: New directory already exists
  if (existsSync(preferredDir)) {
    return preferredDir;
  }

  // Case 2: Check for legacy ~/.pi/fusion directory
  const legacyDir = legacyGlobalDir();
  if (existsSync(legacyDir)) {
    try {
      mkdirSync(dirname(preferredDir), { recursive: true });
      renameSync(legacyDir, preferredDir);
      return preferredDir;
    } catch {
      return legacyDir;
    }
  }

  // Case 3: Check for original legacy ~/.pi/kb directory
  const legacyDirOriginal = legacyGlobalDirOriginal();
  if (existsSync(legacyDirOriginal)) {
    try {
      mkdirSync(dirname(preferredDir), { recursive: true });
      renameSync(legacyDirOriginal, preferredDir);
      return preferredDir;
    } catch {
      return legacyDirOriginal;
    }
  }

  // Case 4: Return the preferred directory (will be created on first use)
  return preferredDir;
}

export class GlobalSettingsStore {
  private readonly settingsPath: string;
  private readonly dir: string;

  /** Write-through cache for settings. Invalidated on every updateSettings() call. */
  private cachedSettings: GlobalSettings | null = null;

  /** Promise chain for serializing read-modify-write cycles */
  private lock: Promise<void> = Promise.resolve();

  /**
   * Create a GlobalSettingsStore.
   * @param dir — Directory to store settings.json. Defaults to `~/.fusion/`.
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
   * Read global settings. Returns cached value if available, otherwise reads
   * from disk and caches the result. This avoids repeated filesystem reads for
   * settings that are accessed frequently.
   *
   * If the file doesn't exist or is invalid, returns defaults without throwing.
   */
  async getSettings(): Promise<GlobalSettings> {
    if (this.cachedSettings !== null) {
      return this.cachedSettings;
    }
    const parsed = await this.readRaw();
    this.cachedSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...parsed } as GlobalSettings;
    return this.cachedSettings;
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
   * **Null-as-delete semantics**: Fields set to `null` in the patch are
   * explicitly deleted from the settings. This allows the frontend to clear
   * a setting by sending `null` instead of `undefined` (since JSON.stringify
   * drops `undefined` values, `null` serves as the explicit clear sentinel).
   *
   * @returns The full updated settings after merge.
   */
  async updateSettings(patch: Partial<GlobalSettings> & Record<string, unknown>): Promise<GlobalSettings> {
    return this.withLock(async () => {
      const raw = await this.readRaw();

      // Apply null-as-delete semantics: null means "remove this field"
      // Merge order: defaults → raw (disk) → patch
      // This means: patch values win, then raw, then defaults
      // But null in patch means "delete" - so we delete from raw first
      const merged: Record<string, unknown> = { ...raw };

      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          // null → delete this key from the merged object
          // This effectively makes it fall through to the default
          delete merged[key];
        } else {
          // normal value → set it
          merged[key] = value;
        }
      }

      // After merging, fill in defaults for any missing keys
      // This ensures fields that were deleted (by null) get their default value
      const withDefaults = { ...DEFAULT_GLOBAL_SETTINGS, ...merged } as GlobalSettings;

      await mkdir(this.dir, { recursive: true });
      await this.atomicWrite(withDefaults);
      // Update the write-through cache
      this.cachedSettings = withDefaults;
      return this.cachedSettings;
    });
  }

  /**
   * Get the path to the settings file (useful for diagnostics/logging).
   */
  getSettingsPath(): string {
    return this.settingsPath;
  }

  /**
   * Invalidate the in-memory cache. Forces the next getSettings() call to
   * re-read from disk. Useful for testing and edge cases where external
   * processes modify the settings file.
   */
  invalidateCache(): void {
    this.cachedSettings = null;
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Atomically write settings to disk. Writes to a temp file first,
   * then renames into place (atomic on POSIX).
   *
   * The file is written with mode 0600 (owner-only read/write) because the
   * settings object can contain secrets — specifically `daemonToken`, which
   * is a bearer credential for the HTTP API. POSIX-only; no-op on Windows.
   */
  private async atomicWrite(settings: GlobalSettings): Promise<void> {
    const tmpPath = this.settingsPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(tmpPath, this.settingsPath);
    // `writeFile` with `mode` honors umask on some platforms, so re-chmod the
    // final path to guarantee 0600. Ignore failures (Windows has no POSIX
    // permission bits; some filesystems may reject chmod).
    try {
      await chmod(this.settingsPath, 0o600);
    } catch {
      // Best effort — on Windows or filesystems without POSIX perms, the file
      // is already protected by the user's home directory ACL.
    }
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
