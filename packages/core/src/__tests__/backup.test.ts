import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupManager,
  createBackupManager,
  resolveBackendConnectionString,
  type BackupOptions,
} from "../backup/backup.js";
import {
  detectRestoredSchemaRewindFloor,
  reconcileRestoredSchemaMigrations,
  reconciliationPostgresSsl,
  RESTORED_SCHEMA_RELATION_SENTINELS,
  type RestoreMigrationCatalog,
} from "../postgres/restore-migration-reconcile.js";
import {
  AGENT_RATING_PROJECT_ISOLATION_VERSION,
  AGENT_RATINGS_PROJECT_PARTITION_VERSION,
  ANALYTICS_ISOLATION_SCHEMA_VERSION,
  BIGINT_COUNTERS_VERSION,
  AUTOMATION_ISOLATION_SCHEMA_VERSION,
  CHAT_SESSION_PINS_VERSION,
  CONFIGURATION_REVISIONS_VERSION,
  CREDENTIAL_INSTANCE_SELECTION_VERSION,
  MESSAGE_ARCHIVE_SCHEMA_VERSION,
  MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION,
  MULTI_PROJECT_CUTOVER_SCHEMA_VERSION,
  OWNER_PROJECT_ID_SPLIT_VERSION,
  PROJECT_OWNERSHIP_SCHEMA_VERSION,
  SPEC_LOCK_SOURCE_REVISION_BIGINT_VERSION,
  SYMBOL_LOCKS_SCHEMA_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
  TASK_REQUIRE_PLAN_APPROVAL_VERSION,
  TASK_VERIFICATION_REQUEST_VERSION,
} from "../postgres/schema-applier.js";
import {
  clearActiveEmbeddedRuntimeUrl,
  EmbeddedRuntimeStoppingError,
  getActiveEmbeddedRuntimeUrl,
  invalidateEmbeddedRuntimeUrl,
  registerEmbeddedRuntimeUrl,
  releaseEmbeddedRuntimeLease,
} from "../postgres/active-backend-registry.js";

function pgUrl(password: string, user = "user", host = "localhost", port = 5432, database = "fusion"): string {
  return ["postgresql://", user, ":", password, "@", host, ":", String(port), "/", database].join("");
}

const embeddedUrl = pgUrl("embedded-secret", "postgres", "127.0.0.1", 55432);
const externalUrl = pgUrl("external-secret", "operator", "db.example.test");

afterEach(() => {
  clearActiveEmbeddedRuntimeUrl();
  vi.unstubAllEnvs();
});

function columnKey(relation: string, column: string): string {
  return `${relation}.${column}`;
}

function expectedPrimaryKey(relation: string): readonly string[] | null {
  const match = RESTORED_SCHEMA_RELATION_SENTINELS
    .flatMap((sentinel) => [...(sentinel.primaryKeys ?? [])])
    .find((entry) => entry.relation === relation);
  return match ? match.columns : null;
}

function expectedColumnType(relation: string, column: string): string | null {
  const match = RESTORED_SCHEMA_RELATION_SENTINELS
    .flatMap((sentinel) => [...(sentinel.columnTypes ?? [])])
    .find((entry) => entry.relation === relation && entry.column === column);
  return match ? match.dataType : null;
}

function expectedNamedObjects(
  kind: "triggers" | "policies" | "indexes",
  relation: string,
): string[] {
  return RESTORED_SCHEMA_RELATION_SENTINELS
    .flatMap((sentinel) => [...(sentinel[kind] ?? [])])
    .filter((entry) => entry.relation === relation)
    .map((entry) => entry.name);
}

function namedObjectKey(relation: string, name: string): string {
  return `${relation}\0${name}`;
}

