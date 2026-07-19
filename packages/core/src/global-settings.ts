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
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import type { ConfigChangedBy, ConfigKind, ConfigurationRevision, ConfigurationTarget, GlobalSettings } from "./types.js";
import { DEFAULT_GLOBAL_SETTINGS } from "./types.js";
import { sanitizeCliAgentsSettings } from "./settings-schema.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import { GLOBAL_CONFIGURATION_OWNER_ID, appendGlobalConfigurationRevision, createConfigurationRevision, getGlobalConfigurationRevision, listGlobalConfigurationRevisions } from "./async-configuration-revision-store.js";

/*
FNXC:ConfigVersioning 2026-07-18-10:30:
Direct GlobalSettingsStore callers (CLI bootstrap and maintenance commands) do
not have a TaskStore to inject a project-bound layer. Resolve one central layer
per settings directory before a write so that path cannot silently bypass the
immutable global revision partition. Unit-only filesystem tests deliberately
remain layerless; production always initializes the central PostgreSQL layer.
*/
const directGlobalRevisionLayers = new Map<string, Promise<AsyncDataLayer>>();

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** Legacy directory for global settings (original name before rename to `.fusion`). */
export function legacyGlobalDir(): string {
  return join(getHomeDir(), ".pi", "fusion");
}

/** Legacy directory for global settings from the earliest fn version (`.pi/kb`). */
export function legacyGlobalDirOriginal(): string {
  return join(getHomeDir(), ".pi", "kb");
}

/** Default directory for global fusion settings: `~/.fusion/` */
export function defaultGlobalDir(): string {
  return join(getHomeDir(), ".fusion");
}

/** Resolve the active global directory for an explicit home directory. */
export function resolveGlobalDirForHome(homeDir: string): string {
  const preferredDir = join(homeDir, ".fusion");
  if (existsSync(preferredDir)) {
    return preferredDir;
  }

  const legacyDir = join(homeDir, ".pi", "fusion");
  if (existsSync(legacyDir)) {
    try {
      mkdirSync(dirname(preferredDir), { recursive: true });
      renameSync(legacyDir, preferredDir);
      return preferredDir;
    } catch {
      return legacyDir;
    }
  }

  const legacyDirOriginal = join(homeDir, ".pi", "kb");
  if (existsSync(legacyDirOriginal)) {
    try {
      mkdirSync(dirname(preferredDir), { recursive: true });
      renameSync(legacyDirOriginal, preferredDir);
      return preferredDir;
    } catch {
      return legacyDirOriginal;
    }
  }

  return preferredDir;
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

  if (hasExplicitDir) {
    /*
    FNXC:GlobalDirGuard 2026-06-25-22:10:
    Production code must never point the central/global store at a project's `.fusion/` directory. Doing so silently spins up a stray per-project central DB seeded with DEFAULT global settings (globalMaxConcurrent=4, empty global secrets, default centralSettings), which then shadows the real `~/.fusion/fusion-central.db` and manifests as "all my global settings reset". Root cause was call sites passing `store.getFusionDir()` instead of the resolved global dir.
    Guard heuristic: a project `.fusion` dir is named `.fusion` and lives inside a git repo (its parent has a `.git` dir or worktree file), whereas the home global dir's parent (the home dir) is not a repo. We only flag dirs that differ from the home-resolved global dir, so legitimately-threaded global dirs and test temp dirs are unaffected. Skipped under VITEST (tests pass explicit temp dirs by design).

    FNXC:GlobalDirGuard 2026-06-25-22:55:
    The heuristic is intentionally conservative but can't perfectly distinguish a project `.fusion` from a legitimately version-controlled custom global dir (e.g. a dotfiles repo with `~/dotfiles/.fusion` + `.git`). To avoid hard-crashing that rare setup, honor an explicit opt-out env var `FUSION_ALLOW_PROJECT_LOCAL_GLOBAL_DIR=true`. This is not reachable via normal production call sites (they resolve to ~/.fusion); it only matters for operators who deliberately configure a custom global dir inside a repo.

    FNXC:GlobalDirGuard 2026-06-26-06:25:
    Order matters and the home-dir comparison must be normalized:
    - Run the CHEAP, read-only checks first (basename is `.fusion` AND its parent contains a `.git`). Only if both hold do we call `resolveGlobalDirForHome()` — which can perform a one-time legacy-dir rename — so we never trigger that filesystem side effect on the hot path (every explicit-dir call, e.g. getGlobalSettingsDir() in dashboard routes, previously hit it).
    - Compare against the home global dir using normalized real paths (realpathSync when the path exists, else resolve()), so a trailing slash, doubled separator, or symlinked home dir doesn't make the legitimate home global dir look like a foreign project dir and trip the guard.
    */
    if (process.env.VITEST !== "true" && process.env.FUSION_ALLOW_PROJECT_LOCAL_GLOBAL_DIR !== "true") {
      const isFusionDirInsideRepo =
        basename(dir) === ".fusion" && existsSync(join(dirname(dir), ".git"));
      if (isFusionDirInsideRepo) {
        const homeGlobalDir = resolveGlobalDirForHome(getHomeDir());
        const normalize = (p: string): string => {
          try {
            return realpathSync.native(p);
          } catch {
            return resolve(p);
          }
        };
        if (normalize(dir) !== normalize(homeGlobalDir)) {
          throw new Error(
            `resolveGlobalDir(): refusing project-local '.fusion' directory '${dir}' for the central/global store. ` +
              "This would create a stray per-project central database seeded with default global settings and silently reset them. " +
              "Pass the resolved global dir (or omit the argument so it defaults to ~/.fusion); see TaskStore.getGlobalSettingsDir(). " +
              "If this really is your intended global dir (e.g. a version-controlled dotfiles repo), set FUSION_ALLOW_PROJECT_LOCAL_GLOBAL_DIR=true to override.",
          );
        }
      }
    }
    return dir;
  }

  return resolveGlobalDirForHome(getHomeDir());
}

