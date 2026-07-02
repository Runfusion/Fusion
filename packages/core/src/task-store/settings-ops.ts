/**
 * settings-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, isWorkflowColumnsCompatibilityFlagEnabled} from "../store.js";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {detectWorkspaceRepos, saveWorkspaceConfig, loadWorkspaceConfig} from "../git-repository.js";
import type {BoardConfig, Settings, GlobalSettings} from "../types.js";
import {DEFAULT_SETTINGS, isGlobalOnlySettingsKey} from "../types.js";
import {MOVED_SETTINGS_KEYS, stripMovedSettingsKeys, patchContainsMovedKey} from "../moved-settings.js";
import "../builtin-traits.js";
import {validateLocale} from "../settings-validation.js";
import {hasSyncPassphraseConfigured} from "../secrets-sync-passphrase.js";
import {ensureMemoryFileWithBackend} from "../project-memory.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {isPlainObject, deepMergeWithNullDelete} from "../task-store/settings-helpers.js";
import {readProjectConfig as readProjectConfigAsync, writeProjectConfig as writeProjectConfigAsync} from "../task-store/async-settings.js";

export async function updateSettingsImpl(store: TaskStore, patch: Partial<Settings>): Promise<Settings> {
    // Stale-writer guard (U4, R8): moved keys no longer live in project settings —
    // they belong to workflow setting values. Drop any moved key arriving from a
    // stale writer/import so it is never persisted back into raw storage (where the
    // default re-injection trap would silently override the migrated value).
    const guardedPatch =
      patchContainsMovedKey(patch as Record<string, unknown>)
        ? (() => {
            storeLog.warn("Dropped moved settings keys from project updateSettings patch", {
              phase: "updateSettings:moved-key-guard",
              dropped: Object.keys(patch).filter((k) => (MOVED_SETTINGS_KEYS as readonly string[]).includes(k)),
            });
            return stripMovedSettingsKeys(patch as Record<string, unknown>) as Partial<Settings>;
          })()
        : patch;

    // Filter out global-only fields — they should go through updateGlobalSettings()
    const projectPatch: Partial<Settings> = {};
    for (const [key, value] of Object.entries(guardedPatch)) {
      if (!isGlobalOnlySettingsKey(key)) {
        (projectPatch as Record<string, unknown>)[key] = value;
      }
    }

    return store.withConfigLock(async () => {
      // FNXC:RuntimePersistenceAsync 2026-06-24-10:28:
      // In backend mode, read/write the config table via the async helpers
      // instead of the sync SQLite path. The business logic (promptOverrides
      // merge, null-delete semantics) is identical across backends.
      if (store.backendMode) {
        const layer = store.asyncLayer!;
        const projectConfig = await readProjectConfigAsync(layer);
        const config: BoardConfig = {
          nextId: projectConfig.nextId ?? 1,
          settings: (projectConfig.settings ?? {}) as Settings,
        };

        const incomingPromptOverrides = (projectPatch as Record<string, unknown>)["promptOverrides"];
        if (incomingPromptOverrides === null) {
          delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
          delete (projectPatch as Record<string, unknown>)["promptOverrides"];
        } else if (
          incomingPromptOverrides !== undefined &&
          typeof incomingPromptOverrides === "object" &&
          incomingPromptOverrides !== null
        ) {
          const incomingMap = incomingPromptOverrides as Record<string, unknown>;
          const existingMap = ((config.settings as unknown as Record<string, unknown>)["promptOverrides"] as Record<string, string>) ?? {};
          const mergedMap: Record<string, string> = { ...existingMap };
          for (const [key, value] of Object.entries(incomingMap)) {
            if (value === null) {
              delete mergedMap[key];
            } else if (typeof value === "string" && value !== "") {
              mergedMap[key] = value;
            }
          }
          if (Object.keys(mergedMap).length === 0) {
            delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
            delete (projectPatch as Record<string, unknown>)["promptOverrides"];
          } else {
            (config.settings as unknown as Record<string, unknown>)["promptOverrides"] = mergedMap;
            (projectPatch as Record<string, unknown>)["promptOverrides"] = mergedMap;
          }
        }

        for (const key of Object.keys(projectPatch)) {
          if ((projectPatch as Record<string, unknown>)[key] === null) {
            delete (config.settings as unknown as Record<string, unknown>)[key];
            delete (projectPatch as Record<string, unknown>)[key];
          }
        }

        const globalSettings = await store.globalSettingsStore.getSettings();
        const previousMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings;
        const updatedProjectSettings = { ...config.settings, ...projectPatch };
        // Write the full updated settings object back via the async helper.
        await writeProjectConfigAsync(layer, updatedProjectSettings as Record<string, unknown>);
        const updatedMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings;
        store.emit("settings:updated", { settings: updatedMerged, previous: previousMerged });

        if (isWorkflowColumnsCompatibilityFlagEnabled(previousMerged) && !isWorkflowColumnsCompatibilityFlagEnabled(updatedMerged)) {
          try {
            await store.evacuateCustomColumnsToLegacy("flag-toggled-off");
          } catch (err) {
            storeLog.warn("workflowColumns ON→OFF evacuation failed", {
              phase: "evacuate-custom-columns",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (updatedMerged.memoryEnabled !== false && previousMerged.memoryEnabled === false) {
          try {
            await ensureMemoryFileWithBackend(store.rootDir, updatedMerged);
          } catch (err) {
            storeLog.warn("Project-memory bootstrap failed after memory toggle-on", {
              phase: "updateSettings:memory-toggle-on",
              rootDir: store.rootDir,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return updatedMerged;
      }

      const config = store.readConfigFast();

      // Handle null values as "delete this key from settings"
      // This allows the frontend to explicitly clear a setting by sending null
      // (since JSON.stringify drops undefined keys, we use null as a sentinel)

      // Handle special null-as-delete semantics for promptOverrides
      const incomingPromptOverrides = (projectPatch as Record<string, unknown>)["promptOverrides"];
      if (incomingPromptOverrides === null) {
        // promptOverrides: null → clear the entire promptOverrides object
        delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
        delete (projectPatch as Record<string, unknown>)["promptOverrides"];
      } else if (
        incomingPromptOverrides !== undefined &&
        typeof incomingPromptOverrides === "object" &&
        incomingPromptOverrides !== null
      ) {
        // promptOverrides: { key: value } → merge with existing, treating null values as delete
        const incomingMap = incomingPromptOverrides as Record<string, unknown>;
        const existingMap = ((config.settings as unknown as Record<string, unknown>)["promptOverrides"] as Record<string, string>) ?? {};
        const mergedMap: Record<string, string> = { ...existingMap };

        for (const [key, value] of Object.entries(incomingMap)) {
          if (value === null) {
            // null → delete this specific key
            delete mergedMap[key];
          } else if (typeof value === "string" && value !== "") {
            // non-empty string → set this key
            // Empty strings are treated as "clear" and not stored
            mergedMap[key] = value;
          }
          // Empty strings are silently ignored (treated as "clear")
        }

        // If merged map is empty, remove the entire promptOverrides
        if (Object.keys(mergedMap).length === 0) {
          delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
          delete (projectPatch as Record<string, unknown>)["promptOverrides"];
        } else {
          (config.settings as unknown as Record<string, unknown>)["promptOverrides"] = mergedMap;
          (projectPatch as Record<string, unknown>)["promptOverrides"] = mergedMap;
        }
      }

      // Handle null values for other top-level keys (non-promptOverrides)
      for (const key of Object.keys(projectPatch)) {
        if ((projectPatch as Record<string, unknown>)[key] === null) {
          delete (config.settings as unknown as Record<string, unknown>)[key];
          delete (projectPatch as Record<string, unknown>)[key];
        }
      }

      const globalSettings = await store.globalSettingsStore.getSettings();
      const previousMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings;
      const updatedProjectSettings = { ...config.settings, ...projectPatch };
      config.settings = updatedProjectSettings as Settings;
      await store.writeConfig(config);
      const updatedMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings;
      store.emit("settings:updated", { settings: updatedMerged, previous: previousMerged });

      // #1409: if this update flipped workflowColumns ON→OFF, evacuate any card
      // stranded in a custom (non-legacy) column back to a legacy column so the
      // board stays listable / movable on the legacy path.
      if (isWorkflowColumnsCompatibilityFlagEnabled(previousMerged) && !isWorkflowColumnsCompatibilityFlagEnabled(updatedMerged)) {
        try {
          await store.evacuateCustomColumnsToLegacy("flag-toggled-off");
        } catch (err) {
          storeLog.warn("workflowColumns ON→OFF evacuation failed", {
            phase: "evacuate-custom-columns",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Bootstrap project memory file when memory is toggled on
      if (updatedMerged.memoryEnabled !== false && previousMerged.memoryEnabled === false) {
        try {
          // Use backend-aware bootstrap to honor memoryBackendType setting
          await ensureMemoryFileWithBackend(store.rootDir, updatedMerged);
        } catch (err) {
          // Non-fatal — memory bootstrap failure should not block settings update
          storeLog.warn("Project-memory bootstrap failed after memory toggle-on", {
            phase: "updateSettings:memory-toggle-on",
            rootDir: store.rootDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      /*
      FNXC:Workspace 2026-06-24-16:00:
      When workspaceMode is toggled on, detect sub-repos and persist workspace.json so the
      executor and ensureGitRepositoryForProjectPath treat the root as workspace-mode. When
      toggled off, remove workspace.json so the root falls back to single-repo behavior.
      */
      if (updatedMerged.workspaceMode === true && previousMerged.workspaceMode !== true) {
        try {
          const existing = await loadWorkspaceConfig(store.rootDir);
          if (!existing) {
            const repos = await detectWorkspaceRepos(store.rootDir);
            if (repos.length > 0) {
              await saveWorkspaceConfig(store.rootDir, { repos });
            }
          }
        } catch (err) {
          storeLog.warn("workspace.json sync failed after workspaceMode toggle-on", {
            phase: "updateSettings:workspace-toggle-on",
            rootDir: store.rootDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (updatedMerged.workspaceMode === false && previousMerged.workspaceMode === true) {
        try {
          await rm(join(store.rootDir, ".fusion", "workspace.json"), { force: true });
        } catch (err) {
          storeLog.warn("workspace.json removal failed after workspaceMode toggle-off", {
            phase: "updateSettings:workspace-toggle-off",
            rootDir: store.rootDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return updatedMerged;
    });
  }

export async function updateGlobalSettingsImpl(store: TaskStore, patch: Partial<GlobalSettings>): Promise<Settings> {
    // Read previous state BEFORE writing so the diff is correct
    const previousGlobal = await store.globalSettingsStore.getSettings();
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * In backend mode, read config via async helper instead of store.readConfigFast()
     * which uses store.db (SQLite).
     */
    let config: BoardConfig;
    if (store.backendMode) {
      const projectConfig = await readProjectConfigAsync(store.asyncLayer!);
      config = {
        nextId: projectConfig.nextId ?? 1,
        settings: (projectConfig.settings ?? {}) as Settings,
      };
    } else {
      config = store.readConfigFast();
    }
    const previous: Settings = { ...DEFAULT_SETTINGS, ...previousGlobal, ...config.settings } as Settings;

    // Stale-writer guard (U4, R8): moved keys are all project-scoped, but null
    // them defensively out of the global write path too so a stale writer cannot
    // resurrect them in the global store.
    const globalPatch: Partial<GlobalSettings> = patchContainsMovedKey(patch as Record<string, unknown>)
      ? (stripMovedSettingsKeys(patch as Record<string, unknown>) as Partial<GlobalSettings>)
      : { ...patch };
    delete globalPatch.secretsSyncPassphraseConfigured;

    // Handle deep merge + targeted null clear semantics for remoteAccess
    const incomingRemoteAccess = (globalPatch as Record<string, unknown>)["remoteAccess"];
    if (incomingRemoteAccess === null) {
      (globalPatch as Record<string, unknown>)["remoteAccess"] = null;
    } else if (isPlainObject(incomingRemoteAccess)) {
      const existingRemoteAccess = (previousGlobal as Record<string, unknown>)["remoteAccess"];
      const mergedRemoteAccess = deepMergeWithNullDelete(existingRemoteAccess, incomingRemoteAccess);

      if (mergedRemoteAccess === undefined) {
        (globalPatch as Record<string, unknown>)["remoteAccess"] = null;
      } else {
        (globalPatch as Record<string, unknown>)["remoteAccess"] = mergedRemoteAccess;
      }
    }

    // Handle experimentalFeatures merging (similar to promptOverrides)
    const incomingExperimentalFeatures = (globalPatch as Record<string, unknown>)["experimentalFeatures"];
    if (incomingExperimentalFeatures === null) {
      (globalPatch as Record<string, unknown>)["experimentalFeatures"] = null;
    } else if (
      incomingExperimentalFeatures !== undefined &&
      typeof incomingExperimentalFeatures === "object" &&
      !Array.isArray(incomingExperimentalFeatures)
    ) {
      const incomingMap = incomingExperimentalFeatures as Record<string, unknown>;
      const existingMap = ((previousGlobal as Record<string, unknown>)["experimentalFeatures"] as Record<string, boolean>) ?? {};
      const mergedMap: Record<string, boolean> = { ...existingMap };

      for (const [key, value] of Object.entries(incomingMap)) {
        if (value === null) {
          delete mergedMap[key];
        } else if (typeof value === "boolean") {
          mergedMap[key] = value;
        }
      }

      (globalPatch as Record<string, unknown>)["experimentalFeatures"] = mergedMap;
    }

    // Validate the optional UI locale at the write boundary: drop unrecognized
    // values rather than persisting junk into settings.json. Runtime consumers
    // also guard via isLocale, but the contract is `language?: Locale`.
    // `null` passes through intact — GlobalSettingsStore treats null as
    // "delete this key", which reverts the language to runtime auto-detect.
    if ("language" in globalPatch) {
      const rawLanguage = (globalPatch as Record<string, unknown>)["language"];
      if (rawLanguage !== null) {
        const validatedLanguage = validateLocale(rawLanguage);
        if (validatedLanguage === undefined) {
          delete (globalPatch as Record<string, unknown>)["language"];
        } else {
          globalPatch.language = validatedLanguage;
        }
      }
    }

    const updatedGlobal = await store.globalSettingsStore.updateSettings(globalPatch);
    const merged: Settings = { ...DEFAULT_SETTINGS, ...updatedGlobal, ...config.settings } as Settings;
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }

    // Emit settings:updated so SSE listeners pick up the change
    store.emit("settings:updated", { settings: merged, previous });

    // #1409: workflowColumns lives in experimentalFeatures (a global key), so the
    // ON→OFF toggle flows through here. Evacuate any card stranded in a custom
    // column when the flag flips off.
    if (isWorkflowColumnsCompatibilityFlagEnabled(previous) && !isWorkflowColumnsCompatibilityFlagEnabled(merged)) {
      try {
        await store.evacuateCustomColumnsToLegacy("flag-toggled-off");
      } catch (err) {
        storeLog.warn("workflowColumns ON→OFF evacuation failed", {
          phase: "evacuate-custom-columns",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return merged;
  }

