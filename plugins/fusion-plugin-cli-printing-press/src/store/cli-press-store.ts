import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { postgresSchema, type AsyncDataLayer, type Database } from "@fusion/core";
import {
  InvalidCredentialPlacementError,
  OAuthNotSupportedError,
  type CliArtifact,
  type CliArtifactCreateInput,
  type CliArtifactUpdateInput,
  type CliSpec,
  type CliSpecCreateInput,
  type CliSpecUpdateInput,
  type Credential,
  type CredentialCreateInput,
  type CredentialUpdateInput,
  type Service,
  type ServiceCreateInput,
  type ServiceSetting,
  type ServiceSettingCreateInput,
  type ServiceUpdateInput,
} from "./cli-press-types.js";

// Plugin-owned table shapes, materialized in PostgreSQL by the
// cliPressPluginSchemaInit hook (packages/core/src/postgres/plugin-schema-hook.ts)
// and re-exported via the `postgresSchema.plugin` namespace from @fusion/core.
const {
  cliPressServices,
  cliPressSpecs,
  cliPressArtifacts,
  cliPressCredentials,
  cliPressSettings,
} = postgresSchema.plugin;

interface ServiceRow {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  baseUrl: string;
  sourceKind: Service["sourceKind"];
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CliSpecRow {
  id: string;
  serviceId: string;
  name: string;
  version: string;
  generatorVersion: string;
  specJson: string;
  generatedAt: string | null;
  status: CliSpec["status"];
  lastGenerationError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CliArtifactRow {
  id: string;
  cliSpecId: string;
  kind: CliArtifact["kind"];
  path: string;
  executable: number | boolean;
  checksum: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CredentialRow {
  id: string;
  serviceId: string;
  name: string;
  kind: Credential["kind"];
  value: string;
  placement: string;
  createdAt: string;
  updatedAt: string;
}

interface ServiceSettingRow {
  id: string;
  serviceId: string;
  key: string;
  value: string;
  scope: ServiceSetting["scope"];
  createdAt: string;
  updatedAt: string;
}

const OAUTH_KINDS = new Set(["oauth", "oauth2"]);

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: "svc" | "cli" | "art" | "cred" | "set"): string {
  return `${prefix}_${randomUUID()}`;
}

function assertCredentialSupported(kind: string): void {
  if (OAUTH_KINDS.has(kind)) {
    throw new OAuthNotSupportedError(kind);
  }
}

function assertPlacementConsistency(
  kind: Credential["kind"] | string,
  placement: Credential["placement"] | { kind?: string; header?: string; queryParam?: string },
): void {
  const placementKind = (placement as { kind?: string }).kind;
  if (placementKind !== kind) {
    throw new InvalidCredentialPlacementError({ credentialKind: kind, placementKind: String(placementKind) });
  }
  if (kind === "api_key") {
    const candidate = placement as { kind?: string; header?: string; queryParam?: string };
    const hasHeader = typeof candidate.header === "string" && candidate.header.trim().length > 0;
    const hasQuery = typeof candidate.queryParam === "string" && candidate.queryParam.trim().length > 0;
    if ((hasHeader ? 1 : 0) + (hasQuery ? 1 : 0) !== 1) {
      throw new InvalidCredentialPlacementError({ credentialKind: kind, placementKind: String(placementKind) });
    }
  }
}

/**
 * Dual-mode CliPressStore contract. Every method is async: in SQLite mode the
 * implementation awaits the synchronous better-sqlite3 call (resolves on the
 * next microtask); in PostgreSQL (backend) mode it awaits a Drizzle query
 * against the plugin-owned tables. Callers therefore `await` uniformly.
 */
export interface CliPressStore {
  listServices(): Promise<Service[]>;
  getService(id: string): Promise<Service | undefined>;
  createService(input: ServiceCreateInput): Promise<Service>;
  updateService(id: string, updates: ServiceUpdateInput): Promise<Service>;
  deleteService(id: string): Promise<void>;
  listSpecs(serviceId: string): Promise<CliSpec[]>;
  getSpec(id: string): Promise<CliSpec | undefined>;
  createSpec(input: CliSpecCreateInput): Promise<CliSpec>;
  updateSpec(id: string, updates: CliSpecUpdateInput): Promise<CliSpec>;
  deleteSpec(id: string): Promise<void>;
  listArtifacts(specId: string): Promise<CliArtifact[]>;
  createArtifact(input: CliArtifactCreateInput): Promise<CliArtifact>;
  updateArtifact(id: string, updates: CliArtifactUpdateInput): Promise<CliArtifact>;
  deleteArtifact(id: string): Promise<void>;
  listCredentials(serviceId: string): Promise<Credential[]>;
  createCredential(input: CredentialCreateInput): Promise<Credential>;
  updateCredential(id: string, updates: CredentialUpdateInput): Promise<Credential>;
  deleteCredential(id: string): Promise<void>;
  listSettings(serviceId: string): Promise<ServiceSetting[]>;
  setSetting(input: ServiceSettingCreateInput): Promise<ServiceSetting>;
  deleteSetting(id: string): Promise<void>;
}

export function ensureCliPressSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_press_services (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      description TEXT,
      baseUrl TEXT NOT NULL,
      sourceKind TEXT NOT NULL,
      sourceRef TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_press_cli_specs (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      generatorVersion TEXT NOT NULL,
      specJson TEXT NOT NULL,
      generatedAt TEXT,
      status TEXT NOT NULL,
      lastGenerationError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, name)
    );

    CREATE TABLE IF NOT EXISTS cli_press_artifacts (
      id TEXT PRIMARY KEY,
      cliSpecId TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      executable INTEGER NOT NULL,
      checksum TEXT,
      sizeBytes INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (cliSpecId) REFERENCES cli_press_cli_specs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cli_press_credentials (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      placement TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, name)
    );

    CREATE TABLE IF NOT EXISTS cli_press_service_settings (
      id TEXT PRIMARY KEY,
      serviceId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (serviceId) REFERENCES cli_press_services(id) ON DELETE CASCADE,
      UNIQUE(serviceId, key, scope)
    );

    CREATE INDEX IF NOT EXISTS idx_cli_press_specs_service ON cli_press_cli_specs(serviceId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_artifacts_spec ON cli_press_artifacts(cliSpecId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_credentials_service ON cli_press_credentials(serviceId);
    CREATE INDEX IF NOT EXISTS idx_cli_press_settings_service ON cli_press_service_settings(serviceId);
  `);
}

function mapService(row: ServiceRow): Service {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? undefined,
    baseUrl: row.baseUrl,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSpec(row: CliSpecRow): CliSpec {
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    version: row.version,
    generatorVersion: row.generatorVersion,
    specJson: row.specJson,
    generatedAt: row.generatedAt ?? undefined,
    status: row.status,
    lastGenerationError: row.lastGenerationError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapArtifact(row: CliArtifactRow): CliArtifact {
  return {
    id: row.id,
    cliSpecId: row.cliSpecId,
    kind: row.kind,
    path: row.path,
    executable: Boolean(row.executable),
    checksum: row.checksum ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCredential(row: CredentialRow): Credential {
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    kind: row.kind,
    value: parseJson(row.value),
    placement: parseJson(row.placement),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapSetting(row: ServiceSettingRow): ServiceSetting {
  return {
    id: row.id,
    serviceId: row.serviceId,
    key: row.key,
    value: row.value,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Construct a dual-mode CliPressStore.
 *
 * @param db SQLite Database for legacy (non-backend) mode, or null in backend mode.
 * @param asyncLayer The AsyncDataLayer (PostgreSQL/Drizzle) for backend mode, or
 *   null/omitted in legacy SQLite mode. When provided, every method routes to a
 *   Drizzle query against the plugin-owned tables (materialized by the
 *   cliPressPluginSchemaInit hook); the SQLite path is never touched.
 */
export function createCliPressStore(db: Database | null, asyncLayer?: AsyncDataLayer | null): CliPressStore {
  // FNXC:PostgresCutover 2026-07-04-00:00:
  // Dual-mode: SQLite (db) for legacy, asyncLayer (PostgreSQL/Drizzle) for
  // backend mode. Tables materialize via the plugin schema-init hook in PG, so
  // no DDL-on-first-use is needed here. In legacy mode the SQLite schema is
  // ensured defensively (mirrors the onSchemaInit hook for tests/early use).
  if (db) ensureCliPressSchema(db);
  const syncDb = (): Database => {
    if (!db) throw new Error("CliPressStore: sync Database is null (backend mode)");
    return db;
  };

  return {
    async listServices(): Promise<Service[]> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressServices)
          .orderBy(desc(cliPressServices.createdAt));
        return rows.map(mapService);
      }
      const rows = syncDb().prepare("SELECT * FROM cli_press_services ORDER BY createdAt DESC").all() as unknown as ServiceRow[];
      return rows.map(mapService);
    },

    async getService(id: string): Promise<Service | undefined> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressServices)
          .where(eq(cliPressServices.id, id))
          .limit(1);
        return rows[0] ? mapService(rows[0]) : undefined;
      }
      const row = syncDb().prepare("SELECT * FROM cli_press_services WHERE id = ?").get(id) as unknown as ServiceRow | undefined;
      return row ? mapService(row) : undefined;
    },

    async createService(input: ServiceCreateInput): Promise<Service> {
      const service: Service = { id: createId("svc"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.insert(cliPressServices).values({
          id: service.id,
          slug: service.slug,
          displayName: service.displayName,
          description: service.description ?? null,
          baseUrl: service.baseUrl,
          sourceKind: service.sourceKind,
          sourceRef: service.sourceRef ?? null,
          createdAt: service.createdAt,
          updatedAt: service.updatedAt,
        });
        return service;
      }
      syncDb().prepare(`INSERT INTO cli_press_services (id, slug, displayName, description, baseUrl, sourceKind, sourceRef, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(service.id, service.slug, service.displayName, service.description ?? null, service.baseUrl, service.sourceKind, service.sourceRef ?? null, service.createdAt, service.updatedAt);
      syncDb().bumpLastModified();
      return service;
    },

    async updateService(id: string, updates: ServiceUpdateInput): Promise<Service> {
      const existing = await this.getService(id);
      if (!existing) throw new Error(`Service ${id} not found`);
      const updated: Service = { ...existing, ...updates, id: existing.id, slug: existing.slug, createdAt: existing.createdAt, updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.update(cliPressServices).set({
          displayName: updated.displayName,
          description: updated.description ?? null,
          baseUrl: updated.baseUrl,
          sourceKind: updated.sourceKind,
          sourceRef: updated.sourceRef ?? null,
          updatedAt: updated.updatedAt,
        }).where(eq(cliPressServices.id, id));
        return updated;
      }
      syncDb().prepare(`UPDATE cli_press_services SET displayName = ?, description = ?, baseUrl = ?, sourceKind = ?, sourceRef = ?, updatedAt = ? WHERE id = ?`)
        .run(updated.displayName, updated.description ?? null, updated.baseUrl, updated.sourceKind, updated.sourceRef ?? null, updated.updatedAt, id);
      syncDb().bumpLastModified();
      return updated;
    },

    async deleteService(id: string): Promise<void> {
      if (asyncLayer) {
        // FK ON DELETE CASCADE removes child specs/artifacts/credentials/settings.
        await asyncLayer.db.delete(cliPressServices).where(eq(cliPressServices.id, id));
        return;
      }
      syncDb().transaction(() => {
        syncDb().prepare("DELETE FROM cli_press_services WHERE id = ?").run(id);
      });
      syncDb().bumpLastModified();
    },

    async listSpecs(serviceId: string): Promise<CliSpec[]> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressSpecs)
          .where(eq(cliPressSpecs.serviceId, serviceId))
          .orderBy(desc(cliPressSpecs.createdAt));
        return rows.map(mapSpec);
      }
      const rows = syncDb().prepare("SELECT * FROM cli_press_cli_specs WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as CliSpecRow[];
      return rows.map(mapSpec);
    },

    async getSpec(id: string): Promise<CliSpec | undefined> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressSpecs)
          .where(eq(cliPressSpecs.id, id))
          .limit(1);
        return rows[0] ? mapSpec(rows[0]) : undefined;
      }
      const row = syncDb().prepare("SELECT * FROM cli_press_cli_specs WHERE id = ?").get(id) as unknown as CliSpecRow | undefined;
      return row ? mapSpec(row) : undefined;
    },

    async createSpec(input: CliSpecCreateInput): Promise<CliSpec> {
      const spec: CliSpec = { id: createId("cli"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.insert(cliPressSpecs).values({
          id: spec.id,
          serviceId: spec.serviceId,
          name: spec.name,
          version: spec.version,
          generatorVersion: spec.generatorVersion,
          specJson: spec.specJson,
          generatedAt: spec.generatedAt ?? null,
          status: spec.status,
          lastGenerationError: spec.lastGenerationError ?? null,
          createdAt: spec.createdAt,
          updatedAt: spec.updatedAt,
        });
        return spec;
      }
      syncDb().prepare(`INSERT INTO cli_press_cli_specs (id, serviceId, name, version, generatorVersion, specJson, generatedAt, status, lastGenerationError, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(spec.id, spec.serviceId, spec.name, spec.version, spec.generatorVersion, spec.specJson, spec.generatedAt ?? null, spec.status, spec.lastGenerationError ?? null, spec.createdAt, spec.updatedAt);
      syncDb().bumpLastModified();
      return spec;
    },

    async updateSpec(id: string, updates: CliSpecUpdateInput): Promise<CliSpec> {
      const existing = await this.getSpec(id);
      if (!existing) throw new Error(`Spec ${id} not found`);
      const updated: CliSpec = { ...existing, ...updates, id: existing.id, serviceId: existing.serviceId, createdAt: existing.createdAt, updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.update(cliPressSpecs).set({
          name: updated.name,
          version: updated.version,
          generatorVersion: updated.generatorVersion,
          specJson: updated.specJson,
          generatedAt: updated.generatedAt ?? null,
          status: updated.status,
          lastGenerationError: updated.lastGenerationError ?? null,
          updatedAt: updated.updatedAt,
        }).where(eq(cliPressSpecs.id, id));
        return updated;
      }
      syncDb().prepare(`UPDATE cli_press_cli_specs SET name=?, version=?, generatorVersion=?, specJson=?, generatedAt=?, status=?, lastGenerationError=?, updatedAt=? WHERE id=?`)
        .run(updated.name, updated.version, updated.generatorVersion, updated.specJson, updated.generatedAt ?? null, updated.status, updated.lastGenerationError ?? null, updated.updatedAt, id);
      syncDb().bumpLastModified();
      return updated;
    },

    async deleteSpec(id: string): Promise<void> {
      if (asyncLayer) {
        await asyncLayer.db.delete(cliPressSpecs).where(eq(cliPressSpecs.id, id));
        return;
      }
      syncDb().prepare("DELETE FROM cli_press_cli_specs WHERE id = ?").run(id);
      syncDb().bumpLastModified();
    },

    async listArtifacts(specId: string): Promise<CliArtifact[]> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressArtifacts)
          .where(eq(cliPressArtifacts.cliSpecId, specId))
          .orderBy(desc(cliPressArtifacts.createdAt));
        return rows.map(mapArtifact);
      }
      const rows = syncDb().prepare("SELECT * FROM cli_press_artifacts WHERE cliSpecId = ? ORDER BY createdAt DESC").all(specId) as unknown as CliArtifactRow[];
      return rows.map(mapArtifact);
    },

    async createArtifact(input: CliArtifactCreateInput): Promise<CliArtifact> {
      const artifact: CliArtifact = { id: createId("art"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.insert(cliPressArtifacts).values({
          id: artifact.id,
          cliSpecId: artifact.cliSpecId,
          kind: artifact.kind,
          path: artifact.path,
          executable: artifact.executable,
          checksum: artifact.checksum ?? null,
          sizeBytes: artifact.sizeBytes ?? null,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
        });
        return artifact;
      }
      syncDb().prepare(`INSERT INTO cli_press_artifacts (id, cliSpecId, kind, path, executable, checksum, sizeBytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(artifact.id, artifact.cliSpecId, artifact.kind, artifact.path, artifact.executable ? 1 : 0, artifact.checksum ?? null, artifact.sizeBytes ?? null, artifact.createdAt, artifact.updatedAt);
      syncDb().bumpLastModified();
      return artifact;
    },

    async updateArtifact(id: string, updates: CliArtifactUpdateInput): Promise<CliArtifact> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressArtifacts)
          .where(eq(cliPressArtifacts.id, id))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw new Error(`Artifact ${id} not found`);
        const updated: CliArtifact = {
          ...mapArtifact(existing),
          ...updates,
          id: existing.id,
          cliSpecId: existing.cliSpecId,
          createdAt: existing.createdAt,
          updatedAt: nowIso(),
        };
        await asyncLayer.db.update(cliPressArtifacts).set({
          path: updated.path,
          executable: updated.executable,
          checksum: updated.checksum ?? null,
          sizeBytes: updated.sizeBytes ?? null,
          updatedAt: updated.updatedAt,
        }).where(eq(cliPressArtifacts.id, id));
        return updated;
      }
      const existing = syncDb().prepare("SELECT * FROM cli_press_artifacts WHERE id = ?").get(id) as unknown as CliArtifactRow | undefined;
      if (!existing) throw new Error(`Artifact ${id} not found`);
      const updated = { ...mapArtifact(existing), ...updates, id: existing.id, cliSpecId: existing.cliSpecId, createdAt: existing.createdAt, updatedAt: nowIso() };
      syncDb().prepare("UPDATE cli_press_artifacts SET path=?, executable=?, checksum=?, sizeBytes=?, updatedAt=? WHERE id=?")
        .run(updated.path, updated.executable ? 1 : 0, updated.checksum ?? null, updated.sizeBytes ?? null, updated.updatedAt, id);
      syncDb().bumpLastModified();
      return updated;
    },

    async deleteArtifact(id: string): Promise<void> {
      if (asyncLayer) {
        await asyncLayer.db.delete(cliPressArtifacts).where(eq(cliPressArtifacts.id, id));
        return;
      }
      syncDb().prepare("DELETE FROM cli_press_artifacts WHERE id = ?").run(id);
      syncDb().bumpLastModified();
    },

    async listCredentials(serviceId: string): Promise<Credential[]> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressCredentials)
          .where(eq(cliPressCredentials.serviceId, serviceId))
          .orderBy(desc(cliPressCredentials.createdAt));
        return rows.map(mapCredential);
      }
      const rows = syncDb().prepare("SELECT * FROM cli_press_credentials WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as CredentialRow[];
      return rows.map(mapCredential);
    },

    async createCredential(input: CredentialCreateInput): Promise<Credential> {
      assertCredentialSupported(input.kind);
      assertPlacementConsistency(input.kind, input.placement);
      const cred: Credential = { id: createId("cred"), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      if (asyncLayer) {
        await asyncLayer.db.insert(cliPressCredentials).values({
          id: cred.id,
          serviceId: cred.serviceId,
          name: cred.name,
          kind: cred.kind,
          value: JSON.stringify(cred.value),
          placement: JSON.stringify(cred.placement),
          createdAt: cred.createdAt,
          updatedAt: cred.updatedAt,
        });
        return cred;
      }
      syncDb().prepare(`INSERT INTO cli_press_credentials (id, serviceId, name, kind, value, placement, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cred.id, cred.serviceId, cred.name, cred.kind, JSON.stringify(cred.value), JSON.stringify(cred.placement), cred.createdAt, cred.updatedAt);
      syncDb().bumpLastModified();
      return cred;
    },

    async updateCredential(id: string, updates: CredentialUpdateInput): Promise<Credential> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressCredentials)
          .where(eq(cliPressCredentials.id, id))
          .limit(1);
        const existing = rows[0];
        if (!existing) throw new Error(`Credential ${id} not found`);
        const mapped = mapCredential(existing);
        const updated: Credential = {
          ...mapped,
          ...updates,
          id: mapped.id,
          serviceId: mapped.serviceId,
          kind: mapped.kind,
          createdAt: mapped.createdAt,
          updatedAt: nowIso(),
        };
        assertCredentialSupported(updated.kind);
        assertPlacementConsistency(updated.kind, updated.placement);
        await asyncLayer.db.update(cliPressCredentials).set({
          name: updated.name,
          value: JSON.stringify(updated.value),
          placement: JSON.stringify(updated.placement),
          updatedAt: updated.updatedAt,
        }).where(eq(cliPressCredentials.id, id));
        return updated;
      }
      const existing = syncDb().prepare("SELECT * FROM cli_press_credentials WHERE id = ?").get(id) as unknown as CredentialRow | undefined;
      if (!existing) throw new Error(`Credential ${id} not found`);
      const mapped = mapCredential(existing);
      const updated: Credential = {
        ...mapped,
        ...updates,
        id: mapped.id,
        serviceId: mapped.serviceId,
        kind: mapped.kind,
        createdAt: mapped.createdAt,
        updatedAt: nowIso(),
      };
      assertCredentialSupported(updated.kind);
      assertPlacementConsistency(updated.kind, updated.placement);
      syncDb().prepare("UPDATE cli_press_credentials SET name=?, value=?, placement=?, updatedAt=? WHERE id=?")
        .run(updated.name, JSON.stringify(updated.value), JSON.stringify(updated.placement), updated.updatedAt, id);
      syncDb().bumpLastModified();
      return updated;
    },

    async deleteCredential(id: string): Promise<void> {
      if (asyncLayer) {
        await asyncLayer.db.delete(cliPressCredentials).where(eq(cliPressCredentials.id, id));
        return;
      }
      syncDb().prepare("DELETE FROM cli_press_credentials WHERE id = ?").run(id);
      syncDb().bumpLastModified();
    },

    async listSettings(serviceId: string): Promise<ServiceSetting[]> {
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressSettings)
          .where(eq(cliPressSettings.serviceId, serviceId))
          .orderBy(desc(cliPressSettings.createdAt));
        return rows.map(mapSetting);
      }
      const rows = syncDb().prepare("SELECT * FROM cli_press_service_settings WHERE serviceId = ? ORDER BY createdAt DESC").all(serviceId) as unknown as ServiceSettingRow[];
      return rows.map(mapSetting);
    },

    async setSetting(input: ServiceSettingCreateInput): Promise<ServiceSetting> {
      const now = nowIso();
      if (asyncLayer) {
        const rows = await asyncLayer.db
          .select()
          .from(cliPressSettings)
          .where(and(eq(cliPressSettings.serviceId, input.serviceId), eq(cliPressSettings.key, input.key), eq(cliPressSettings.scope, input.scope)))
          .limit(1);
        const existing = rows[0];
        if (existing) {
          await asyncLayer.db.update(cliPressSettings).set({ value: input.value, updatedAt: now }).where(eq(cliPressSettings.id, existing.id));
          return mapSetting({ ...existing, value: input.value, updatedAt: now });
        }
        const setting: ServiceSetting = { id: createId("set"), ...input, createdAt: now, updatedAt: now };
        await asyncLayer.db.insert(cliPressSettings).values({
          id: setting.id,
          serviceId: setting.serviceId,
          key: setting.key,
          value: setting.value,
          scope: setting.scope,
          createdAt: setting.createdAt,
          updatedAt: setting.updatedAt,
        });
        return setting;
      }
      const existing = syncDb().prepare("SELECT * FROM cli_press_service_settings WHERE serviceId = ? AND key = ? AND scope = ?")
        .get(input.serviceId, input.key, input.scope) as unknown as ServiceSettingRow | undefined;
      if (existing) {
        syncDb().prepare("UPDATE cli_press_service_settings SET value = ?, updatedAt = ? WHERE id = ?").run(input.value, now, existing.id);
        syncDb().bumpLastModified();
        return mapSetting({ ...existing, value: input.value, updatedAt: now });
      }
      const setting: ServiceSetting = { id: createId("set"), ...input, createdAt: now, updatedAt: now };
      syncDb().prepare(`INSERT INTO cli_press_service_settings (id, serviceId, key, value, scope, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(setting.id, setting.serviceId, setting.key, setting.value, setting.scope, setting.createdAt, setting.updatedAt);
      syncDb().bumpLastModified();
      return setting;
    },

    async deleteSetting(id: string): Promise<void> {
      if (asyncLayer) {
        await asyncLayer.db.delete(cliPressSettings).where(eq(cliPressSettings.id, id));
        return;
      }
      syncDb().prepare("DELETE FROM cli_press_service_settings WHERE id = ?").run(id);
      syncDb().bumpLastModified();
    },
  };
}
