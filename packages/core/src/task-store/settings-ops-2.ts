/**
 * settings-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Settings, GlobalSettings, ProjectSettings} from "../types.js";
import {DEFAULT_SETTINGS, isGlobalOnlySettingsKey} from "../types.js";
import {DEFAULT_PROJECT_SETTINGS} from "../settings-schema.js";
import "../builtin-traits.js";
import {resolveWorktrunkSettings} from "../worktrunk-settings.js";
import {fromJson} from "../db.js";
import {hasSyncPassphraseConfigured} from "../secrets-sync-passphrase.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {canonicalizeSettings} from "../task-store/settings-helpers.js";
import {readProjectConfig as readProjectConfigAsync, readProjectSettings as readProjectSettingsAsync} from "../task-store/async/async-settings.js";

export async function getSettingsImpl(store: TaskStore): Promise<Settings> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:20:
    // In backend mode (PostgreSQL via AsyncDataLayer), delegate to the async
    // settings helper. The config-table read goes through Drizzle; jsonb
    // columns return already-parsed (VAL-SCHEMA-004). The global-settings
    // read is shared across both paths (GlobalSettingsStore is backend-agnostic).
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const [globalSettings, projectConfig] = await Promise.all([
        store.globalSettingsStore.getSettings(),
        readProjectConfigAsync(layer),
      ]);
      const projectSettings = Object.fromEntries(
        Object.entries(projectConfig.settings ?? {}).filter(
          ([key]) => !isGlobalOnlySettingsKey(key),
        ),
      );
      const merged = {
        ...DEFAULT_SETTINGS,
        ...globalSettings,
        ...projectSettings,
        worktrunk: resolveWorktrunkSettings(
          globalSettings.worktrunk,
          (projectSettings as Partial<Settings>).worktrunk,
        ),
      };
      try {
        merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
      } catch {
        merged.secretsSyncPassphraseConfigured = false;
      }
      return canonicalizeSettings(merged);
    }
    const [globalSettings, config] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      store.readConfig(),
    ]);
    // Strip global-only keys from project-level settings so stale project-scoped
    // values don't override the correct global value during the spread merge.
    const projectSettings = Object.fromEntries(
      Object.entries(config.settings ?? {}).filter(([key]) => !isGlobalOnlySettingsKey(key)),
    );
    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(
        globalSettings.worktrunk,
        (projectSettings as Partial<Settings>).worktrunk,
      ),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }
    return canonicalizeSettings(merged);
  }

export async function getSettingsFastImpl(store: TaskStore): Promise<Settings> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:22:
    // Backend-mode fast settings read: delegate to the async settings helper
    // (readProjectSettingsAsync), which reads only the jsonb `settings` column.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const [globalSettings, projectSettingsRaw] = await Promise.all([
        store.globalSettingsStore.getSettings(),
        readProjectSettingsAsync(layer),
      ]);
      const raw = projectSettingsRaw ?? undefined;
      const projectSettings: Partial<Settings> | undefined = raw
        ? (Object.fromEntries(
            Object.entries(raw).filter(([key]) => !isGlobalOnlySettingsKey(key)),
          ) as Partial<Settings>)
        : undefined;
      const merged = {
        ...DEFAULT_SETTINGS,
        ...globalSettings,
        ...projectSettings,
        worktrunk: resolveWorktrunkSettings(
          globalSettings.worktrunk,
          projectSettings?.worktrunk,
        ),
      };
      try {
        merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
      } catch {
        merged.secretsSyncPassphraseConfigured = false;
      }
      return canonicalizeSettings(merged);
    }
    const [globalSettings, row] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      store.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);

    const raw = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    // Strip global-only keys from the project-level row so stale project-scoped
    // values (e.g. an empty experimentalFeatures={}) don't override the correct
    // global value during the spread merge below. getSettingsByScopeFast() has
    // always done this; getSettingsFast() was missing the filter.
    const projectSettings: Partial<Settings> | undefined = raw
      ? (Object.fromEntries(
          Object.entries(raw).filter(([key]) => !isGlobalOnlySettingsKey(key)),
        ) as Partial<Settings>)
      : undefined;

    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(globalSettings.worktrunk, projectSettings?.worktrunk),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }

    return canonicalizeSettings(merged);
  }

export async function getSettingsByScopeImpl(store: TaskStore): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:23:
    // Backend-mode scoped settings read: delegate project read to async helper.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const [globalSettings, projectConfig] = await Promise.all([
        store.globalSettingsStore.getSettings(),
        readProjectConfigAsync(layer),
      ]);
      try {
        globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
      } catch {
        globalSettings.secretsSyncPassphraseConfigured = false;
      }
      const projectSettings: Partial<ProjectSettings> = {};
      if (projectConfig.settings) {
        for (const key of Object.keys(projectConfig.settings)) {
          if (!isGlobalOnlySettingsKey(key)) {
            (projectSettings as Record<string, unknown>)[key] = (projectConfig.settings as Record<string, unknown>)[key];
          }
        }
      }
      const canonicalizedProject = canonicalizeSettings(projectSettings as Settings);
      if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
        canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
      }
      return { global: globalSettings, project: canonicalizedProject };
    }
    const [globalSettings, config] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      store.readConfig(),
    ]);
    try {
      globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      globalSettings.secretsSyncPassphraseConfigured = false;
    }

    // Extract only project-level keys from config.settings
    const projectSettings: Partial<ProjectSettings> = {};
    if (config.settings) {
      for (const key of Object.keys(config.settings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectSettings as Record<string, unknown>)[key] = (config.settings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization to project settings and keep upgrade-safe
    // default fallback behavior for legacy rows that omit this key.
    const canonicalizedProject = canonicalizeSettings(projectSettings as Settings);
    if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
      canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
    }

    return { global: globalSettings, project: canonicalizedProject };
  }

export async function getSettingsByScopeFastImpl(store: TaskStore): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:24:
    // Backend-mode fast scoped read: delegate to async settings helper.
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const [globalSettings, projectSettingsRaw] = await Promise.all([
        store.globalSettingsStore.getSettings(),
        readProjectSettingsAsync(layer),
      ]);
      try {
        globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
      } catch {
        globalSettings.secretsSyncPassphraseConfigured = false;
      }
      const projectSettings = projectSettingsRaw ?? undefined;
      const projectScoped: Partial<ProjectSettings> = {};
      if (projectSettings) {
        for (const key of Object.keys(projectSettings)) {
          if (!isGlobalOnlySettingsKey(key)) {
            (projectScoped as Record<string, unknown>)[key] = (projectSettings as Record<string, unknown>)[key];
          }
        }
      }
      const canonicalizedProject = canonicalizeSettings(projectScoped as Settings);
      if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
        canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
      }
      return { global: globalSettings, project: canonicalizedProject };
    }
    const [globalSettings, row] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      store.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);
    try {
      globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      globalSettings.secretsSyncPassphraseConfigured = false;
    }

    const projectSettings = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    // Extract only project-level keys from config.settings
    const projectScoped: Partial<ProjectSettings> = {};
    if (projectSettings) {
      for (const key of Object.keys(projectSettings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectScoped as Record<string, unknown>)[key] = (projectSettings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization and keep upgrade-safe default fallback behavior
    // for legacy rows that omit this key.
    const canonicalizedProject = canonicalizeSettings(projectScoped as Settings);
    if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
      canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
    }

    return { global: globalSettings, project: canonicalizedProject };
  }

