/**
 * Tombstone allowlist for the U4 hard-move (KTD-5).
 *
 * `MOVED_SETTINGS_KEYS` is the single, authoritative record of the settings keys
 * that left `DEFAULT_PROJECT_SETTINGS` and now live exclusively as **workflow
 * setting values** per `(workflowId, projectId)`. It is derived directly from the
 * moved workflow declaration catalog (`BUILTIN_MOVED_WORKFLOW_SETTINGS`) so the move
 * has exactly one source of truth. Workflow-native declarations (for example
 * triage policy thresholds) are deliberately excluded from this tombstone.
 * Adding/removing a key from the moved catalog automatically reflows the
 * tombstone list, the migration write target, and the stale-writer guard.
 *
 * What the tombstone shields (KTD-5, R8):
 *   - the project/global settings WRITE paths (`updateSettings` /
 *     `updateGlobalSettings`) — incoming moved keys from stale writers are silently
 *     dropped, never persisted (they would otherwise re-materialize in raw
 *     storage and, via the default re-injection trap, silently override the
 *     migrated workflow value);
 *   - the migration's raw-key null-out (it nulls exactly these keys from the
 *     persisted project + global stores);
 *   - (in U5) settings export v2 / cross-node sync diff / v1 import.
 *
 * ── TYPE-vs-SCHEMA SPLIT (deliberate, documented per the U4 plan) ──────────────
 * The moved keys are REMOVED from `DEFAULT_PROJECT_SETTINGS` (so they vanish from
 * `PROJECT_SETTINGS_KEYS` / `isProjectSettingsKey` / the save-split), but the
 * corresponding fields are RETAINED on the `ProjectSettings` / `Settings`
 * TypeScript interfaces. This is intentional: the engine still types its ~20 flat
 * `settings.<movedKey>` read sites and the U3 effective-settings merge off
 * `Partial<Settings>`, so dropping the fields from the type would break those
 * call sites. The schema MEMBERSHIP (key lists / predicates / persistence
 * filters) is the thing that must not include moved keys — not the type shape.
 *
 * NOTE on `buildTimeoutMs`: it has NO reader anywhere in the engine, so it fails
 * the per-task-reader rule (KTD-5 / catalog-shrink) and was removed from
 * `BUILTIN_WORKFLOW_SETTINGS` entirely. It therefore stays a plain project
 * setting and is intentionally ABSENT from this list.
 */

import { BUILTIN_MOVED_WORKFLOW_SETTINGS } from "../workflows/builtin-workflow-settings.js";

/**
 * The version of the per-project settings hard-move migration. Persisted per
 * project as a `__meta` marker (`settingsMigrationVersion`). A project whose
 * marker is `>= SETTINGS_MIGRATION_VERSION` has already migrated and the runner
 * no-ops. Bump only if a future migration must re-run on already-migrated DBs.
 */
export const SETTINGS_MIGRATION_VERSION = 1;

/** The `__meta` key under which the migration marker is persisted (per project DB). */
export const SETTINGS_MIGRATION_MARKER_KEY = "settingsMigrationVersion";

/**
 * The definitive moved-key catalog — derived from the moved workflow
 * declarations so it cannot drift from them. Frozen so callers cannot mutate it.
 */
export const MOVED_SETTINGS_KEYS: readonly string[] = Object.freeze(
  BUILTIN_MOVED_WORKFLOW_SETTINGS.map((s) => s.id),
);

/** Set form for O(1) membership checks on the hot write path. */
const MOVED_SETTINGS_KEY_SET: ReadonlySet<string> = new Set(MOVED_SETTINGS_KEYS);

/** Whether `key` is a moved (tombstoned) settings key. */
export function isMovedSettingsKey(key: string): boolean {
  return MOVED_SETTINGS_KEY_SET.has(key);
}

/**
 * Return a shallow copy of `patch` with every moved (tombstoned) key removed.
 * Used by the project/global settings write paths to silently drop moved keys
 * arriving from stale writers (R8) — they must never be persisted back into the
 * raw settings store. Non-moved keys pass through untouched.
 */
export function stripMovedSettingsKeys<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!MOVED_SETTINGS_KEY_SET.has(key)) {
      out[key] = value;
    }
  }
  return out as Partial<T>;
}

/** Whether `patch` carries at least one moved key (for debug-logging the drop). */
export function patchContainsMovedKey(patch: Record<string, unknown>): boolean {
  for (const key of Object.keys(patch)) {
    if (MOVED_SETTINGS_KEY_SET.has(key)) return true;
  }
  return false;
}
