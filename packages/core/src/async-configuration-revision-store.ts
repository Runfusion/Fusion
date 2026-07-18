import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "./postgres/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";

type QueryHandle = AsyncDataLayer["db"] | DbTransaction;
import type {
  ConfigChangedBy,
  ConfigKind,
  ConfigurationOwnerScope,
  ConfigurationRevision,
  ConfigurationTarget,
  RevisionFieldDiff,
} from "./types.js";

/** Reserved partition for user-global ~/.fusion/settings.json history. */
export const GLOBAL_CONFIGURATION_OWNER_ID = "__fusion_global_configuration__";

/** Canonical target encoding avoids ambiguous delimiter-concatenated identities. */
export function configurationTargetKey(target: ConfigurationTarget): string {
  return JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))));
}

export function diffConfigurationSnapshots(before: unknown, after: unknown): RevisionFieldDiff[] {
  const beforeObject = before && typeof before === "object" && !Array.isArray(before) ? before as Record<string, unknown> : { value: before };
  const afterObject = after && typeof after === "object" && !Array.isArray(after) ? after as Record<string, unknown> : { value: after };
  const fields = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
  return [...fields].sort().flatMap((field) =>
    JSON.stringify(beforeObject[field]) === JSON.stringify(afterObject[field])
      ? []
      : [{ field, oldValue: beforeObject[field], newValue: afterObject[field] }],
  );
}

export function createConfigurationRevision(input: {
  projectId: string;
  ownerScope: ConfigurationOwnerScope;
  configKind: ConfigKind;
  configTarget: ConfigurationTarget;
  before: unknown;
  after: unknown;
  changedBy: ConfigChangedBy;
  source?: "mutation" | "rollback";
  rollbackToRevisionId?: string;
  createdAt?: string;
}): ConfigurationRevision | null {
  const diffs = diffConfigurationSnapshots(input.before, input.after);
  if (diffs.length === 0) return null;
  return {
    id: randomUUID(),
    projectId: input.projectId,
    ownerScope: input.ownerScope,
    configKind: input.configKind,
    configTarget: input.configTarget,
    configTargetKey: configurationTargetKey(input.configTarget),
    before: input.before,
    after: input.after,
    diffs,
    changedBy: input.changedBy,
    source: input.source ?? "mutation",
    rollbackToRevisionId: input.rollbackToRevisionId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function appendConfigurationRevision(handle: QueryHandle, revision: ConfigurationRevision): Promise<void> {
  await handle.insert(schema.project.configurationRevisions).values({
    projectId: revision.projectId,
    id: revision.id,
    ownerScope: revision.ownerScope,
    configKind: revision.configKind,
    configTarget: revision.configTarget,
    configTargetKey: revision.configTargetKey,
    before: revision.before,
    after: revision.after,
    diffs: revision.diffs,
    changedBy: revision.changedBy,
    source: revision.source,
    rollbackToRevisionId: revision.rollbackToRevisionId ?? null,
    createdAt: revision.createdAt,
  });
}

/**
 * Write user-global history through a transaction-local RLS bypass, never by
 * pretending the global owner belongs to the project-bound runtime layer.
 */
export async function appendGlobalConfigurationRevision(
  layer: AsyncDataLayer,
  revision: ConfigurationRevision,
): Promise<void> {
  if (revision.projectId !== GLOBAL_CONFIGURATION_OWNER_ID || revision.ownerScope !== "global") {
    throw new Error("Global configuration revisions require the reserved global owner");
  }
  await layer.transactionImmediate(async (tx) => {
    /* FNXC:ConfigVersioning 2026-07-18-01:00: global history is a central partition and must bypass caller-project RLS only for this revision transaction. */
    await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'on', true)`);
    await appendConfigurationRevision(tx, revision);
  });
}

export async function getGlobalConfigurationRevision(
  layer: AsyncDataLayer,
  id: string,
): Promise<ConfigurationRevision | null> {
  return layer.transactionImmediate(async (tx) => {
    await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'on', true)`);
    return getConfigurationRevision(tx, GLOBAL_CONFIGURATION_OWNER_ID, id);
  });
}

/**
 * Enumerate central user-global history through the same narrowly scoped RLS
 * bypass as append/get. Consumers must never infer this partition from their
 * current project identity.
 */
