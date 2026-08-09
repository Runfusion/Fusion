/**
 * settings-ops operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import type {BoardConfig, Settings, GlobalSettings, ConfigChangedBy} from "../types.js";
import { CONFIG_CHANGED_BY_SYSTEM } from "../types.js";
import {DEFAULT_SETTINGS, isGlobalOnlySettingsKey} from "../types.js";
import {MOVED_SETTINGS_KEYS, stripMovedSettingsKeys, patchContainsMovedKey} from "../config/moved-settings.js";
import "../builtin-traits.js";
import {validateLocale, assertWorktreeNamingRecycleExclusive} from "../config/settings-validation.js";
import {hasSyncPassphraseConfigured} from "../secrets/secrets-sync-passphrase.js";
import {ensureMemoryFileWithBackend} from "../memory/project-memory.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {canonicalizeSettings, isPlainObject, deepMergeWithNullDelete} from "../task-store/settings-helpers.js";
import {readProjectConfig as readProjectConfigAsync, writeProjectConfig as writeProjectConfigAsync} from "../task-store/async/async-settings.js";
import {appendConfigurationRevision, createConfigurationRevision} from "../async-stores/async-configuration-revision-store.js";
import {isValidProviderInstanceId} from "../provider-instance.js";

/*
 * FNXC:CredentialInstanceSelection 2026-08-01-05:38:
 * Settings authoring validates persisted-but-inert credential instance ids before either project
 * or global persistence. Nested presets are atomic: one malformed element rejects the whole write.
 */
/**
 * FNXC:TaskRecommendations 2026-08-08-05:02:
 * Reject an invalid project cap atomically rather than coercing an executor's
 * completion policy. Zero deliberately disables recommendations; 1..20 bounds
 * retained operator-visible suggestions.
 */
function assertValidRecommendationSettingsPatch(patch: Record<string, unknown>): void {
  const value = patch.maxRecommendationsPerTask;
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error("maxRecommendationsPerTask must be an integer between 0 and 20");
  }
}

function assertValidCredentialInstanceSettingsPatch(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key.endsWith("CredentialInstanceId") || key === "defaultCredentialInstanceIdOverride") {
      if (value !== null && value !== undefined && !isValidProviderInstanceId(value)) {
        throw new Error(`invalid credential instance id for settings key '${key}'`);
      }
    }
  }
  if (patch.modelPresets !== null && patch.modelPresets !== undefined) {
    if (!Array.isArray(patch.modelPresets)) throw new Error("modelPresets must be an array");
    for (const [index, preset] of patch.modelPresets.entries()) {
      if (typeof preset !== "object" || preset === null) throw new Error(`modelPresets[${index}] must be an object`);
      for (const key of ["executorCredentialInstanceId", "validatorCredentialInstanceId"] as const) {
        const value = (preset as Record<string, unknown>)[key];
        if (value !== undefined && !isValidProviderInstanceId(value)) {
          throw new Error(`invalid credential instance id for modelPresets[${index}].${key}`);
        }
      }
    }
  }
}

/** Publish committed setting snapshots and run the normal post-commit effects. */
export async function publishSettingsUpdated(store: TaskStore, previous: Settings, settings: Settings): Promise<void> {
  /* FNXC:ConfigVersioning 2026-07-18-14:20: rollback is an observable settings replacement, so it must use the same post-commit notification/effects seam as a forward mutation. */
  store.emit("settings:updated", { settings, previous });
  if (settings.memoryEnabled !== false && previous.memoryEnabled === false) {
    try { await ensureMemoryFileWithBackend(store.rootDir, settings); }
    catch (err) { storeLog.warn("Project-memory bootstrap failed after memory toggle-on", { phase: "updateSettings:memory-toggle-on", rootDir: store.rootDir, error: err instanceof Error ? err.message : String(err) }); }
  }
}

