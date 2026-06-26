import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { DatabaseSync } from "./sqlite-adapter.js";
import { createLogger } from "./logger.js";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";

const log = createLogger("project-identity");
const PROJECT_ID_RE = /^proj_[a-f0-9]{16}$/;

/** __meta keys backing the project identity stamp. */
const META_KEY_PROJECT_ID = "projectId";
const META_KEY_PROJECT_CREATED_AT = "projectCreatedAt";

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
  const dbPath = join(resolveFusionDir(fusionDir), "fusion.db");
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
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
  const dbPath = join(resolvedFusionDir, "fusion.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const existingId = readMeta(db, "projectId");
    if (existingId && existingId !== identity.id) {
      throw new ProjectIdentityMismatchError(existingId, identity.id);
    }
    db.prepare("INSERT OR REPLACE INTO __meta (key, value) VALUES (?, ?)").run("projectId", identity.id);
    db.prepare("INSERT OR REPLACE INTO __meta (key, value) VALUES (?, ?)").run("projectCreatedAt", identity.createdAt);
  } finally {
    db?.close();
  }
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
  const rows = await layer.db
    .select({ value: schema.project.projectMeta.value })
    .from(schema.project.projectMeta)
    .where(eq(schema.project.projectMeta.key, key));
  return rows[0]?.value ?? null;
}

async function upsertMetaAsync(layer: AsyncDataLayer, key: string, value: string): Promise<void> {
  // The __meta table has a primary key on `key`; upsert via ON CONFLICT.
  await layer.db
    .insert(schema.project.projectMeta)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.project.projectMeta.key,
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
