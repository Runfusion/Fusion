import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "./sqlite-adapter.js";
import { createLogger } from "./logger.js";

const log = createLogger("project-identity");
const PROJECT_ID_RE = /^proj_[a-f0-9]{16}$/;

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