export async function updateSettingsImpl(store: TaskStore, patch: Partial<Settings>, changedBy: ConfigChangedBy = CONFIG_CHANGED_BY_SYSTEM): Promise<Settings> {
    assertValidRecommendationSettingsPatch(patch as Record<string, unknown>);
    assertValidCredentialInstanceSettingsPatch(patch as Record<string, unknown>);
    /*
    FNXC:ConfigVersioning 2026-07-18-12:15:
    Keep the compatibility SQLite settings path writable while projects migrate
    to PostgreSQL. Backend-mode writes journal atomically below; rejecting a
    long-supported local write before its existing persistence seam is a
    compatibility regression.
    */
    /*
    FNXC:ConfigVersioning 2026-07-18-19:10:
    SQLite cannot atomically store a configuration snapshot with this mutation.
    Reject legacy project setting writes before side effects rather than claim a
    rollback guarantee that the compatibility backend cannot provide.
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: project configuration changes always use PostgreSQL revision store. */

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
    /*
    FNXC:WorkflowAgentRouting 2026-08-09-01:04:
    FN-8847 rejects the retired ephemeralAgentsEnabled client patch before the configuration
    revision transaction. Canonicalization also removes stale stored copies, while active
    ephemeral task-creation policy fields keep their normal project-setting behavior.
    */
    // Filter out global-only and retired project fields before writing a configuration revision.
    const projectPatch: Partial<Settings> = {};
    for (const [key, value] of Object.entries(guardedPatch)) {
      if (!isGlobalOnlySettingsKey(key) && key !== "ephemeralAgentsEnabled") {
        (projectPatch as Record<string, unknown>)[key] = value;
      }
    }

    return store.withConfigLock(async () => {
      /*
      FNXC:SqliteDualPathCleanup 2026-07-26-14:30:
      updateSettings is PostgreSQL-only (asyncLayer transaction + configuration revision). The store.readConfigFast / writeConfig SQLite arm is deleted. Side effects (evacuate, memory, workspace) run via publishSettingsUpdated after commit.
      FNXC:RuntimePersistenceAsync 2026-06-24-10:28: promptOverrides merge and null-delete semantics unchanged.
      */
      const layer = store.asyncLayer!;
      const transactionResult = await layer.transactionImmediate(async (tx) => {
        const projectConfig = await readProjectConfigAsync(layer, tx);
        const config: BoardConfig = {
          nextId: projectConfig.nextId ?? 1,
          settings: (projectConfig.settings ?? {}) as Settings,
        };
        /*
        FNXC:ConfigVersioning 2026-07-18-01:00:
        Preserve the raw project snapshot before null-delete and prompt override
        normalization mutate config.settings. Rollback must restore keys removed
        by the patch, not a reference already changed in-place.
        */
        const beforeProjectSettings = structuredClone(config.settings);

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
        const previousMerged = canonicalizeSettings({ ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings);
        const updatedProjectSettings = canonicalizeSettings({ ...config.settings, ...projectPatch } as Settings);
        // FNXC:TaskPinnedWorktrees 2026-07-16-00:00: reject recycleWorktrees + worktreeNaming:"task-id"
        // (mutually exclusive) against the resolved next state BEFORE persisting the invalid combination.
        assertWorktreeNamingRecycleExclusive({ ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings);
        /*
        FNXC:ConfigVersioning 2026-07-18-00:00:
        The project settings write and immutable revision share this existing
        immediate transaction. A failed revision insert therefore rolls back the
        target mutation instead of exposing an unversioned successful change.
        */
        await writeProjectConfigAsync(layer, updatedProjectSettings as Record<string, unknown>, undefined, tx);
        const revision = createConfigurationRevision({
          projectId: layer.projectId ?? "",
          ownerScope: "project",
          configKind: "project-settings",
          configTarget: { projectId: layer.projectId ?? "" },
          before: beforeProjectSettings,
          after: updatedProjectSettings,
          changedBy,
        });
        if (revision) await appendConfigurationRevision(tx, revision);
        const updatedMerged = canonicalizeSettings({ ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings);
        // Do not publish changes from within the transaction: a revision insert
        // or commit failure must remain invisible to listeners and side effects.
        return { previousMerged, updatedMerged };
      });

      /*
      FNXC:ConfigVersioning 2026-07-18-11:00:
      Configuration observers and filesystem follow-up work run only after the
      target-plus-revision transaction commits. A failed journal append must
      not make a rolled-back setting observable as a successful update.
      */
      await publishSettingsUpdated(store, transactionResult.previousMerged, transactionResult.updatedMerged);
      return transactionResult.updatedMerged;
    });
  }

export async function updateGlobalSettingsImpl(store: TaskStore, patch: Partial<GlobalSettings>, changedBy: ConfigChangedBy = CONFIG_CHANGED_BY_SYSTEM): Promise<Settings> {
    assertValidCredentialInstanceSettingsPatch(patch as Record<string, unknown>);
    // Read previous state BEFORE writing so the diff is correct
    const previousGlobal = await store.globalSettingsStore.getSettings();
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * In backend mode, read config via async helper instead of store.readConfigFast()
     * which uses store.db (SQLite).
     */
    const projectConfig = await readProjectConfigAsync(store.asyncLayer!);
    const config: BoardConfig = {
      nextId: projectConfig.nextId ?? 1,
      settings: (projectConfig.settings ?? {}) as Settings,
    };

    const previous: Settings = { ...DEFAULT_SETTINGS, ...previousGlobal, ...config.settings } as Settings;

    // Stale-writer guard (U4, R8): moved keys are all project-scoped, but null
    // them defensively out of the global write path too so a stale writer cannot
    // resurrect them in the global store.
    const globalPatch: Partial<GlobalSettings> = patchContainsMovedKey(patch as Record<string, unknown>)
      ? (stripMovedSettingsKeys(patch as Record<string, unknown>) as Partial<GlobalSettings>)
      : { ...patch };
    delete globalPatch.secretsSyncPassphraseConfigured;
    /*
    FNXC:TaskRecommendations 2026-08-08-06:11:
    Recommendation volume is a project policy, never a user-global preference. Runtime callers can
    bypass TypeScript with a JSON patch, so reject this project-only key at the global persistence
    boundary instead of allowing one project's completion cap to leak into every project.
    */
    delete (globalPatch as Record<string, unknown>).maxRecommendationsPerTask;

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

    const updatedGlobal = await store.globalSettingsStore.updateSettings(globalPatch, changedBy);
    const merged: Settings = { ...DEFAULT_SETTINGS, ...updatedGlobal, ...config.settings } as Settings;
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }

    // Emit settings:updated so SSE listeners pick up the change
    store.emit("settings:updated", { settings: merged, previous });

    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
    The #1409 `workflowColumns` ON→OFF evacuation hook is DELETED from both settings
    write paths.

    CORRECTED (PR #2500 review — greptile P1). An earlier draft of this note claimed the
    ON→OFF transition was unreachable because no production writer sets the key. That is
    wrong: `settings-schema.ts` explicitly TOLERATES stale persisted values, so a project
    upgraded from a version where this was a real toggle can carry
    `experimentalFeatures.workflowColumns: true`, and a settings import or configuration
    rollback can then flip it to false. The transition is reachable. It is the EVACUATION
    that is wrong, not the trigger.

    Post-cutover the evacuation is a destructive reposition, not a repair. It moved cards
    OUT of columns their own workflow legitimately declares and into the legacy `triage`
    column. It existed to protect the legacy enum BOARD, which could only render the six
    legacy ids — and that board is deleted in this same change, so the thing it protected
    is gone.

    The stranding it guarded against does not occur either: `moves.ts` resolves a
    NON-LEGACY source column's targets from the task's own workflow adjacency on the
    flag-OFF path (the FN-7591 carve-out), so a card in a custom column still moves.
    `src/__tests__/coding-ideas-move.test.ts` proves this in the production shape — it
    never writes the flag — covering the forward chain and the non-adjacent rejection.
    And `reconcileUndeclaredTaskColumns` correctly leaves such a card alone: its workflow
    DECLARES its column, so there is nothing undeclared to reconcile.
    */
    return merged;
  }

