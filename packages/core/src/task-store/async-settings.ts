/**
 * Async Drizzle settings (config table) helpers (U12).
 *
 * FNXC:TaskStoreSettings 2026-06-24-15:00:
 * Async equivalents of the sync `readConfig()` / `writeConfig()` /
 * `getSettingsFast()` config-table call sites in store.ts. These target the
 * PostgreSQL `project.config` table via Drizzle and preserve the
 * project-settings read/write round-trip.
 *
 * The config table is a singleton row (id = 1, enforced by a CHECK constraint).
 * The `settings` column is jsonb in PostgreSQL (VAL-SCHEMA-004), so Drizzle
 * returns it already-parsed as a JS object — no JSON.parse needed. On write,
 * pass the JS object directly (Drizzle serializes it).
 *
 * Scope note:
 *   These helpers cover the project-level config table (settings + workflow
 *   step id). The global-settings round-trip (GlobalSettingsStore →
 *   ~/.fusion/settings.json or central DB) is handled by the satellite-store
 *   migration; the merged-settings read (global ← project) composes the project
 *   read here with the global read there. This module owns the project half.
 *
 * Transition context:
 *   The sync `readConfig()`/`writeConfig()` remain the live path until U15.
 *   These helpers are the PostgreSQL target the integration tests exercise.
 */
import { eq, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/**
 * FNXC:TaskStoreSettings 2026-06-24-15:05:
 * The project-level config row (the singleton id = 1 row). `settings` comes back
 * already-parsed (jsonb) so the consumer sees a plain object.
 */
export interface ProjectConfigRow {
  nextId: number | null;
  nextWorkflowStepId: number | null;
  // FNXC:SqliteFinalRemoval 2026-06-28: WF-id counter (was a SQLite __meta row).
  nextWorkflowDefinitionId: number | null;
  settings: Record<string, unknown> | null;
}

/** Sentinel config id (singleton row). */
export const CONFIG_ROW_ID = 1;

/**
 * Read the project config row. Returns a default empty config when the row is
 * absent (mirrors the sync `readConfig()` fallback to `{ nextId: 1 }`).
 *
 * FNXC:TaskStoreSettings 2026-06-24-15:10:
 * PostgreSQL jsonb: the `settings` column returns already-parsed (VAL-SCHEMA-004).
 */
export async function readProjectConfig(
  layer: AsyncDataLayer,
): Promise<ProjectConfigRow> {
  const rows = await layer.db
    .select({
      nextId: schema.project.config.nextId,
      nextWorkflowStepId: schema.project.config.nextWorkflowStepId,
      nextWorkflowDefinitionId: schema.project.config.nextWorkflowDefinitionId,
      settings: schema.project.config.settings,
    })
    .from(schema.project.config)
    .where(eq(schema.project.config.id, CONFIG_ROW_ID));
  const row = rows[0];
  if (!row) {
    return { nextId: 1, nextWorkflowStepId: 1, nextWorkflowDefinitionId: 1, settings: null };
  }
  return {
    nextId: row.nextId ?? 1,
    nextWorkflowStepId: row.nextWorkflowStepId ?? 1,
    nextWorkflowDefinitionId: row.nextWorkflowDefinitionId ?? 1,
    settings: (row.settings as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Read just the project-level settings object (the fast-path settings read).
 * Returns null when the config row or settings column is absent.
 */
export async function readProjectSettings(
  layer: AsyncDataLayer,
): Promise<Record<string, unknown> | null> {
  const rows = await layer.db
    .select({ settings: schema.project.config.settings })
    .from(schema.project.config)
    .where(eq(schema.project.config.id, CONFIG_ROW_ID));
  const row = rows[0];
  if (!row) {
    return null;
  }
  return (row.settings as Record<string, unknown> | null) ?? null;
}

/**
 * FNXC:TaskStoreSettings 2026-06-24-15:15:
 * Write (upsert) the project config row. The config table is a singleton
 * (id = 1), so this uses INSERT ... ON CONFLICT (id) DO UPDATE. The previous
 * `nextWorkflowStepId` is preserved when not supplied.
 *
 * `config.nextId` is deprecated legacy state (the distributed_task_id_state
 * allocator is the sole active counter). It is preserved here for parity but
 * callers should stop writing new values.
 *
 * @param layer The async data layer.
 * @param settings The project settings object (jsonb round-trip, VAL-SCHEMA-004).
 * @param options Optional nextWorkflowStepId override.
 */
export async function writeProjectConfig(
  layer: AsyncDataLayer,
  settings: Record<string, unknown>,
  options?: { nextWorkflowStepId?: number; nextWorkflowDefinitionId?: number },
): Promise<void> {
  const nowIso = new Date().toISOString();

  // Preserve the prior counters when not supplied so an unrelated write does not
  // reset the workflow-step or workflow-definition (WF-id) allocator.
  let nextWorkflowStepId = options?.nextWorkflowStepId;
  let nextWorkflowDefinitionId = options?.nextWorkflowDefinitionId;
  if (nextWorkflowStepId === undefined || nextWorkflowDefinitionId === undefined) {
    const existing = await readProjectConfig(layer);
    if (nextWorkflowStepId === undefined) nextWorkflowStepId = existing.nextWorkflowStepId ?? 1;
    if (nextWorkflowDefinitionId === undefined) nextWorkflowDefinitionId = existing.nextWorkflowDefinitionId ?? 1;
  }

  await layer.db
    .insert(schema.project.config)
    .values({
      id: CONFIG_ROW_ID,
      nextId: sql`COALESCE((SELECT next_id FROM ${schema.project.config} WHERE id = ${CONFIG_ROW_ID} LIMIT 1), 1)`,
      nextWorkflowStepId,
      nextWorkflowDefinitionId,
      settings,
      workflowSteps: [],
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: schema.project.config.id,
      set: {
        nextWorkflowStepId,
        nextWorkflowDefinitionId,
        settings,
        workflowSteps: [],
        updatedAt: nowIso,
      },
    });
}

/**
 * FNXC:TaskStoreSettings 2026-06-24-15:20:
 * Patch (top-level key merge) the project settings object without rewriting
 * the whole config row. Uses PostgreSQL jsonb concatenation (`||`) so top-level
 * keys in the patch replace the corresponding keys in the existing settings.
 * This mirrors the sync `updateProjectSettings` path that callers like the
 * settings API use.
 *
 * The patch is bound as a JSON-string parameter and cast to jsonb so Drizzle
 * serializes it safely (no string interpolation of user data).
 */
export async function patchProjectSettings(
  layer: AsyncDataLayer,
  patch: Record<string, unknown>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const patchJson = JSON.stringify(patch);
  // Ensure the row exists, then merge.
  await layer.db
    .insert(schema.project.config)
    .values({
      id: CONFIG_ROW_ID,
      nextId: 1,
      nextWorkflowStepId: 1,
      settings: patch,
      workflowSteps: [],
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: schema.project.config.id,
      set: {
        settings: sql`COALESCE(${schema.project.config.settings}, '{}'::jsonb) || (${patchJson}::jsonb)`,
        updatedAt: nowIso,
      },
    });
}
