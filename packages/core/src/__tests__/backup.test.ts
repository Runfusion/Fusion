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
  reconcileRestoredSchemaMigrations,
  reconciliationPostgresSsl,
  RESTORED_SCHEMA_RELATION_SENTINELS,
  type RestoreMigrationCatalog,
} from "../postgres/restore-migration-reconcile.js";
import {
  CONFIGURATION_REVISIONS_VERSION,
  TASK_LIFECYCLE_OUTBOX_VERSION,
  TASK_REQUIRE_PLAN_APPROVAL_VERSION,
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

function createRestoreCatalog(
  presentRelations: readonly string[] = [],
  presentColumns: ReadonlyArray<{ relation: string; column: string }> = [],
): RestoreMigrationCatalog & {
  insertLifecycleSeq(projectId: string): Promise<void>;
  insertConfigurationRevision(): Promise<void>;
  hasApplied(version: string): boolean;
  failReplayWith?: Error;
} {
  const relations = new Set(presentRelations);
  const columns = new Set(presentColumns.map((entry) => columnKey(entry.relation, entry.column)));
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
    async applyRewindAndReplay(floor) {
      const snapshotApplied = new Set(applied);
      const snapshotRelations = new Set(relations);
      const snapshotColumns = new Set(columns);
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
          applied.add(sentinel.version);
        }
      } catch (error) {
        applied.clear();
        for (const version of snapshotApplied) applied.add(version);
        relations.clear();
        for (const relation of snapshotRelations) relations.add(relation);
        columns.clear();
        for (const column of snapshotColumns) columns.add(column);
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