export async function listGlobalConfigurationRevisions(
  layer: AsyncDataLayer,
  configKind: ConfigKind,
  configTarget: ConfigurationTarget,
  limit?: number,
): Promise<ConfigurationRevision[]> {
  return layer.transactionImmediate(async (tx) => {
    /* FNXC:ConfigVersioning 2026-07-18-02:00: global history listing is privileged only for the reserved central owner, matching the writer and preserving newest-first target filtering. */
    await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'on', true)`);
    return listConfigurationRevisions(tx, {
      projectId: GLOBAL_CONFIGURATION_OWNER_ID,
      configKind,
      configTarget,
      limit,
    });
  });
}

export async function listConfigurationRevisions(handle: QueryHandle, params: {
  projectId: string;
  configKind: ConfigKind;
  configTarget: ConfigurationTarget;
  limit?: number;
}): Promise<ConfigurationRevision[]> {
  const rows = await handle.select().from(schema.project.configurationRevisions).where(and(
    eq(schema.project.configurationRevisions.projectId, params.projectId),
    eq(schema.project.configurationRevisions.configKind, params.configKind),
    eq(schema.project.configurationRevisions.configTargetKey, configurationTargetKey(params.configTarget)),
  /* FNXC:ConfigVersioning 2026-07-18-14:00: createdAt has only millisecond precision; sequence preserves newest-first order for serialized same-millisecond mutations. */
  )).orderBy(desc(schema.project.configurationRevisions.createdAt), desc(schema.project.configurationRevisions.sequence)).limit(params.limit ?? 100);
  return rows.map((row) => ({ ...row, configTarget: row.configTarget as ConfigurationTarget, before: row.before, after: row.after, diffs: row.diffs as RevisionFieldDiff[], changedBy: row.changedBy as ConfigChangedBy, ownerScope: row.ownerScope as ConfigurationOwnerScope, configKind: row.configKind as ConfigKind, source: row.source as "mutation" | "rollback", rollbackToRevisionId: row.rollbackToRevisionId ?? undefined }));
}

export async function getConfigurationRevision(handle: QueryHandle, projectId: string, id: string): Promise<ConfigurationRevision | null> {
  const rows = await handle.select().from(schema.project.configurationRevisions).where(and(eq(schema.project.configurationRevisions.projectId, projectId), eq(schema.project.configurationRevisions.id, id))).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, configTarget: row.configTarget as ConfigurationTarget, before: row.before, after: row.after, diffs: row.diffs as RevisionFieldDiff[], changedBy: row.changedBy as ConfigChangedBy, ownerScope: row.ownerScope as ConfigurationOwnerScope, configKind: row.configKind as ConfigKind, source: row.source as "mutation" | "rollback", rollbackToRevisionId: row.rollbackToRevisionId ?? undefined };
}

/**
 * Execute an exact snapshot replacement and write the resulting forward
 * rollback revision through the same transaction handle. The resource owner
 * supplies the raw read/replace pair because only it knows whether absence is
 * represented by a missing row (routine/automation) or missing JSON keys.
 */
export async function rollbackConfiguration(
  handle: QueryHandle,
  projectId: string,
  revisionId: string,
  changedBy: ConfigChangedBy,
  snapshot: { readCurrent(): Promise<unknown>; replace(before: unknown): Promise<void> },
): Promise<ConfigurationRevision> {
  const target = await getConfigurationRevision(handle, projectId, revisionId);
  if (!target) throw new Error(`Configuration revision ${revisionId} was not found for its owner scope`);
  const current = await snapshot.readCurrent();
  const rollback = createConfigurationRevision({
    projectId,
    ownerScope: target.ownerScope,
    configKind: target.configKind,
    configTarget: target.configTarget,
    before: current,
    after: target.before,
    changedBy,
    source: "rollback",
    rollbackToRevisionId: target.id,
  });
  if (!rollback) {
    throw new Error(`Configuration revision ${revisionId} is already restored`);
  }
  // Reject no-op rollbacks before calling the resource writer: a writer may
  // still touch timestamps even when the snapshot content is unchanged.
  await snapshot.replace(target.before);
  await appendConfigurationRevision(handle, rollback);
  return rollback;
}