function createRestoreCatalog(
  presentRelations: readonly string[] = [],
  presentColumns: ReadonlyArray<{ relation: string; column: string }> = [],
  presentPrimaryKeys: ReadonlyArray<{ relation: string; columns: readonly string[] }> = [],
  presentColumnTypes: ReadonlyArray<{ relation: string; column: string; dataType: string }> = [],
  extras: {
    triggers?: ReadonlyArray<{ relation: string; name: string }>;
    policies?: ReadonlyArray<{ relation: string; name: string }>;
    indexes?: ReadonlyArray<{ relation: string; name: string }>;
    rlsForced?: readonly string[];
  } = {},
): RestoreMigrationCatalog & {
  insertLifecycleSeq(projectId: string): Promise<void>;
  insertConfigurationRevision(): Promise<void>;
  hasApplied(version: string): boolean;
  failReplayWith?: Error;
} {
  const relations = new Set(presentRelations);
  const columns = new Set(presentColumns.map((entry) => columnKey(entry.relation, entry.column)));
  const primaryKeys = new Map<string, readonly string[]>(
    presentPrimaryKeys.map((entry) => [entry.relation, entry.columns]),
  );
  const columnTypes = new Map<string, string>(
    presentColumnTypes.map((entry) => [columnKey(entry.relation, entry.column), entry.dataType]),
  );
  const triggerOverride = extras.triggers !== undefined;
  const policyOverride = extras.policies !== undefined;
  const indexOverride = extras.indexes !== undefined;
  const rlsForcedOverride = extras.rlsForced !== undefined;
  const triggers = new Set((extras.triggers ?? []).map((entry) => namedObjectKey(entry.relation, entry.name)));
  const policies = new Set((extras.policies ?? []).map((entry) => namedObjectKey(entry.relation, entry.name)));
  const indexes = new Set((extras.indexes ?? []).map((entry) => namedObjectKey(entry.relation, entry.name)));
  const rlsForced = new Set(extras.rlsForced ?? []);
  const applied = new Set(RESTORED_SCHEMA_RELATION_SENTINELS.map((sentinel) => sentinel.version));
  const catalog: RestoreMigrationCatalog & {
    insertLifecycleSeq(projectId: string): Promise<void>;
    insertConfigurationRevision(): Promise<void>;
    hasApplied(version: string): boolean;
    failReplayWith?: Error;
  } = {
    async relationExists(qualifiedName) {
      return relations.has(qualifiedName);
    },
    async columnExists(qualifiedRelation, column) {
      return columns.has(columnKey(qualifiedRelation, column));
    },
    async columnDataType(qualifiedRelation, column) {
      const key = columnKey(qualifiedRelation, column);
      if (columnTypes.has(key)) return columnTypes.get(key)!;
      if (!columns.has(key)) return null;
      return expectedColumnType(qualifiedRelation, column);
    },
    async primaryKeyColumns(qualifiedRelation) {
      if (primaryKeys.has(qualifiedRelation)) return [...primaryKeys.get(qualifiedRelation)!];
      const expected = expectedPrimaryKey(qualifiedRelation);
      return expected ? [...expected] : null;
    },
    async triggerExists(qualifiedRelation, triggerName) {
      if (triggerOverride) return triggers.has(namedObjectKey(qualifiedRelation, triggerName));
      return expectedNamedObjects("triggers", qualifiedRelation).includes(triggerName);
    },
    async policyExists(qualifiedRelation, policyName) {
      if (policyOverride) return policies.has(namedObjectKey(qualifiedRelation, policyName));
      return expectedNamedObjects("policies", qualifiedRelation).includes(policyName);
    },
    async indexExists(qualifiedRelation, indexName) {
      if (indexOverride) return indexes.has(namedObjectKey(qualifiedRelation, indexName));
      return expectedNamedObjects("indexes", qualifiedRelation).includes(indexName);
    },
    async rowLevelSecurityForced(qualifiedRelation) {
      if (rlsForcedOverride) return rlsForced.has(qualifiedRelation);
      return RESTORED_SCHEMA_RELATION_SENTINELS
        .flatMap((sentinel) => [...(sentinel.forcedRowLevelSecurity ?? [])])
        .includes(qualifiedRelation);
    },
    async applyRewindAndReplay(floor) {
      const snapshotApplied = new Set(applied);
      const snapshotRelations = new Set(relations);
      const snapshotColumns = new Set(columns);
      const snapshotPrimaryKeys = new Map(primaryKeys);
      const snapshotColumnTypes = new Map(columnTypes);
      const snapshotTriggers = new Set(triggers);
      const snapshotPolicies = new Set(policies);
      const snapshotIndexes = new Set(indexes);
      const snapshotRlsForced = new Set(rlsForced);
      try {
        if (floor) {
          const parsedFloor = Number.parseInt(floor, 10);
          for (const appliedVersion of [...applied]) {
            if (/^[0-9]+$/.test(appliedVersion) && Number.parseInt(appliedVersion, 10) >= parsedFloor) {
              applied.delete(appliedVersion);
            }
          }
        }
        if (catalog.failReplayWith) throw catalog.failReplayWith;
        for (const sentinel of RESTORED_SCHEMA_RELATION_SENTINELS) {
          if (applied.has(sentinel.version)) continue;
          for (const relation of sentinel.relations ?? []) relations.add(relation);
          for (const column of sentinel.columns ?? []) columns.add(columnKey(column.relation, column.column));
          for (const primaryKey of sentinel.primaryKeys ?? []) {
            primaryKeys.set(primaryKey.relation, primaryKey.columns);
          }
          for (const columnType of sentinel.columnTypes ?? []) {
            columns.add(columnKey(columnType.relation, columnType.column));
            columnTypes.set(columnKey(columnType.relation, columnType.column), columnType.dataType);
          }
          for (const trigger of sentinel.triggers ?? []) {
            triggers.add(namedObjectKey(trigger.relation, trigger.name));
          }
          for (const policy of sentinel.policies ?? []) {
            policies.add(namedObjectKey(policy.relation, policy.name));
          }
          for (const index of sentinel.indexes ?? []) {
            indexes.add(namedObjectKey(index.relation, index.name));
          }
          for (const column of sentinel.absentColumns ?? []) {
            columns.delete(columnKey(column.relation, column.column));
          }
          for (const relation of sentinel.forcedRowLevelSecurity ?? []) {
            rlsForced.add(relation);
          }
          applied.add(sentinel.version);
        }
      } catch (error) {
        applied.clear();
        for (const version of snapshotApplied) applied.add(version);
        relations.clear();
        for (const relation of snapshotRelations) relations.add(relation);
        columns.clear();
        for (const column of snapshotColumns) columns.add(column);
        primaryKeys.clear();
        for (const [relation, columnsForKey] of snapshotPrimaryKeys) {
          primaryKeys.set(relation, columnsForKey);
        }
        columnTypes.clear();
        for (const [key, dataType] of snapshotColumnTypes) columnTypes.set(key, dataType);
        triggers.clear();
        for (const key of snapshotTriggers) triggers.add(key);
        policies.clear();
        for (const key of snapshotPolicies) policies.add(key);
        indexes.clear();
        for (const key of snapshotIndexes) indexes.add(key);
        rlsForced.clear();
        for (const relation of snapshotRlsForced) rlsForced.add(relation);
        throw error;
      }
    },
    hasApplied(version) {
      return applied.has(version);
    },
    async insertLifecycleSeq(projectId: string) {
      if (!relations.has("project.task_lifecycle_event_seq")) {
        throw new Error('relation "project.task_lifecycle_event_seq" does not exist');
      }
      if (!projectId) throw new Error("projectId is required");
    },
    async insertConfigurationRevision() {
      if (!relations.has("project.configuration_revisions")) {
        throw new Error('relation "project.configuration_revisions" does not exist');
      }
    },
  };
  return catalog;
}

