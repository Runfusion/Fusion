import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { DatabaseSync } from "./sqlite-adapter.js";
import { createLogger } from "./logger.js";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";

const log = createLogger("project-identity");
const PROJECT_ID_RE = /^proj_[a-f0-9]{16}$/;

/** __meta keys backing the project identity stamp. */
const META_KEY_PROJECT_ID = "projectId";
const META_KEY_PROJECT_CREATED_AT = "projectCreatedAt";
export const PROJECT_IDENTITY_FILENAME = "project.json";

export type ProjectIdentity = { id: string; createdAt: string };

export class ProjectIdentityMismatchError extends Error {
  constructor(public readonly existingId: string, public readonly incomingId: string) {
    super(`Project identity mismatch: existing id ${existingId} differs from incoming id ${incomingId}`);
    this.name = "ProjectIdentityMismatchError";
  }
}

export class ProjectIdentityConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly existingPath: string,
    public readonly incomingPath: string,
  ) {
    super(
      `Project identity conflict: id ${projectId} already belongs to ${existingPath} (incoming path: ${incomingPath})`,
    );
    this.name = "ProjectIdentityConflictError";
  }
}

function resolveFusionDir(inputPath: string): string {
  return basename(inputPath) === ".fusion" ? inputPath : join(inputPath, ".fusion");
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM __meta WHERE key = ?").get(key) as { value?: string } | undefined;
  return row?.value;
}

export function readProjectIdentity(fusionDir: string): ProjectIdentity | null {
  const resolvedFusionDir = resolveFusionDir(fusionDir);
  const markerPath = join(resolvedFusionDir, PROJECT_IDENTITY_FILENAME);
  /*
   * FNXC:ProjectIdentityMarker 2026-07-14-17:10:
   * Project discovery and identity must not require opening fusion.db after the
   * PostgreSQL cutover. Prefer a small filesystem marker; read the SQLite meta
   * table only as a one-way compatibility path for pre-cutover projects.
   */
  if (existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ProjectIdentity>;
      if (typeof parsed.id !== "string" || !PROJECT_ID_RE.test(parsed.id) || typeof parsed.createdAt !== "string" || !parsed.createdAt) {
        log.warn(`Ignoring malformed project identity in ${markerPath}`);
        return null;
      }
      return { id: parsed.id, createdAt: parsed.createdAt };
    } catch (error) {
      log.warn(`Unable to read project identity from ${markerPath}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  const dbPath = join(resolvedFusionDir, "fusion.db");
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | undefined;
  try {
    /* FNXC:LegacySqliteBoundary 2026-07-14-18:42:
     * This is a one-way identity import for projects without project.json.
     * It must be read-only and must not materialize __meta in a legacy file.
     */
    db = new DatabaseSync(dbPath, { readOnly: true });
    const id = readMeta(db, "projectId");
    const createdAt = readMeta(db, "projectCreatedAt");
    if (!id || !createdAt) return null;
    if (!PROJECT_ID_RE.test(id)) {
      log.warn(`Ignoring malformed stored projectId '${id}' in ${dbPath}`);
      return null;
    }
    return { id, createdAt };
  } catch (error) {
    log.warn(`Unable to read project identity from ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    db?.close();
  }
}

export function writeProjectIdentity(fusionDir: string, identity: ProjectIdentity): void {
  if (!PROJECT_ID_RE.test(identity.id)) {
    throw new TypeError(`Invalid project identity id: ${identity.id}`);
  }

  const resolvedFusionDir = resolveFusionDir(fusionDir);
  if (!existsSync(resolvedFusionDir)) {
    mkdirSync(resolvedFusionDir, { recursive: true });
  }
  const existing = readProjectIdentity(resolvedFusionDir);
  if (existing && existing.id !== identity.id) {
    throw new ProjectIdentityMismatchError(existing.id, identity.id);
  }
  const markerPath = join(resolvedFusionDir, PROJECT_IDENTITY_FILENAME);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, markerPath);
}

/** Return true when a PostgreSQL-era marker or a legacy SQLite identity exists. */
export function hasProjectIdentity(fusionDir: string): boolean {
  return readProjectIdentity(fusionDir) !== null;
}

