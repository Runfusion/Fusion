/**
 * FNXC:RuntimeStartupWiring 2026-06-24-10:45:
 * Integration test for createTaskStoreForBackend against a real PostgreSQL
 * instance (external mode). Verifies the five-step boot sequence:
 *   1. resolveBackend() → external.
 *   2. createConnectionSet opens the pool.
 *   3. applySchemaBaseline lands the schema.
 *   4. TaskStore is constructed in backend mode (asyncLayer injected).
 *   5. shutdown() releases the pool cleanly.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server. Run locally with PG on 5432.
 */

import { afterEach, describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTaskStoreForBackend } from "../../postgres/startup-factory.js";
import { getSqliteMigrationState } from "../../postgres/sqlite-migrator.js";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "../../sqlite-adapter.js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_startup_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

function seedLegacyTask(root: string, taskId: string, title: string): void {
  const fusionDir = join(root, ".fusion");
  mkdirSync(fusionDir, { recursive: true });
  const legacy = new DatabaseSync(join(fusionDir, "fusion.db"));
  try {
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, description TEXT NOT NULL, "column" TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
    legacy.prepare(
      `INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, title, "legacy", "todo", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
  } finally {
    legacy.close();
  }
}

function seedLegacyRegistry(globalDir: string, projects: Array<{ id: string; path: string }>): void {
  mkdirSync(globalDir, { recursive: true });
  const legacy = new DatabaseSync(join(globalDir, "fusion-central.db"));
  try {
    legacy.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
    const insert = legacy.prepare(
      `INSERT INTO projects (id, name, path, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const project of projects) {
      insert.run(project.id, project.id, project.path, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    }
  } finally {
    legacy.close();
  }
}

function seedLegacyPlugin(root: string): void {
  const fusionDir = join(root, ".fusion");
  mkdirSync(fusionDir, { recursive: true });
  const legacy = new DatabaseSync(join(fusionDir, "fusion.db"));
  try {
    legacy.exec(`CREATE TABLE plugins (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
      description TEXT, author TEXT, homepage TEXT, path TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, state TEXT NOT NULL DEFAULT 'installed',
      settings TEXT DEFAULT '{}', settingsSchema TEXT, error TEXT,
      dependencies TEXT DEFAULT '[]', aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
      lastSecurityScan TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
    legacy.prepare(`INSERT INTO plugins (
      id, name, version, path, enabled, state, settings, dependencies,
      aiScanOnLoad, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "legacy-startup-plugin",
        "Legacy startup plugin",
        "1.0.0",
        "/plugins/legacy-startup-plugin",
        1,
        "installed",
        "{}",
        "[]",
        0,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
  } finally {
    legacy.close();
  }
}

pgDescribe("startup-factory: external PostgreSQL boot (integration)", () => {
  let rootDir: string;
  let dbName: string;

  afterEach(async () => {
    if (dbName) {
      try {
        adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort
      }
    }
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("boots a PostgreSQL-backed TaskStore and the store reports backend mode", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-pg-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const result = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.backend.mode).toBe("external");
    expect(result!.taskStore.isBackendMode()).toBe(true);
    expect(result!.taskStore.getAsyncLayer()).not.toBeNull();
    // init() in backend mode skips SQLite (no .db file under .fusion).
    await result!.taskStore.init();
    await result!.shutdown();
  });

  it("applies the schema baseline idempotently on repeated boots", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-pg-idem-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const first = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    expect(first).not.toBeNull();
    await first!.shutdown();

    // Second boot against the same database: baseline is already applied.
    const second = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    expect(second).not.toBeNull();
    await second!.shutdown();
  });

  it("lets the restricted runtime role read an existing SQLite migration marker", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-migration-marker-role-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const first = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    const projectId = first.taskStore.getAsyncLayer()!.projectId!;
    await first.shutdown();

    const admin = postgres(testUrl, { max: 1 });
    try {
      await admin`CREATE TABLE IF NOT EXISTS public.fusion_sqlite_migrations (
        migration_key text PRIMARY KEY,
        project_id text,
        status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await admin`
        INSERT INTO public.fusion_sqlite_migrations
          (migration_key, project_id, status, last_error, updated_at)
        VALUES
          (${`project:${projectId}`}, ${projectId}, 'failed', 'copy failed', now()),
          ('project:other-project', 'other-project', 'failed', 'other copy failed', now())
      `;
      await admin`REVOKE ALL ON public.fusion_sqlite_migrations FROM fusion_runtime`;
      await admin`DELETE FROM public.fusion_schema_migrations WHERE version = '0030'`;
    } finally {
      await admin.end();
    }

    const second = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    try {
      await expect(getSqliteMigrationState(
        second.taskStore.getAsyncLayer()!.db,
        `project:${projectId}`,
      )).resolves.toMatchObject({
        migrationKey: `project:${projectId}`,
        projectId,
        status: "failed",
      });
      await expect(getSqliteMigrationState(
        second.taskStore.getAsyncLayer()!.db,
        "project:other-project",
      )).resolves.toBeNull();
    } finally {
      await second.shutdown();
    }
  });

  it("grants migration-marker reads when first-boot SQLite migration creates the table", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-new-migration-marker-role-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    seedLegacyTask(rootDir, "FN-MARKER-1", "Migration marker grant");

    const result = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    try {
      const projectId = result.taskStore.getAsyncLayer()!.projectId!;
      await expect(getSqliteMigrationState(
        result.taskStore.getAsyncLayer()!.db,
        `project:${projectId}`,
      )).resolves.toMatchObject({
        migrationKey: `project:${projectId}`,
        projectId,
        status: "complete",
      });
    } finally {
      await result.shutdown();
    }
  });

  /*
  FNXC:PluginLegacyMigration 2026-07-15-02:09:
  Steady-state startup must finish the retained-SQLite plugin bridge through the privileged migration connection before returning a project-scoped runtime store. Dashboard, serve, desktop, and engine startup all initialize PluginStore after the runtime role is active, so PluginStore.init must remain DDL-free and must not crash with "permission denied for schema public".
  */
  it("migrates retained plugin rows before returning the restricted runtime store", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-plugin-bridge-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const first = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    const projectId = first.taskStore.getAsyncLayer()!.projectId!;
    await first.shutdown();

    const admin = postgres(testUrl, { max: 1 });
    try {
      await admin`CREATE TABLE IF NOT EXISTS public.fusion_sqlite_migrations (
        migration_key text PRIMARY KEY,
        project_id text,
        status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await admin`
        INSERT INTO public.fusion_sqlite_migrations
          (migration_key, project_id, status, last_error, updated_at)
        VALUES (${`project:${projectId}`}, ${projectId}, 'complete', NULL, now())
      `;
    } finally {
      await admin.end();
    }
    seedLegacyPlugin(rootDir);

    const second = await createTaskStoreForBackend({
      rootDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    try {
      await expect(second.taskStore.getPluginStore().init()).resolves.toBeUndefined();
      const client = postgres(testUrl, { max: 1 });
      try {
        const installs = await client<{ id: string }[]>`
          SELECT id FROM central.plugin_installs WHERE id = 'legacy-startup-plugin'
        `;
        const states = await client<{ plugin_id: string }[]>`
          SELECT plugin_id FROM central.project_plugin_states
          WHERE project_path = ${rootDir} AND plugin_id = 'legacy-startup-plugin'
        `;
        expect(installs).toEqual([{ id: "legacy-startup-plugin" }]);
        expect(states).toEqual([{ plugin_id: "legacy-startup-plugin" }]);
      } finally {
        await client.end();
      }
    } finally {
      await second.shutdown();
    }
  });

  it("does not reopen a completed central backup while a fallback project migration remains pending", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-completed-central-"));
    const globalDir = await mkdtemp(join(tmpdir(), "startup-factory-completed-central-global-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const first = await createTaskStoreForBackend({
      rootDir,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    const fallbackProjectId = first.taskStore.getAsyncLayer()!.projectId!;
    await first.shutdown();
    seedLegacyTask(rootDir, "FN-CENTRAL-MARKER-1", "Central marker boundary");
    seedLegacyRegistry(globalDir, [{ id: "must-not-resolve-from-sqlite", path: rootDir }]);

    const admin = postgres(testUrl, { max: 1 });
    try {
      await admin`
        INSERT INTO public.fusion_sqlite_migrations
          (migration_key, project_id, status, last_error, updated_at)
        VALUES ('central:legacy-sqlite', NULL, 'complete', NULL, now())
      `;
    } finally {
      await admin.end();
    }

    const result = await createTaskStoreForBackend({
      rootDir,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    try {
      expect(await getSqliteMigrationState(
        result.taskStore.getAsyncLayer()!.db,
        `project:${fallbackProjectId}`,
      )).toMatchObject({ status: "complete" });
      expect(await getSqliteMigrationState(
        result.taskStore.getAsyncLayer()!.db,
        "project:must-not-resolve-from-sqlite",
      )).toBeNull();
    } finally {
      await result.shutdown();
    }
  });

  it("keeps completed core, central, and plugin SQLite backups inert across repeated boots", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-completed-backups-"));
    const globalDir = await mkdtemp(join(tmpdir(), "startup-factory-completed-global-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    const projectId = "completed-project";
    const first = await createTaskStoreForBackend({
      rootDir,
      projectId,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
      poolMax: 1,
    });
    await first.shutdown();
    seedLegacyTask(rootDir, "legacy-must-stay-inert", "inert backup task");
    seedLegacyPlugin(rootDir);
    seedLegacyRegistry(globalDir, [{ id: projectId, path: rootDir }]);

    const admin = postgres(testUrl, { max: 1 });
    try {
      await admin`
        INSERT INTO public.fusion_sqlite_migrations
          (migration_key, project_id, status, last_error, updated_at)
        VALUES
          (${`project:${projectId}`}, ${projectId}, 'complete', NULL, now()),
          ('central:legacy-sqlite', NULL, 'complete', NULL, now()),
          (${`project-plugins:${resolve(rootDir)}`}, NULL, 'complete', NULL, now())
        ON CONFLICT (migration_key) DO UPDATE SET status = 'complete', last_error = NULL
      `;
    } finally {
      await admin.end();
    }

    for (let boot = 0; boot < 2; boot += 1) {
      const result = await createTaskStoreForBackend({
        rootDir,
        projectId,
        globalSettingsDir: globalDir,
        env: { DATABASE_URL: testUrl },
        poolMax: 1,
      });
      try {
        expect(await result.taskStore.listTasks()).not.toContainEqual(
          expect.objectContaining({ id: "legacy-must-stay-inert" }),
        );
        const installs = await result.taskStore.getAsyncLayer()!.db.execute(sql`
          SELECT id FROM central.plugin_installs WHERE id = 'legacy-startup-plugin'
        `);
        expect(installs).toEqual([]);
      } finally {
        await result.shutdown();
      }
    }
  });

  /*
   * FNXC:PostgresMigration 2026-07-10:
   * First-boot auto-migration (review data-loss trap): booting the PG backend
   * over a project that still has legacy SQLite data must migrate that data
   * into the empty PostgreSQL database instead of silently starting empty.
   * The SQLite file is left in place as a backup; a second boot must not
   * re-migrate (project.tasks no longer empty).
   */
  it("auto-migrates legacy SQLite data into an empty PostgreSQL database on first boot", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-automig-"));
    const globalDir = join(rootDir, "global");
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    /*
    FNXC:PostgresMigration 2026-07-14-08:52:
    Startup migration must bind real upgraded SQLite automation rows whose nullable projectId is still NULL to the registry project before PostgreSQL enforces its required partition. This fixture reproduces the pnpm dev startup crash, not only the simpler legacy shape where the source column is absent.
    */
    seedLegacyRegistry(globalDir, [{ id: "project-migrated", path: rootDir }]);

    // Seed a minimal legacy fusion.db with one live task.
    const fusionDir = join(rootDir, ".fusion");
    mkdirSync(fusionDir, { recursive: true });
    const legacy = new DatabaseSync(join(fusionDir, "fusion.db"));
    try {
      legacy.exec(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scheduleType TEXT NOT NULL,
        cronExpression TEXT NOT NULL,
        command TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        projectId TEXT
      );`);
      legacy.prepare(
        `INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("FN-MIG-1", "Legacy task", "migrated from sqlite", "todo", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
      legacy.prepare(`INSERT INTO automations VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "automation-migrated",
        "Nightly",
        "cron",
        "0 0 * * *",
        "pnpm check",
        "2026-06-01T00:00:00Z",
        "2026-06-01T00:00:00Z",
        null,
      );
    } finally {
      legacy.close();
    }

    const first = await createTaskStoreForBackend({
      rootDir,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
    });
    expect(first).not.toBeNull();
    try {
      const migrated = await first!.taskStore.getTask("FN-MIG-1");
      expect(migrated.title).toBe("Legacy task");
      expect(migrated.column).toBe("todo");

      /*
      FNXC:PostgresMigrationBanner 2026-07-12:
      A successful auto-migration must persist the one-time dashboard notice
      ("your data was migrated and a backup exists") into project settings,
      pointing at the retained SQLite backup file, not yet dismissed.
      */
      const settings = await first!.taskStore.getSettings();
      const notice = settings.sqliteMigrationNotice;
      expect(notice).toBeTruthy();
      expect(notice!.migratedRows).toBeGreaterThanOrEqual(1);
      expect(notice!.tables).toBeGreaterThanOrEqual(1);
      expect(notice!.sqliteBackups).toContain(join(fusionDir, "fusion.db"));
      expect(notice!.dismissed).toBe(false);

      const migratedAutomations = (await first!.asyncLayer.db.execute(sql`
        SELECT project_id, id FROM project.automations WHERE id = 'automation-migrated'
      `)) as unknown as Array<{ project_id: string; id: string }>;
      expect(migratedAutomations).toEqual([
        { project_id: "project-migrated", id: "automation-migrated" },
      ]);
    } finally {
      await first!.shutdown();
    }

    // Second boot: PG is no longer empty — must NOT attempt to re-migrate.
    const second = await createTaskStoreForBackend({
      rootDir,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
    });
    expect(second).not.toBeNull();
    try {
      const stillThere = await second!.taskStore.getTask("FN-MIG-1");
      expect(stillThere.title).toBe("Legacy task");
    } finally {
      await second!.shutdown();
    }
  });

  /*
  FNXC:MultiProjectIsolation 2026-07-13-21:20:
  A rootDir-only boot (`fn dashboard` in the project directory — the main
  cutover path) must still stamp migrated NULL-project_id rows when the
  central registry knows the project. The previous `if (options.projectId)`
  guard skipped stamping on exactly this path, so every project-bound reader
  (engine, project-store-resolver) filtered the migrated tasks out and the
  board showed empty right after a successful migration.
  */
  it("stamps migrated rows with the central-registry project id on a rootDir-only boot", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-stamp-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

    const fusionDir = join(rootDir, ".fusion");
    const globalDir = join(rootDir, ".fusion-global");
    mkdirSync(fusionDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    const legacy = new DatabaseSync(join(fusionDir, "fusion.db"));
    try {
      legacy.exec(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );`);
      legacy.prepare(
        `INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("FN-STAMP-1", "Stamped task", "migrated from sqlite", "todo", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
      // Legacy singleton config row — must be re-keyed from '' to the
      // registered project id so bound configScope readers still see the
      // migrated settings (FNXC:CentralProjectIdentity).
      legacy.exec(`CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT DEFAULT '{}',
        updatedAt TEXT
      );`);
      legacy.prepare(`INSERT INTO config (id, settings, updatedAt) VALUES (1, ?, ?)`).run(
        JSON.stringify({ taskPrefix: "ST", merger: { mode: "ai" } }),
        "2026-06-01T00:00:00Z",
      );
      // Legacy workflow_settings keyed by the pre-isolation rootDir path string
      // (real SQLite schema: workflowId, projectId, "values", updatedAt). Must
      // be re-keyed from the rootDir path to the registered project id so the
      // bound workflow-settings resolver still sees the migrated VALUES
      // (FNXC:CentralProjectIdentity 2026-07-13-23:10).
      legacy.exec(`CREATE TABLE IF NOT EXISTS workflow_settings (
        workflowId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        "values" TEXT DEFAULT '{}',
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (workflowId, projectId)
      );`);
      legacy.prepare(
        `INSERT INTO workflow_settings (workflowId, projectId, "values", updatedAt) VALUES (?, ?, ?, ?)`,
      ).run("wf_default", rootDir, JSON.stringify({ maxWorktrees: 3 }), "2026-06-01T00:00:00Z");
    } finally {
      legacy.close();
    }

    // Legacy central registry that knows this project by its rootDir path.
    const legacyCentral = new DatabaseSync(join(globalDir, "fusion-central.db"));
    try {
      legacyCentral.exec(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );`);
      legacyCentral.prepare(
        `INSERT INTO projects (id, name, path, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("proj_stamp_test", "Stamp Test", rootDir, "active", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    } finally {
      legacyCentral.close();
    }

    const boot = await createTaskStoreForBackend({
      rootDir,
      globalSettingsDir: globalDir,
      env: { DATABASE_URL: testUrl },
    });
    expect(boot).not.toBeNull();
    try {
      const layer = boot!.taskStore.getAsyncLayer()!;
      /*
      FNXC:CentralProjectIdentity 2026-07-13-22:00:
      A rootDir-only boot of a REGISTERED project must bind its layer to the
      registry id — cwd/rootDir is only the lookup key; identity comes from
      central.projects.
      */
      expect(layer.projectId, "rootDir-only boot must bind to the registered project id").toBe("proj_stamp_test");
      const rows = (await layer.db.execute(
        `SELECT id, project_id FROM project.tasks ORDER BY id`,
      )) as unknown as Array<{ id: string; project_id: string | null }>;
      expect(rows.map((r) => r.id)).toContain("FN-STAMP-1");
      for (const row of rows) {
        expect(row.project_id, `${row.id} must be stamped with the registered project id`).toBe("proj_stamp_test");
      }
      // The migrated legacy config row ('' key) must be re-keyed to the
      // project so bound settings reads see the migrated settings.
      const configRows = (await layer.db.execute(
        `SELECT project_id, settings FROM project.config`,
      )) as unknown as Array<{ project_id: string; settings: { taskPrefix?: string } | null }>;
      const projectConfig = configRows.find((r) => r.project_id === "proj_stamp_test");
      expect(projectConfig, "migrated config row must be re-keyed to the project").toBeDefined();
      expect(projectConfig!.settings?.taskPrefix).toBe("ST");
      expect(configRows.some((r) => r.project_id === ""), "no orphaned '' config row").toBe(false);
      /*
      FNXC:CentralProjectIdentity 2026-07-13-23:10:
      The migrated workflow_settings row, keyed by the pre-isolation rootDir
      path string, must be re-keyed to the registered project id so a bound
      workflow-settings resolver still sees the migrated VALUES. Before the
      stamping re-key, this row stayed rootDir-keyed and vanished from every
      project-bound read.
      */
      const wfRows = (await layer.db.execute(
        `SELECT workflow_id, project_id, "values" FROM project.workflow_settings ORDER BY workflow_id`,
      )) as unknown as Array<{ workflow_id: string; project_id: string; values: { maxWorktrees?: number } | null }>;
      const wfRow = wfRows.find((r) => r.workflow_id === "wf_default");
      expect(wfRow, "migrated workflow_settings row must survive the migration").toBeDefined();
      expect(
        wfRow!.project_id,
        "workflow_settings row must be re-keyed from the rootDir path to the registered project id",
      ).toBe("proj_stamp_test");
      expect(wfRow!.values?.maxWorktrees).toBe(3);
      expect(
        wfRows.some((r) => r.project_id === rootDir),
        "no workflow_settings row may remain keyed by the rootDir path",
      ).toBe(false);
    } finally {
      await boot!.shutdown();
    }
  });

  /*
  FNXC:CentralProjectIdentity 2026-07-13-23:10:
  Direct unit-ish coverage of the shared stampMigratedProjectRows helper: seed a
  freshly-baselined PG schema with unstamped rows (NULL project_id tasks, ''
  config, rootDir-keyed workflow settings/prompt overrides), run the helper, and
  assert every table is re-keyed to the supplied project id — including the
  NOT_EXISTS guard that refuses to clobber a pre-existing per-project row.
  */
  it("stampMigratedProjectRows re-keys all partitioned tables to the project id", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "stamp-helper-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    const fakeRootDir = "/legacy/path/to/project";

    const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
    const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
    const { stampMigratedProjectRows } = await import("../../postgres/migration-stamping.js");
    const { recordSqliteMigrationComplete } = await import("../../postgres/sqlite-migrator.js");
    const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");

    const connections = await createConnectionSetFromUrl(
      resolveBackendWithOptions({ databaseUrl: testUrl }),
      { poolMax: 1, connectTimeoutSeconds: 30 },
    );
    try {
      await applySchemaBaseline(connections.migration);
      const db = connections.migration;

      /*
      FNXC:ProjectMigrationStamping 2026-07-14-16:50:
      Migration 0006 rewrites explicit empty ownership to the quarantine before this post-copy helper runs. A unique migration-ledger owner makes those freshly quarantined rows safe to claim; a second project marker must leave later quarantine rows untouched.
      */
      await recordSqliteMigrationComplete(db, "project:proj_help", "proj_help");
      await db.execute(
        `INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
         VALUES ('', 'FN-HELP-1', 'd', 'todo', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
      );
      await db.execute(
        `INSERT INTO project.config (project_id, settings, updated_at)
         VALUES ('', '{"taskPrefix":"HL"}'::jsonb, '2026-06-01T00:00:00Z')`,
      );
      await db.execute(
        `INSERT INTO project.workflow_settings (workflow_id, project_id, "values", updated_at)
         VALUES ('wf_a', '${fakeRootDir}', '{"maxWorktrees":5}'::jsonb, '2026-06-01T00:00:00Z')`,
      );
      // A pre-existing per-project row for wf_b: the rootDir-keyed migrated copy
      // must NOT clobber it (NOT_EXISTS guard).
      await db.execute(
        `INSERT INTO project.workflow_settings (workflow_id, project_id, "values", updated_at)
         VALUES ('wf_b', 'proj_help', '{"maxWorktrees":9}'::jsonb, '2026-06-01T00:00:00Z')`,
      );
      await db.execute(
        `INSERT INTO project.workflow_settings (workflow_id, project_id, "values", updated_at)
         VALUES ('wf_b', '${fakeRootDir}', '{"maxWorktrees":1}'::jsonb, '2026-06-01T00:00:00Z')`,
      );
      await db.execute(
        `INSERT INTO project.workflow_prompt_overrides (workflow_id, project_id, overrides, updated_at)
         VALUES ('wf_a', '${fakeRootDir}', '{"executor":"x"}'::jsonb, '2026-06-01T00:00:00Z')`,
      );

      /*
      FNXC:ProjectMigrationStamping 2026-07-14-21:55:
      Force the last table promotion to fail and prove earlier task/config/workflow updates roll back with it; a retry after removing the fault must then stamp the complete project.
      */
      await db.execute(`
        CREATE FUNCTION public.fail_migration_stamp_for_test() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced migration stamp failure'; END $$;
        CREATE TRIGGER fail_migration_stamp_for_test
        BEFORE UPDATE ON project.workflow_prompt_overrides
        FOR EACH ROW EXECUTE FUNCTION public.fail_migration_stamp_for_test();
      `);
      await expect(stampMigratedProjectRows(db, { projectId: "proj_help", rootDir: fakeRootDir }))
        .rejects.toThrow("Failed query: UPDATE project.workflow_prompt_overrides");
      const rolledBackTask = (await db.execute(
        `SELECT project_id FROM project.tasks WHERE id = 'FN-HELP-1'`,
      )) as unknown as Array<{ project_id: string }>;
      expect(rolledBackTask[0]?.project_id).toBe("__legacy_unscoped__");
      const rolledBackWorkflow = (await db.execute(
        `SELECT project_id FROM project.workflow_settings WHERE workflow_id = 'wf_a'`,
      )) as unknown as Array<{ project_id: string }>;
      expect(rolledBackWorkflow[0]?.project_id).toBe(fakeRootDir);
      await db.execute(`
        DROP TRIGGER fail_migration_stamp_for_test ON project.workflow_prompt_overrides;
        DROP FUNCTION public.fail_migration_stamp_for_test();
      `);

      const result = await stampMigratedProjectRows(db, { projectId: "proj_help", rootDir: fakeRootDir });
      expect(result.stamped).toBe(true);

      const tasks = (await db.execute(
        `SELECT project_id FROM project.tasks WHERE id = 'FN-HELP-1'`,
      )) as unknown as Array<{ project_id: string | null }>;
      expect(tasks[0]?.project_id).toBe("proj_help");

      const cfg = (await db.execute(
        `SELECT project_id FROM project.config ORDER BY project_id`,
      )) as unknown as Array<{ project_id: string }>;
      expect(cfg.some((r) => r.project_id === "proj_help")).toBe(true);
      expect(cfg.some((r) => r.project_id === "")).toBe(false);

      const wf = (await db.execute(
        `SELECT workflow_id, project_id, "values" FROM project.workflow_settings ORDER BY workflow_id, project_id`,
      )) as unknown as Array<{ workflow_id: string; project_id: string; values: { maxWorktrees?: number } | null }>;
      // wf_a re-keyed to proj_help.
      const wfA = wf.find((r) => r.workflow_id === "wf_a");
      expect(wfA?.project_id).toBe("proj_help");
      expect(wfA?.values?.maxWorktrees).toBe(5);
      // wf_b keeps its pre-existing per-project row (value 9); the rootDir copy
      // was NOT re-keyed (guard) so it remains keyed by the fake rootDir.
      const wfBProject = wf.find((r) => r.workflow_id === "wf_b" && r.project_id === "proj_help");
      expect(wfBProject?.values?.maxWorktrees, "pre-existing per-project row must not be clobbered").toBe(9);
      const wfBLegacy = wf.find((r) => r.workflow_id === "wf_b" && r.project_id === fakeRootDir);
      expect(wfBLegacy, "guarded rootDir row is left in place for manual reconciliation").toBeDefined();
      // No wf_a row remains keyed by the fake rootDir path.
      expect(wf.some((r) => r.workflow_id === "wf_a" && r.project_id === fakeRootDir)).toBe(false);

      const overrides = (await db.execute(
        `SELECT project_id FROM project.workflow_prompt_overrides WHERE workflow_id = 'wf_a'`,
      )) as unknown as Array<{ project_id: string }>;
      expect(overrides[0]?.project_id).toBe("proj_help");

      await recordSqliteMigrationComplete(db, "project:other", "other");
      await db.execute(
        `INSERT INTO project.tasks (project_id, id, description, "column", created_at, updated_at)
         VALUES ('', 'FN-AMBIGUOUS', 'd', 'todo', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
      );
      await stampMigratedProjectRows(db, { projectId: "proj_help", rootDir: fakeRootDir });
      const ambiguous = (await db.execute(
        `SELECT project_id FROM project.tasks WHERE id = 'FN-AMBIGUOUS'`,
      )) as unknown as Array<{ project_id: string }>;
      expect(ambiguous[0]?.project_id, "multi-project quarantine must not be claimed").toBe("__legacy_unscoped__");

      // No-op when projectId is empty.
      const noop = await stampMigratedProjectRows(db, { projectId: "", rootDir: fakeRootDir });
      expect(noop.stamped).toBe(false);
    } finally {
      await connections.close().catch(() => undefined);
    }
  });

  /*
  FNXC:MultiProjectMigration 2026-07-13-22:37:
  A rootDir-only boot must resolve project identity before deciding whether PostgreSQL is empty. Existing rows owned by project A must not suppress project B's first-boot migration, and inserted rows plus verification must stay scoped to the corresponding registry identity.
  */
  it("migrates a second registered rootDir-only project after the first project has rows", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-two-projects-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    const projectA = join(rootDir, "project-a");
    const projectB = join(rootDir, "project-b");
    const globalDir = join(rootDir, "global");
    seedLegacyTask(projectA, "A-1", "Project A task");
    seedLegacyTask(projectB, "B-1", "Project B task");
    seedLegacyRegistry(globalDir, [
      { id: "project-a", path: projectA },
      { id: "project-b", path: projectB },
    ]);

    const first = await createTaskStoreForBackend({ rootDir: projectA, globalSettingsDir: globalDir, env: { DATABASE_URL: testUrl } });
    expect(first).not.toBeNull();
    await first!.shutdown();

    /*
    FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
    Central SQLite is a one-time cluster source. A legitimate PostgreSQL-side update after project A's cutover must survive project B startup; re-verifying central content for B caused the reported plugin_installs checksum failure.
    */
    const betweenProjects = postgres(testUrl, { max: 1 });
    try {
      await betweenProjects`UPDATE central.projects SET name = 'Updated in PostgreSQL' WHERE id = 'project-a'`;
    } finally {
      await betweenProjects.end();
    }

    const second = await createTaskStoreForBackend({ rootDir: projectB, globalSettingsDir: globalDir, env: { DATABASE_URL: testUrl } });
    expect(second).not.toBeNull();
    try {
      expect(second!.taskStore.getAsyncLayer()!.projectId).toBe("project-b");
      expect((await second!.taskStore.getTask("B-1")).title).toBe("Project B task");
      await expect(second!.taskStore.getTask("A-1")).rejects.toThrow();
      const client = postgres(testUrl, { max: 1 });
      try {
        const projects = await client<{ name: string }[]>`SELECT name FROM central.projects WHERE id = 'project-a'`;
        expect(projects).toEqual([{ name: "Updated in PostgreSQL" }]);
        const centralMarkers = await client<{ status: string }[]>`
          SELECT status FROM public.fusion_sqlite_migrations
          WHERE migration_key = 'central:legacy-sqlite'
        `;
        expect(centralMarkers).toEqual([{ status: "complete" }]);
      } finally {
        await client.end();
      }
    } finally {
      await second!.shutdown();
    }
  });

  /*
  FNXC:ProjectTaskIdentity 2026-07-14-12:32:
  Legacy task IDs are project-local. Two projects migrating the same task ID must each retain its own row and title without a collision or cross-project attribution.
  */
  it("migrates the same legacy task id independently for two projects", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-project-collision-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    const projectA = join(rootDir, "project-a");
    const projectB = join(rootDir, "project-b");
    const globalDir = join(rootDir, "global");
    seedLegacyTask(projectA, "SHARED-1", "Project A owns this id");
    seedLegacyTask(projectB, "SHARED-1", "Project B collides");
    seedLegacyRegistry(globalDir, [
      { id: "project-a", path: projectA },
      { id: "project-b", path: projectB },
    ]);

    const first = await createTaskStoreForBackend({ rootDir: projectA, globalSettingsDir: globalDir, env: { DATABASE_URL: testUrl } });
    expect(first).not.toBeNull();
    await first!.shutdown();

    const second = await createTaskStoreForBackend({ rootDir: projectB, globalSettingsDir: globalDir, env: { DATABASE_URL: testUrl } });
    expect(second).not.toBeNull();
    await second!.shutdown();

    const client = postgres(testUrl, { max: 1 });
    try {
      const rows = await client<{ title: string; project_id: string | null }[]>`
        SELECT title, project_id FROM project.tasks WHERE id = 'SHARED-1' ORDER BY project_id
      `;
      expect(rows).toEqual([
        { title: "Project A owns this id", project_id: "project-a" },
        { title: "Project B collides", project_id: "project-b" },
      ]);
    } finally {
      await client.end();
    }
  });

  /*
  FNXC:PostgresMigrationVerification 2026-07-13-22:37:
  Verification failure is a hard startup boundary. ID collisions or unmapped operator tables may leave attempted rows behind for diagnosis, but startup must close connections and must not stamp rows or persist the successful-migration notice.
  */
  it("fails closed without a success notice when migration verification fails", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "startup-factory-fail-closed-"));
    dbName = uniqueDbName();
    adminExec(`CREATE DATABASE "${dbName}"`);
    const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
    seedLegacyTask(rootDir, "FAIL-1", "Must not be announced as migrated");
    const legacy = new DatabaseSync(join(rootDir, ".fusion", "fusion.db"));
    try {
      legacy.exec(`CREATE TABLE operator_extension_data (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
      legacy.prepare(`INSERT INTO operator_extension_data VALUES (?, ?)`).run("opaque-1", "preserve me");
    } finally {
      legacy.close();
    }

    await expect(
      createTaskStoreForBackend({ rootDir, env: { DATABASE_URL: testUrl } }),
    ).rejects.toThrow(/failed verification.*operator_extension_data/i);

    const client = postgres(testUrl, { max: 1 });
    try {
      const configs = await client<{ settings: unknown }[]>`SELECT settings FROM project.config`;
      expect(configs.some((row) => JSON.stringify(row.settings).includes("sqliteMigrationNotice"))).toBe(false);
      const tasks = await client<{ project_id: string | null }[]>`SELECT project_id FROM project.tasks WHERE id = 'FAIL-1'`;
      expect(tasks[0]?.project_id).toMatch(/^local-[a-f0-9]{24}$/);
    } finally {
      await client.end();
    }

    /*
     * FNXC:PostgresMigration 2026-07-14-00:05:
     * The first attempt copied its task before the unmapped table failed.
     * Removing the source defect and rebooting must resume from the durable
     * incomplete marker even though PostgreSQL is no longer empty.
     */
    const repairedLegacy = new DatabaseSync(join(rootDir, ".fusion", "fusion.db"));
    try {
      repairedLegacy.exec("DROP TABLE operator_extension_data");
    } finally {
      repairedLegacy.close();
    }
    const retried = await createTaskStoreForBackend({ rootDir, env: { DATABASE_URL: testUrl } });
    expect(retried).not.toBeNull();
    try {
      expect((await retried!.taskStore.getTask("FAIL-1")).title).toBe("Must not be announced as migrated");
    } finally {
      await retried!.shutdown();
    }
    const verifyClient = postgres(testUrl, { max: 1 });
    try {
      const states = await verifyClient<{ status: string }[]>`
        SELECT status FROM public.fusion_sqlite_migrations
        WHERE migration_key LIKE 'project:local-%'
      `;
      expect(states).toEqual([{ status: "complete" }]);
    } finally {
      await verifyClient.end();
    }
  });
});