function sentinelRelationsBelow(version: string): string[] {
  return RESTORED_SCHEMA_RELATION_SENTINELS
    .filter((sentinel) => Number.parseInt(sentinel.version, 10) < Number.parseInt(version, 10))
    .flatMap((sentinel) => [...(sentinel.relations ?? [])]);
}

function sentinelColumnsBelow(version: string): Array<{ relation: string; column: string }> {
  return RESTORED_SCHEMA_RELATION_SENTINELS
    .filter((sentinel) => Number.parseInt(sentinel.version, 10) < Number.parseInt(version, 10))
    .flatMap((sentinel) => [...(sentinel.columns ?? [])]);
}

function sentinelRelationsExcept(version: string): string[] {
  return RESTORED_SCHEMA_RELATION_SENTINELS
    .filter((sentinel) => sentinel.version !== version)
    .flatMap((sentinel) => [...(sentinel.relations ?? [])]);
}

function sentinelColumnsExcept(version: string): Array<{ relation: string; column: string }> {
  return RESTORED_SCHEMA_RELATION_SENTINELS
    .filter((sentinel) => sentinel.version !== version)
    .flatMap((sentinel) => [...(sentinel.columns ?? [])]);
}

async function createRestoreFixture(root: string, backupOptions: BackupOptions = {}) {
  const fusionDir = join(root, "project", ".fusion");
  const backupDir = join(fusionDir, "backups");
  const actionsPath = join(root, "actions.log");
  const failRollbackMarker = join(root, "fail-rollback");
  const pgDumpPath = join(root, "pg_dump");
  const pgRestorePath = join(root, "pg_restore");
  await mkdir(backupDir, { recursive: true });
  await writeFile(pgDumpPath, `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --file ]; then shift; output="$1"; fi
  shift
done
base="$(basename "$output")"
printf 'DUMP %s\n' "$base" >> "${actionsPath}"
if [ -f "${failRollbackMarker}" ] && echo "$base" | grep -q '^fusion-pre-restore-pg-'; then
  printf FAIL_ROLLBACK > "$output"
else
  printf dump > "$output"
fi
`);
  await writeFile(pgRestorePath, `#!/bin/sh
first="$1"
for last do :; done
base="$(basename "$last")"
if [ "$first" = --list ]; then
  printf 'LIST %s\n' "$base" >> "${actionsPath}"
  grep -q CORRUPT "$last" && { echo 'corrupt archive' >&2; exit 1; }
  exit 0
fi
printf 'RESTORE %s %s\n' "$base" "$*" >> "${actionsPath}"
if grep -q FAIL_PROJECT "$last"; then echo 'project restore exploded' >&2; exit 1; fi
if grep -q FAIL_CENTRAL "$last"; then echo 'central restore exploded' >&2; exit 1; fi
if grep -q FAIL_ROLLBACK "$last"; then echo 'project rollback exploded' >&2; exit 1; fi
exit 0
`);
  await chmod(pgDumpPath, 0o755);
  await chmod(pgRestorePath, 0o755);
  const projectFilename = "fusion-pg-20260831-120000.dump";
  const centralFilename = "fusion-central-pg-20260831-120000.dump";
  const migrationsFilename = "fusion-migrations-pg-20260831-120000.dump";
  const projectPath = join(backupDir, projectFilename);
  const centralPath = join(backupDir, centralFilename);
  const migrationsPath = join(backupDir, migrationsFilename);
  const manager = new BackupManager(fusionDir, {
    connectionString: embeddedUrl,
    pgDumpPath,
    pgRestorePath,
    reconcileRestoredMigrations: async () => {},
    ...backupOptions,
  });
  const actions = async () => {
    try {
      return (await readFile(actionsPath, "utf8")).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    manager,
    backupDir,
    projectFilename,
    centralFilename,
    migrationsFilename,
    projectPath,
    centralPath,
    migrationsPath,
    failRollbackMarker,
    actions,
  };
}

describe("PostgreSQL backup pair inventory", () => {
  it("lists the canonical dump pair emitted by PostgreSQL backup creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-backup-pair-repro-"));
    try {
      const fusionDir = join(root, "project", ".fusion");
      await mkdir(fusionDir, { recursive: true });
      const pgDumpPath = join(root, "pg_dump");
      await writeFile(
        pgDumpPath,
        "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --file ]; then shift; printf dump >\"$1\"; fi; shift; done\n",
      );
      await chmod(pgDumpPath, 0o755);

      const manager = new BackupManager(fusionDir, {
        connectionString: embeddedUrl,
        pgDumpPath,
      });
      const created = await manager.createBackup();
      const pairs = await manager.listBackupPairs();

      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.project?.filename).toBe(created.filename);
      expect(pairs[0]?.central?.filename).toBe(
        created.centralBackup && "filename" in created.centralBackup
          ? created.centralBackup.filename
          : undefined,
      );
      expect(pairs[0]?.project?.path).toMatch(/^\//);
      expect(pairs[0]?.central?.path).toMatch(/^\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PostgreSQL paired restore orchestration", () => {
  it("validates sources, retains a pre-restore pair, then restores project before central", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-paired-restore-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "central-source");

      const result = await fixture.manager.restoreBackup(fixture.projectFilename);
      const actions = await fixture.actions();

      expect(result.restored).toEqual(["project", "central"]);
      expect(result.preRestoreBackup?.project?.filename).toMatch(/^fusion-pre-restore-pg-/);
      expect(result.preRestoreBackup?.central?.filename).toMatch(/^fusion-central-pre-restore-pg-/);
      expect(actions.slice(0, 2)).toEqual([
        `LIST ${fixture.projectFilename}`,
        `LIST ${fixture.centralFilename}`,
      ]);
      expect(actions[2]).toMatch(/^DUMP fusion-pre-restore-pg-/);
      expect(actions[3]).toMatch(/^DUMP fusion-central-pre-restore-pg-/);
      expect(actions[4]).toMatch(/^DUMP fusion-migrations-pre-restore-pg-/);
      expect(actions[5]).toMatch(/^LIST fusion-pre-restore-pg-/);
      expect(actions[6]).toMatch(/^LIST fusion-central-pre-restore-pg-/);
      expect(actions[7]).toMatch(new RegExp(`^RESTORE ${fixture.projectFilename} .*--single-transaction`));
      expect(actions[8]).toMatch(new RegExp(`^RESTORE ${fixture.centralFilename} .*--single-transaction`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores migration bookkeeping after project and central from a complete stem", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-migration-restore-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "central-source");
      await writeFile(fixture.migrationsPath, "migrations-source");
      const result = await fixture.manager.restoreBackup(fixture.projectFilename);
      expect(result.migrationBookkeeping).toBe("restored");
      const restores = (await fixture.actions()).filter((action) => action.startsWith("RESTORE "));
      expect(restores.map((action) => action.split(" ")[1])).toEqual([fixture.projectFilename, fixture.centralFilename, fixture.migrationsFilename]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses bookkeeping restores without a pre-restore rollback source before client mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-migration-refusal-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "central-source");
      await writeFile(fixture.migrationsPath, "migrations-source");
      await expect(fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false })).rejects.toThrow(/createPreRestoreBackup: false.*requires/i);
      expect(await fixture.actions()).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a missing or corrupt central sibling before backup creation or restore", async () => {
    for (const centralContent of [undefined, "CORRUPT"]) {
      const root = await mkdtemp(join(tmpdir(), "fusion-paired-preflight-"));
      try {
        const fixture = await createRestoreFixture(root);
        await writeFile(fixture.projectPath, "project-source");
        if (centralContent) await writeFile(fixture.centralPath, centralContent);

        await expect(fixture.manager.restoreBackup(fixture.projectFilename)).rejects.toThrow(
          centralContent ? /pg_restore failed/ : /not found/,
        );
        const actions = await fixture.actions();
        expect(actions.some((action) => action.startsWith("DUMP "))).toBe(false);
        expect(actions.some((action) => action.startsWith("RESTORE "))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("does not attempt central when the transactional project restore fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-project-restore-failure-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "FAIL_PROJECT");
      await writeFile(fixture.centralPath, "central-source");

      await expect(fixture.manager.restoreBackup(fixture.projectFilename)).rejects.toThrow(
        /project restore exploded/,
      );
      const restores = (await fixture.actions()).filter((action) => action.startsWith("RESTORE "));
      expect(restores).toHaveLength(1);
      expect(restores[0]).toContain(fixture.projectFilename);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls project/archive back from the retained pair when central restore fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-paired-rollback-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "FAIL_CENTRAL");

      await expect(fixture.manager.restoreBackup(fixture.projectFilename)).rejects.toThrow(
        /rolled back[\s\S]*central restore exploded/i,
      );
      const restores = (await fixture.actions()).filter((action) => action.startsWith("RESTORE "));
      expect(restores[0]).toContain(fixture.projectFilename);
      expect(restores[1]).toContain(fixture.centralFilename);
      expect(restores[2]).toMatch(/^RESTORE fusion-pre-restore-pg-/);
      expect(restores).toHaveLength(4);
      expect((await fixture.manager.listBackupPairs()).some(
        (pair) => pair.project?.filename.startsWith("fusion-pre-restore-pg-")
          && pair.central?.filename.startsWith("fusion-central-pre-restore-pg-"),
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces both central and rollback errors while retaining recovery dumps", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-paired-rollback-failure-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "FAIL_CENTRAL");
      await writeFile(fixture.failRollbackMarker, "yes");

      await expect(fixture.manager.restoreBackup(fixture.projectFilename)).rejects.toThrow(
        /central restore exploded[\s\S]*project rollback exploded/i,
      );
      expect((await fixture.manager.listBackupPairs()).some(
        (pair) => pair.project?.filename.startsWith("fusion-pre-restore-pg-")
          && pair.central?.filename.startsWith("fusion-central-pre-restore-pg-"),
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors central-only, skip-central, and no-prebackup restore bypasses", async () => {
    const cases = [
      {
        options: { centralOnly: true, createPreRestoreBackup: false },
        writeCentral: true,
        expected: ["central"],
      },
      {
        options: { skipCentral: true, createPreRestoreBackup: false },
        writeCentral: false,
        expected: ["project"],
      },
      {
        options: { createPreRestoreBackup: false },
        writeCentral: true,
        expected: ["project", "central"],
      },
    ] as const;

    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), "fusion-paired-bypass-"));
      try {
        const fixture = await createRestoreFixture(root);
        await writeFile(fixture.projectPath, "project-source");
        if (testCase.writeCentral) await writeFile(fixture.centralPath, "central-source");

        const result = await fixture.manager.restoreBackup(
          fixture.projectFilename,
          testCase.options,
        );
        const actions = await fixture.actions();
        expect(result.restored).toEqual(testCase.expected);
        expect(result.preRestoreBackup).toBeUndefined();
        expect(actions.some((action) => action.startsWith("DUMP "))).toBe(false);
        expect(actions.filter((action) => action.startsWith("RESTORE "))).toHaveLength(
          testCase.expected.length,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("replays 0040 relations after restoring a dump that lacks them while the ledger claims current", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0040-rewind-"));
    try {
      const catalog = createRestoreCatalog(sentinelRelationsBelow(TASK_LIFECYCLE_OUTBOX_VERSION));
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0040-project");
      await writeFile(fixture.centralPath, "central-source");

      await expect(catalog.insertLifecycleSeq("proj")).rejects.toThrow(
        /task_lifecycle_event_seq/,
      );

      await fixture.manager.restoreBackup(fixture.projectFilename, {
        createPreRestoreBackup: false,
      });

      expect(await catalog.relationExists("project.task_lifecycle_event_seq")).toBe(true);
      expect(await catalog.relationExists("project.task_lifecycle_events")).toBe(true);
      await expect(catalog.insertLifecycleSeq("proj")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rewinds past a missing pre-0040 relation so later inserts succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restore-pre-0040-rewind-"));
    try {
      const catalog = createRestoreCatalog(sentinelRelationsBelow(CONFIGURATION_REVISIONS_VERSION));
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0021-project");
      await writeFile(fixture.centralPath, "central-source");

      await expect(catalog.insertConfigurationRevision()).rejects.toThrow(
        /configuration_revisions/,
      );

      await fixture.manager.restoreBackup(fixture.projectFilename, {
        createPreRestoreBackup: false,
      });

      expect(await catalog.relationExists("project.configuration_revisions")).toBe(true);
      await expect(catalog.insertConfigurationRevision()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0011 owner_project_id when a later 0012 sentinel already exists", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const catalogAtDetect = createRestoreCatalog(allRelations, sentinelColumnsExcept(OWNER_PROJECT_ID_SPLIT_VERSION));
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(OWNER_PROJECT_ID_SPLIT_VERSION);
    expect(await catalogAtDetect.columnExists("project.chat_sessions", "pinned_at")).toBe(true);
    expect(await catalogAtDetect.columnExists("project.chat_sessions", "owner_project_id")).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0011-rewind-"));
    try {
      const catalog = createRestoreCatalog(allRelations, sentinelColumnsExcept(OWNER_PROJECT_ID_SPLIT_VERSION));
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0011-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(await catalog.columnExists("project.chat_sessions", "owner_project_id")).toBe(false);
      expect(await catalog.columnExists("project.todo_lists", "owner_project_id")).toBe(false);
      expect(await catalog.columnExists("project.research_runs", "owner_project_id")).toBe(false);
      expect(catalog.hasApplied(OWNER_PROJECT_ID_SPLIT_VERSION)).toBe(true);
      expect(catalog.hasApplied(CHAT_SESSION_PINS_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.columnExists("project.chat_sessions", "owner_project_id")).toBe(true);
      expect(await catalog.columnExists("project.todo_lists", "owner_project_id")).toBe(true);
      expect(await catalog.columnExists("project.research_runs", "owner_project_id")).toBe(true);
      expect(catalog.hasApplied(OWNER_PROJECT_ID_SPLIT_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0054/0055 agent_ratings.project_id when later sentinels exist", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const catalogAtDetect = createRestoreCatalog(
      allRelations,
      sentinelColumnsExcept(AGENT_RATING_PROJECT_ISOLATION_VERSION),
    );
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(AGENT_RATING_PROJECT_ISOLATION_VERSION);
    expect(await catalogAtDetect.columnExists("project.agent_ratings", "project_id")).toBe(false);
    expect(await catalogAtDetect.columnExists("project.messages", "archived")).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0054-ratings-"));
    try {
      const catalog = createRestoreCatalog(
        allRelations,
        sentinelColumnsExcept(AGENT_RATING_PROJECT_ISOLATION_VERSION),
      );
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0054-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(await catalog.columnExists("project.agent_ratings", "project_id")).toBe(false);
      expect(catalog.hasApplied(AGENT_RATING_PROJECT_ISOLATION_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.columnExists("project.agent_ratings", "project_id")).toBe(true);
      expect(catalog.hasApplied(AGENT_RATING_PROJECT_ISOLATION_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0054 when agent_ratings.project_id exists but the PK stayed (id)", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);
    const driftedPk = [{ relation: "project.agent_ratings", columns: ["id"] as const }];
    const catalogAtDetect = createRestoreCatalog(allRelations, allColumns, driftedPk);
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(AGENT_RATING_PROJECT_ISOLATION_VERSION);
    expect(await catalogAtDetect.columnExists("project.agent_ratings", "project_id")).toBe(true);
    expect(await catalogAtDetect.primaryKeyColumns("project.agent_ratings")).toEqual(["id"]);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0054-ratings-pk-"));
    try {
      const catalog = createRestoreCatalog(allRelations, allColumns, driftedPk);
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0054-pk-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(AGENT_RATING_PROJECT_ISOLATION_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.primaryKeyColumns("project.agent_ratings")).toEqual(["project_id", "id"]);
      expect(catalog.hasApplied(AGENT_RATING_PROJECT_ISOLATION_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0055 when agent_ratings PK is healthy but the assign trigger is missing", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);
    const catalogAtDetect = createRestoreCatalog(allRelations, allColumns, [], [], { triggers: [] });
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(AGENT_RATINGS_PROJECT_PARTITION_VERSION);
    expect(await catalogAtDetect.columnExists("project.agent_ratings", "project_id")).toBe(true);
    expect(await catalogAtDetect.primaryKeyColumns("project.agent_ratings")).toEqual(["project_id", "id"]);
    expect(await catalogAtDetect.triggerExists("project.agent_ratings", "fusion_assign_project_id")).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0055-trigger-"));
    try {
      const catalog = createRestoreCatalog(allRelations, allColumns, [], [], { triggers: [] });
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0055-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(AGENT_RATINGS_PROJECT_PARTITION_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.triggerExists("project.agent_ratings", "fusion_assign_project_id")).toBe(true);
      expect(catalog.hasApplied(AGENT_RATINGS_PROJECT_PARTITION_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0055 when agent_ratings trigger and policy exist but RLS is not forced", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);
    const catalogAtDetect = createRestoreCatalog(allRelations, allColumns, [], [], { rlsForced: [] });
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(AGENT_RATINGS_PROJECT_PARTITION_VERSION);
    expect(await catalogAtDetect.triggerExists("project.agent_ratings", "fusion_assign_project_id")).toBe(true);
    expect(await catalogAtDetect.policyExists("project.agent_ratings", "fusion_project_isolation")).toBe(true);
    expect(await catalogAtDetect.rowLevelSecurityForced("project.agent_ratings")).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0055-rls-"));
    try {
      const catalog = createRestoreCatalog(allRelations, allColumns, [], [], { rlsForced: [] });
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0055-rls-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(AGENT_RATINGS_PROJECT_PARTITION_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.rowLevelSecurityForced("project.agent_ratings")).toBe(true);
      expect(catalog.hasApplied(AGENT_RATINGS_PROJECT_PARTITION_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0024 when task_verification_requests is missing and later sentinels exist", async () => {
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);
    const catalogAtDetect = createRestoreCatalog(
      sentinelRelationsExcept(TASK_VERIFICATION_REQUEST_VERSION),
      allColumns,
    );
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(TASK_VERIFICATION_REQUEST_VERSION);
    expect(await catalogAtDetect.relationExists("project.task_verification_requests")).toBe(false);
    expect(await catalogAtDetect.relationExists("project.symbol_locks")).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0024-verify-"));
    try {
      const catalog = createRestoreCatalog(
        sentinelRelationsExcept(TASK_VERIFICATION_REQUEST_VERSION),
        allColumns,
      );
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0024-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(TASK_VERIFICATION_REQUEST_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.relationExists("project.task_verification_requests")).toBe(true);
      expect(catalog.hasApplied(TASK_VERIFICATION_REQUEST_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0025 when symbol_locks is missing after 0024 is present", async () => {
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);
    const catalog = createRestoreCatalog(
      sentinelRelationsExcept(SYMBOL_LOCKS_SCHEMA_VERSION),
      allColumns,
    );
    expect(await catalog.relationExists("project.task_verification_requests")).toBe(true);
    expect(await catalog.relationExists("project.symbol_locks")).toBe(false);
    expect(await detectRestoredSchemaRewindFloor(catalog)).toBe(SYMBOL_LOCKS_SCHEMA_VERSION);
  });

  it("unstamps 0026 when token counters exist as integer rather than bigint", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const allColumns = [
      ...RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]),
      { relation: "project.tasks", column: "token_usage_input_tokens" },
      { relation: "project.tasks", column: "cumulative_active_ms" },
    ];
    const integerCounters = [
      { relation: "project.tasks", column: "token_usage_input_tokens", dataType: "integer" },
    ];
    const catalogAtDetect = createRestoreCatalog(allRelations, allColumns, [], integerCounters);
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(BIGINT_COUNTERS_VERSION);
    expect(await catalogAtDetect.columnExists("project.tasks", "token_usage_input_tokens")).toBe(true);
    expect(await catalogAtDetect.columnDataType("project.tasks", "token_usage_input_tokens")).toBe("integer");

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0026-bigint-"));
    try {
      const catalog = createRestoreCatalog(allRelations, allColumns, [], integerCounters);
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0026-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(BIGINT_COUNTERS_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.columnDataType("project.tasks", "token_usage_input_tokens")).toBe("bigint");
      expect(catalog.hasApplied(BIGINT_COUNTERS_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps 0051 when current_plan_evidence.source_revision exists as integer", async () => {
    const allRelations = [
      ...RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]),
      "project.current_plan_evidence",
    ];
    const allColumns = [
      ...RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]),
      { relation: "project.current_plan_evidence", column: "source_revision" },
    ];
    const integerRevision = [
      { relation: "project.current_plan_evidence", column: "source_revision", dataType: "integer" },
    ];
    const catalogAtDetect = createRestoreCatalog(allRelations, allColumns, [], integerRevision);
    expect(await detectRestoredSchemaRewindFloor(catalogAtDetect)).toBe(SPEC_LOCK_SOURCE_REVISION_BIGINT_VERSION);
    expect(await catalogAtDetect.relationExists("project.spec_locks")).toBe(true);
    expect(await catalogAtDetect.columnDataType("project.current_plan_evidence", "source_revision")).toBe("integer");

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-0051-bigint-"));
    try {
      const catalog = createRestoreCatalog(allRelations, allColumns, [], integerRevision);
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0051-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(catalog.hasApplied(SPEC_LOCK_SOURCE_REVISION_BIGINT_VERSION)).toBe(true);

      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });

      expect(await catalog.columnDataType("project.current_plan_evidence", "source_revision")).toBe("bigint");
      expect(catalog.hasApplied(SPEC_LOCK_SOURCE_REVISION_BIGINT_VERSION)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unstamps similarly numbered early migrations when their objects are missing", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const allColumns = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.columns ?? [])]);

    for (const version of [
      AUTOMATION_ISOLATION_SCHEMA_VERSION,
      ANALYTICS_ISOLATION_SCHEMA_VERSION,
      MONITOR_APPROVAL_ISOLATION_SCHEMA_VERSION,
      MULTI_PROJECT_CUTOVER_SCHEMA_VERSION,
    ]) {
      const catalog = createRestoreCatalog(allRelations, sentinelColumnsExcept(version));
      expect(await detectRestoredSchemaRewindFloor(catalog)).toBe(version);
    }

    const ownershipCatalog = createRestoreCatalog(
      sentinelRelationsExcept(PROJECT_OWNERSHIP_SCHEMA_VERSION),
      allColumns,
    );
    expect(await detectRestoredSchemaRewindFloor(ownershipCatalog)).toBe(PROJECT_OWNERSHIP_SCHEMA_VERSION);
  });

  it("unstamps omitted ALTER columns even when later CREATE TABLE sentinels exist", async () => {
    const allRelations = RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]);
    const credentialCatalog = createRestoreCatalog(
      allRelations,
      sentinelColumnsBelow(CREDENTIAL_INSTANCE_SELECTION_VERSION),
    );
    expect(await detectRestoredSchemaRewindFloor(credentialCatalog)).toBe(CREDENTIAL_INSTANCE_SELECTION_VERSION);

    const archiveCatalog = createRestoreCatalog(
      allRelations,
      sentinelColumnsBelow(MESSAGE_ARCHIVE_SCHEMA_VERSION),
    );
    expect(await detectRestoredSchemaRewindFloor(archiveCatalog)).toBe(MESSAGE_ARCHIVE_SCHEMA_VERSION);

    const root = await mkdtemp(join(tmpdir(), "fusion-restore-omitted-alter-"));
    try {
      const catalog = createRestoreCatalog(
        allRelations,
        sentinelColumnsBelow(CREDENTIAL_INSTANCE_SELECTION_VERSION),
      );
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0039-project");
      await writeFile(fixture.centralPath, "central-source");
      expect(await catalog.columnExists("project.tasks", "credential_instance_id")).toBe(false);
      expect(await catalog.columnExists("project.messages", "archived")).toBe(false);
      await fixture.manager.restoreBackup(fixture.projectFilename, { createPreRestoreBackup: false });
      expect(await catalog.columnExists("project.tasks", "credential_instance_id")).toBe(true);
      expect(await catalog.columnExists("project.messages", "archived")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rewinds a missing later ALTER column while parent tables remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-restore-column-rewind-"));
    try {
      const catalog = createRestoreCatalog(
        RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]),
        sentinelColumnsBelow(TASK_REQUIRE_PLAN_APPROVAL_VERSION),
      );
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: () => reconcileRestoredSchemaMigrations(catalog),
      });
      await writeFile(fixture.projectPath, "pre-0070-project");
      await writeFile(fixture.centralPath, "central-source");

      expect(await catalog.columnExists("project.tasks", "require_plan_approval")).toBe(false);
      await fixture.manager.restoreBackup(fixture.projectFilename, {
        createPreRestoreBackup: false,
      });
      expect(await catalog.columnExists("project.tasks", "require_plan_approval")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps migration ledger versions when baseline replay fails after unstamp", async () => {
    const catalog = createRestoreCatalog(
      RESTORED_SCHEMA_RELATION_SENTINELS.flatMap((sentinel) => [...(sentinel.relations ?? [])]),
    );
    catalog.failReplayWith = new Error("baseline exploded");
    expect(catalog.hasApplied(TASK_REQUIRE_PLAN_APPROVAL_VERSION)).toBe(true);
    await expect(reconcileRestoredSchemaMigrations(catalog)).rejects.toThrow(/baseline exploded/);
    expect(catalog.hasApplied(TASK_REQUIRE_PLAN_APPROVAL_VERSION)).toBe(true);
    expect(catalog.hasApplied(TASK_LIFECYCLE_OUTBOX_VERSION)).toBe(true);
  });

  it("rolls project/archive back when migration reconciliation fails after project restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-reconcile-rollback-"));
    try {
      let reconcileAttempts = 0;
      const fixture = await createRestoreFixture(root, {
        reconcileRestoredMigrations: async () => {
          reconcileAttempts += 1;
          if (reconcileAttempts === 1) throw new Error("reconcile exploded");
        },
      });
      await writeFile(fixture.projectPath, "project-source");
      await writeFile(fixture.centralPath, "central-source");

      await expect(fixture.manager.restoreBackup(fixture.projectFilename)).rejects.toThrow(
        /rolled back[\s\S]*reconcile exploded/i,
      );
      const restores = (await fixture.actions()).filter((action) => action.startsWith("RESTORE "));
      expect(restores[0]).toContain(fixture.projectFilename);
      expect(restores[1]).toContain(fixture.centralFilename);
      expect(restores[2]).toMatch(/^RESTORE fusion-pre-restore-pg-/);
      expect(restores[3]).toMatch(/^RESTORE fusion-central-pre-restore-pg-/);
      expect(reconcileAttempts).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a selected central dump as central-only and rejects contradictory options", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-central-selection-"));
    try {
      const fixture = await createRestoreFixture(root);
      await writeFile(fixture.centralPath, "central-source");

      const result = await fixture.manager.restoreBackup(fixture.centralPath, {
        createPreRestoreBackup: false,
      });
      expect(result.restored).toEqual(["central"]);
      expect((await fixture.actions()).filter((action) => action.startsWith("RESTORE ")))
        .toEqual([expect.stringContaining(fixture.centralFilename)]);

      await expect(fixture.manager.restoreBackup(fixture.centralFilename, {
        skipCentral: true,
      })).rejects.toThrow(/skipCentral/);
      await expect(fixture.manager.restoreBackup(fixture.projectFilename, {
        skipCentral: true,
        centralOnly: true,
      })).rejects.toThrow(/cannot be used together/);
      await expect(fixture.manager.restoreBackup("fusion.db", {
        createPreRestoreBackup: false,
      })).rejects.toThrow(/Invalid PostgreSQL backup filename/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("restore reconciliation TLS policy", () => {
  it("keeps SSL off for loopback and requires verify-full for remote hosts", () => {
    expect(reconciliationPostgresSsl(pgUrl("secret", "postgres", "127.0.0.1", 55432))).toBe(false);
    expect(reconciliationPostgresSsl(pgUrl("secret", "postgres", "localhost"))).toBe(false);
    expect(reconciliationPostgresSsl("host=/tmp/fusion-pg user=postgres dbname=fusion")).toBe(false);
    expect(reconciliationPostgresSsl(pgUrl("secret", "operator", "db.example.test"))).toBe("verify-full");
  });
});

describe("embedded backup runtime URL registry", () => {
  it("resolves a registered embedded backend and lets BackupManager construct", () => {
    vi.stubEnv("DATABASE_URL", "");
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    expect(resolveBackendConnectionString()).toBe(embeddedUrl);
    expect(() => createBackupManager("/tmp/project/.fusion")).not.toThrow();
  });

  it("keeps an external DATABASE_URL ahead of the embedded registry", () => {
    vi.stubEnv("DATABASE_URL", externalUrl);
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    expect(resolveBackendConnectionString()).toBe(externalUrl);
  });

  it("preserves the actionable error before an embedded lifecycle boots", () => {
    vi.stubEnv("DATABASE_URL", "");

    expect(resolveBackendConnectionString()).toBeUndefined();
    expect(() => new BackupManager("/tmp/project/.fusion")).toThrow(
      "BackupManager requires a PostgreSQL connection string",
    );
  });

  it("keeps an owner URL live when only a joiner releases", async () => {
    const owner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const joiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    await releaseEmbeddedRuntimeLease(joiner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    await releaseEmbeddedRuntimeLease(owner);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("defers owner shutdown until the final joined lease releases", async () => {
    const stopOwner = vi.fn(async () => undefined);
    const owner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const joiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    await releaseEmbeddedRuntimeLease(owner, { stopOwner });
    expect(stopOwner).not.toHaveBeenCalled();
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    await releaseEmbeddedRuntimeLease(joiner);
    expect(stopOwner).toHaveBeenCalledOnce();
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("rejects registrations until a deferred owner stop completes", async () => {
    const owner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const joiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    let finishStop!: () => void;
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const stopOwner = vi.fn(async () => stopFinished);
    await releaseEmbeddedRuntimeLease(owner, { stopOwner });

    const finalRelease = releaseEmbeddedRuntimeLease(joiner);
    await vi.waitFor(() => expect(stopOwner).toHaveBeenCalledOnce());
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
    let stoppingError: EmbeddedRuntimeStoppingError | undefined;
    try {
      registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    } catch (error) {
      if (error instanceof EmbeddedRuntimeStoppingError) stoppingError = error;
    }
    expect(stoppingError).toBeInstanceOf(EmbeddedRuntimeStoppingError);
    if (!stoppingError) throw new Error("Expected stopping registration to expose completion");
    const stopCompletion = stoppingError.completion;
    let stopCompletionSettled = false;
    void stopCompletion.then(() => {
      stopCompletionSettled = true;
    });
    await Promise.resolve();
    expect(stopCompletionSettled).toBe(false);

    finishStop();
    await stopCompletion;
    await finalRelease;
    expect(stopCompletionSettled).toBe(true);
    expect(registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true })).toBeDefined();
  });

  it("stops the owner immediately when joined leases already released", async () => {
    const stopOwner = vi.fn(async () => undefined);
    const owner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const joiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    await releaseEmbeddedRuntimeLease(joiner);
    await releaseEmbeddedRuntimeLease(owner, { stopOwner });

    expect(stopOwner).toHaveBeenCalledOnce();
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("invalidates every joiner when the postmaster owner stops", () => {
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });

    invalidateEmbeddedRuntimeUrl(embeddedUrl);
    expect(resolveBackendConnectionString()).toBeUndefined();
    expect(() => new BackupManager("/tmp/project/.fusion")).toThrow(
      "BackupManager requires a PostgreSQL connection string",
    );
  });

  it("makes an old joiner release inert after owner invalidation and re-registration", () => {
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const oldJoiner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    invalidateEmbeddedRuntimeUrl(embeddedUrl);
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    releaseEmbeddedRuntimeLease(oldJoiner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);
  });

  it("makes leases from a test reset inert for a re-registered URL", () => {
    const oldLease = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    clearActiveEmbeddedRuntimeUrl();
    registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    releaseEmbeddedRuntimeLease(oldLease);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);
  });

  it("does not let a stale owner invalidate a replacement cluster that reused its URL", () => {
    const oldOwner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });
    const replacementOwner = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: true });

    invalidateEmbeddedRuntimeUrl(embeddedUrl, oldOwner);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    releaseEmbeddedRuntimeLease(replacementOwner);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });

  it("uses the last live registration and ignores unknown invalidation/releases", () => {
    const firstUrl = pgUrl("a", "postgres", "127.0.0.1", 55431);
    const first = registerEmbeddedRuntimeUrl(firstUrl, { ownsProcess: true });
    const second = registerEmbeddedRuntimeUrl(embeddedUrl, { ownsProcess: false });
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    invalidateEmbeddedRuntimeUrl("postgresql://unknown@127.0.0.1:9/missing");
    releaseEmbeddedRuntimeLease({} as never);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(embeddedUrl);

    releaseEmbeddedRuntimeLease(second);
    expect(getActiveEmbeddedRuntimeUrl()).toBe(firstUrl);
    releaseEmbeddedRuntimeLease(first);
    expect(getActiveEmbeddedRuntimeUrl()).toBeUndefined();
  });
});