// ─────────────────────────────────────────────────────────────────────
// Backend-mode (PostgreSQL) project-identity helpers
//
// FNXC:MigrateProjectIdentity 2026-06-26-10:05:
// The running backend store must be able to read/write its own project
// identity without touching the local SQLite fusion.db. These async helpers
// target the same `projectId` / `projectCreatedAt` keys, but in the
// PostgreSQL `project.__meta` table via the AsyncDataLayer. They are the
// backend-mode dual of the sync local-path functions above.
//
// The central registry (`central.projects`) is the authoritative mapping of
// paths → projectIds, but the per-project `__meta` stamp is the on-disk (and
// now on-PG) marker that lets a store confirm its own identity without a
// CentralCore round-trip. In backend mode the SQLite local-path functions
// below are bypassed entirely by callers that hold the AsyncDataLayer.
// ─────────────────────────────────────────────────────────────────────

async function readMetaAsync(layer: AsyncDataLayer, key: string): Promise<string | null> {
  const projectId = layer.projectId ?? "";
  const rows = await layer.db
    .select({ value: schema.project.projectMeta.value })
    .from(schema.project.projectMeta)
    .where(and(
      eq(schema.project.projectMeta.projectId, projectId),
      eq(schema.project.projectMeta.key, key),
    ));
  return rows[0]?.value ?? null;
}

async function upsertMetaAsync(layer: AsyncDataLayer, key: string, value: string): Promise<void> {
  const projectId = layer.projectId ?? "";
  /*
  FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
  Backend identity reads and writes must use the data layer's project binding so one registered project cannot inherit or overwrite another project's PostgreSQL __meta stamp.
  */
  await layer.db
    .insert(schema.project.projectMeta)
    .values({ projectId, key, value })
    .onConflictDoUpdate({
      target: [schema.project.projectMeta.projectId, schema.project.projectMeta.key],
      set: { value },
    });
}

/**
 * FNXC:MigrateProjectIdentity 2026-06-26-10:10:
 * Read the project identity from the PostgreSQL `project.__meta` table.
 *
 * This is the backend-mode dual of {@link readProjectIdentity}: it returns the
 * same `ProjectIdentity` shape but reads the `projectId` / `projectCreatedAt`
 * keys from PostgreSQL via the AsyncDataLayer, never touching SQLite. Returns
 * `null` when the keys are absent or the stored id is malformed (mirroring the
 * sync path's fail-soft behavior).
 *
 * @param layer The AsyncDataLayer for the running backend project database.
 * @returns The identity, or null when not stored / malformed.
 */
export async function readProjectIdentityAsync(
  layer: AsyncDataLayer,
): Promise<ProjectIdentity | null> {
  try {
    const id = await readMetaAsync(layer, META_KEY_PROJECT_ID);
    const createdAt = await readMetaAsync(layer, META_KEY_PROJECT_CREATED_AT);
    if (!id || !createdAt) return null;
    if (!PROJECT_ID_RE.test(id)) {
      log.warn(`Ignoring malformed stored projectId '${id}' in PostgreSQL __meta`);
      return null;
    }
    return { id, createdAt };
  } catch (error) {
    log.warn(
      `Unable to read project identity from PostgreSQL __meta: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * FNXC:MigrateProjectIdentity 2026-06-26-10:15:
 * Write the project identity to the PostgreSQL `project.__meta` table.
 *
 * This is the backend-mode dual of {@link writeProjectIdentity}: it upserts the
 * `projectId` / `projectCreatedAt` keys into PostgreSQL via the AsyncDataLayer,
 * never touching SQLite. Like the sync path, it rejects malformed ids and
 * throws {@link ProjectIdentityMismatchError} when a different id is already
 * stamped.
 *
 * @param layer The AsyncDataLayer for the running backend project database.
 * @param identity The identity to stamp.
 */
export async function writeProjectIdentityAsync(
  layer: AsyncDataLayer,
  identity: ProjectIdentity,
): Promise<void> {
  if (!PROJECT_ID_RE.test(identity.id)) {
    throw new TypeError(`Invalid project identity id: ${identity.id}`);
  }

  const existingId = await readMetaAsync(layer, META_KEY_PROJECT_ID);
  if (existingId && existingId !== identity.id) {
    throw new ProjectIdentityMismatchError(existingId, identity.id);
  }
  await upsertMetaAsync(layer, META_KEY_PROJECT_ID, identity.id);
  await upsertMetaAsync(layer, META_KEY_PROJECT_CREATED_AT, identity.createdAt);
}