export class GlobalSettingsStore {
  private readonly settingsPath: string;
  private readonly revisionIntentPath: string;
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
  constructor(dir?: string, private readonly asyncLayer?: AsyncDataLayer) {
    this.dir = resolveGlobalDir(dir);
    this.settingsPath = join(this.dir, "settings.json");
    this.revisionIntentPath = join(this.dir, "settings.json.configuration-revision-intent.json");
  }

  /** Resolve the central history partition for direct, layerless production callers. */
  private async getRevisionLayer(): Promise<AsyncDataLayer | undefined> {
    if (this.asyncLayer) return this.asyncLayer;
    // Filesystem-focused unit tests construct isolated stores without starting
    // embedded PostgreSQL. Production must never take this branch.
    if (process.env.VITEST === "true") return undefined;

    let layer = directGlobalRevisionLayers.get(this.dir);
    if (!layer) {
      layer = (async () => {
        const { CentralCore } = await import("./central-core.js");
        const central = new CentralCore(this.dir);
        await central.init();
        if (!central.asyncLayer) {
          throw new Error("Global configuration history requires the central PostgreSQL layer");
        }
        return central.asyncLayer;
      })();
      directGlobalRevisionLayers.set(this.dir, layer);
    }
    return layer;
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

  private async readRawForUpdate(): Promise<Record<string, unknown>> {
    if (!existsSync(this.settingsPath)) {
      return {};
    }

    try {
      const raw = await readFile(this.settingsPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      /*
      FNXC:SettingsPersistence 2026-06-23-00:37:
      Existing global settings must never be overwritten with defaults because a read failed. Fail closed on update so a corrupt, partially-written, or temporarily unreadable ~/.fusion/settings.json can be inspected or recovered instead of being replaced by DEFAULT_GLOBAL_SETTINGS plus the new patch.
      */
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Refusing to update global settings because ${this.settingsPath} could not be read as valid JSON: ${message}`);
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
  async updateSettings(
    patch: Partial<GlobalSettings> & Record<string, unknown>,
    changedBy: ConfigChangedBy = { kind: "human", id: "local-user" },
  ): Promise<GlobalSettings> {
    return this.withLock(async () => {
      // Obtain history before changing the file: a failed central bootstrap is
      // a failed configuration mutation, never an unversioned successful one.
      const revisionLayer = await this.getRevisionLayer();
      await this.reconcileRevisionIntent(revisionLayer);
      const raw = await this.readRawForUpdate();

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
        } else if (key === "cliAgents") {
          // Validation at the write boundary (U15, Global Settings convention):
          // unknown adapter ids and invalid fields are dropped before persist so
          // a malformed `cliAgents` payload can never reach launch resolution.
          merged[key] = sanitizeCliAgentsSettings(value);
        } else {
          // normal value → set it
          merged[key] = value;
        }
      }

      // After merging, fill in defaults for any missing keys
      // This ensures fields that were deleted (by null) get their default value
      const withDefaults = { ...DEFAULT_GLOBAL_SETTINGS, ...merged } as GlobalSettings;

      const revision = revisionLayer ? createConfigurationRevision({
        projectId: GLOBAL_CONFIGURATION_OWNER_ID,
        ownerScope: "global",
        configKind: "global-settings",
        configTarget: { scope: "user-global" },
        before: raw,
        after: withDefaults,
        changedBy,
      }) : null;
      if (!revision && revisionLayer) {
        this.cachedSettings = withDefaults;
        return this.cachedSettings;
      }
      if (revision) {
        await this.writeVersionedSnapshot(revisionLayer!, revision, raw, withDefaults as unknown as Record<string, unknown>);
      } else {
        // Isolated filesystem tests do not initialize PostgreSQL; production
        // always has a layer and therefore never takes this compatibility path.
        await mkdir(this.dir, { recursive: true });
        await this.atomicWrite(withDefaults);
      }
      this.cachedSettings = withDefaults;
      return this.cachedSettings;
    });
  }

  /** List central/global revisions newest-first for one structured target. */
  async listConfigurationRevisions(
    configKind: ConfigKind = "global-settings",
    configTarget: ConfigurationTarget = { scope: "user-global" },
    limit?: number,
  ): Promise<ConfigurationRevision[]> {
    const layer = await this.getRevisionLayer();
    if (!layer) throw new Error("Configuration history requires the PostgreSQL revision store");
    return listGlobalConfigurationRevisions(layer, configKind, configTarget, limit);
  }

  /**
   * Exactly restore a recorded user-global snapshot and record one forward
   * rollback revision. The filesystem compensation mirrors updateSettings().
   */
  async rollbackConfiguration(revisionId: string, changedBy: ConfigChangedBy = { kind: "human", id: "local-user" }): Promise<ConfigurationRevision> {
    const layer = await this.getRevisionLayer();
    if (!layer) throw new Error("Configuration rollback requires the PostgreSQL revision store");
    return this.withLock(async () => {
      const target = await getGlobalConfigurationRevision(layer, revisionId);
      if (!target || target.configKind !== "global-settings") {
        throw new Error(`Global configuration revision ${revisionId} was not found`);
      }
      const current = await this.readRawForUpdate();
      const restored = target.before as Record<string, unknown>;
      const rollback = createConfigurationRevision({
        projectId: GLOBAL_CONFIGURATION_OWNER_ID,
        ownerScope: "global",
        configKind: "global-settings",
        configTarget: target.configTarget,
        before: current,
        after: restored,
        changedBy,
        source: "rollback",
        rollbackToRevisionId: target.id,
      });
      if (!rollback) throw new Error(`Configuration revision ${revisionId} is already restored`);
      await this.writeVersionedSnapshot(layer, rollback, current, restored);
      this.cachedSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...restored } as GlobalSettings;
      return rollback;
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

  /*
  FNXC:ConfigVersioning 2026-07-18-19:00:
  The filesystem and PostgreSQL cannot share one transaction. Persist a durable
  intent before replacing settings.json so startup can finish the journal write
  after a crash, rather than leaving an unversioned successful configuration.
  */
  private async writeVersionedSnapshot(
    layer: AsyncDataLayer,
    revision: ConfigurationRevision,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.writeRevisionIntent(revision);
    try {
      await this.atomicWrite(after as GlobalSettings);
      await appendGlobalConfigurationRevision(layer, revision);
      await unlink(this.revisionIntentPath);
    } catch (error) {
      // A caught failure is compensated immediately. A process crash retains
      // the intent and is reconciled before the next mutation.
      await this.atomicWrite(before as GlobalSettings).catch(() => undefined);
      await unlink(this.revisionIntentPath).catch(() => undefined);
      throw error;
    }
  }

  private async writeRevisionIntent(revision: ConfigurationRevision): Promise<void> {
    const temporary = `${this.revisionIntentPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ revision }), { mode: 0o600 });
    await rename(temporary, this.revisionIntentPath);
  }

  private async reconcileRevisionIntent(layer: AsyncDataLayer | undefined): Promise<void> {
    if (!existsSync(this.revisionIntentPath)) return;
    if (!layer) throw new Error("Global configuration recovery requires the PostgreSQL revision store");
    const parsed = JSON.parse(await readFile(this.revisionIntentPath, "utf-8")) as { revision?: ConfigurationRevision };
    const revision = parsed.revision;
    if (!revision || revision.projectId !== GLOBAL_CONFIGURATION_OWNER_ID || revision.ownerScope !== "global") {
      throw new Error("Global configuration revision intent is invalid");
    }
    const recorded = await getGlobalConfigurationRevision(layer, revision.id);
    if (!recorded) {
      const current = await this.readRawForUpdate();
      if (JSON.stringify(current) !== JSON.stringify(revision.after)) {
        await this.atomicWrite(revision.before as GlobalSettings);
      } else {
        await appendGlobalConfigurationRevision(layer, revision);
      }
    }
    await unlink(this.revisionIntentPath);
  }

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
