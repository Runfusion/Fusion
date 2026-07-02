import { appendFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentLogFilePath } from "../agent-log-file-store.js";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execSync: vi.fn((...args: Parameters<typeof mod.execSync>) => mod.execSync(...args)),
  };
});

vi.mock("../run-command.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../run-command.js")>();
  return {
    ...mod,
    runCommandAsync: vi.fn((...args: Parameters<typeof mod.runCommandAsync>) => mod.runCommandAsync(...args)),
  };
});

import { execSync } from "node:child_process";
import { runCommandAsync } from "../run-command.js";
import { Database, setInMemoryTemplateSnapshot } from "../db.js";
import { DEFAULT_PROJECT_SETTINGS } from "../types.js";
import { TaskStore, TaskHasDependentsError } from "../store.js";
import type { Task } from "../types.js";

export { TaskStore, TaskHasDependentsError };

export const mockedExecSync = vi.mocked(execSync);
export const mockedRunCommandAsync = vi.mocked(runCommandAsync);

const truncationSqlCache = new WeakMap<Database, string>();

export function buildTruncationSql(db: Database): string {
  const cached = truncationSqlCache.get(db);
  if (cached) {
    return cached;
  }

  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;

  const sql = rows
    .map((row) => row.name)
    .filter((name) => {
      if (name === "__meta") {
        return false;
      }
      if (name.startsWith("sqlite_")) {
        return false;
      }
      if (name.endsWith("_fts")) {
        return false;
      }
      if (name.match(/_fts_(data|idx|content|docsize|config)$/)) {
        return false;
      }
      return true;
    })
    .map((name) => `DELETE FROM "${name}";`)
    .join("\n");

  truncationSqlCache.set(db, sql);
  return sql;
}

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-test-"));
}

/*
 * FNXC:CoreTests 2026-06-25-16:30:
 * Migrated in-memory DB snapshot for DB-backed test suites.
 *
 * db.init() replays SCHEMA_SQL + ~129 migrations on every fresh in-memory DB
 * (~30-90ms each). Suites that build a new store per test (AgentStore,
 * MissionStore, TaskStore, dashboard route stores, …) pay that cost hundreds of
 * times. This harness migrates ONE in-memory DB per test file, serializes it,
 * and registers the bytes via setInMemoryTemplateSnapshot so every later
 * in-memory Database is restored from the snapshot instead of re-migrating.
 *
 * Isolation is unchanged: each test still constructs its own brand-new
 * in-memory DB; only the migration work is amortized. Disk-backed stores
 * (cross-instance persistence tests) are never touched by the snapshot.
 *
 * Usage:
 *   beforeAll(() => installInMemoryDbSnapshot());
 *   afterAll(() => clearInMemoryDbSnapshot());
 * Leave existing per-test `new <Store>({ inMemoryDb: true }); init()` as-is.
 */
let cachedMigratedSnapshot: Uint8Array | null = null;

export function installInMemoryDbSnapshot(): void {
  if (process.env.FN_NO_SNAPSHOT === "1") return; // A/B benchmark escape hatch
  if (!cachedMigratedSnapshot) {
    // Build the template with the hook OFF so this DB runs real migrations once.
    setInMemoryTemplateSnapshot(null);
    const templateDir = makeTmpDir();
    const template = new Database(templateDir, { inMemory: true });
    try {
      template.init();
      cachedMigratedSnapshot = template.serializeSnapshot();
    } finally {
      template.close();
    }
  }
  setInMemoryTemplateSnapshot(cachedMigratedSnapshot);
}

export function clearInMemoryDbSnapshot(): void {
  setInMemoryTemplateSnapshot(null);
}

async function clearDirectoryContents(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
  } catch {
    // ignored
  }
}

function resetMockPassThroughs() {
  mockedExecSync.mockReset();
  mockedRunCommandAsync.mockReset();

  mockedExecSync.mockImplementation((...args: Parameters<typeof execSync>) => execSync(...args));
  mockedRunCommandAsync.mockImplementation((...args: Parameters<typeof runCommandAsync>) =>
    runCommandAsync(...args),
  );
}

async function resetStoreFilesystem(rootDir: string, globalDir: string, store: TaskStore): Promise<void> {
  /*
   * FNXC:CoreTests 2026-06-25-03:32:
   * The shared harness reuses a TaskStore while clearing globalDir between tests.
   * Close and null the lazy PluginStore first so its file-backed central DB never survives after fusion-central.db is removed.
   */
  (store as any).pluginStore?.close?.();
  (store as any).pluginStore = null;

  const fusionDir = store.getFusionDir();
  await clearDirectoryContents(join(fusionDir, "tasks"));
  await clearDirectoryContents(join(fusionDir, "task-documents"));
  await clearDirectoryContents(join(fusionDir, "agent-logs"));
  try {
    (store as any)._archiveDb?.close?.();
  } catch {
    // ignored
  }
  (store as any)._archiveDb = null;
  await rm(join(fusionDir, "archive.db"), { force: true });
  await clearDirectoryContents(globalDir);

  const config = await (store as any).readConfig();
  const content = (store as any).serializeConfigForDisk(config);
  await writeFile(join(rootDir, ".fusion", "config.json"), content);
}

function resetTaskStorePrivateState(store: TaskStore): void {
  // IMPORTANT: if TaskStore introduces new private caches/memoized state,
  // update this reset list or shared-harness tests will leak cross-test state.
  (store as any).taskCache?.clear?.();
  (store as any).debounceTimers?.clear?.();
  (store as any).taskLocks?.clear?.();
  (store as any).workflowStepsCache = null;
  (store as any).taskIdStateReconciled = false;
  (store as any).taskIdIntegrityReport = (store as any).buildTaskIdIntegrityFallbackReport?.();
  (store as any).lastTaskIdIntegrityLogSignature = null;
  (store as any).distributedTaskIdAllocator = null;
  (store as any)._archiveDb = null;
  if ((store as any).agentLogFlushTimer) {
    clearTimeout((store as any).agentLogFlushTimer);
    (store as any).agentLogFlushTimer = null;
  }
  if (Array.isArray((store as any).agentLogBuffer)) {
    (store as any).agentLogBuffer.length = 0;
  }
  (store as any).globalSettingsStore.cachedSettings = null;
}

export function createTaskStoreTestHarness() {
  let rootDir = "";
  let globalDir = "";
  let store: TaskStore;

  return {
    rootDir: () => rootDir,
    globalDir: () => globalDir,
    store: () => store,
    beforeEach: async () => {
      vi.useRealTimers();
      rootDir = makeTmpDir();
      globalDir = makeTmpDir();
      store = new TaskStore(rootDir, globalDir);
      await store.init();
    },
    afterEach: async () => {
      vi.useRealTimers();
      store.stopWatching();
      await delay(0);
      await store.close();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
    reopenDiskBackedStore: async () => {
      store.close();
      store = new TaskStore(rootDir, globalDir);
      await store.init();
    },
    createTestTask: async (): Promise<Task> => store.createTask({ description: "Test task" }),
    createTaskWithSteps: async (): Promise<Task> => {
      const task = await store.createTask({ description: "Task with steps" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with steps

## Steps

### Step 0: Preflight

- [ ] Check things

### Step 1: Implementation

- [ ] Do stuff

### Step 2: Testing

- [ ] Test stuff
`,
      );
      return task;
    },
    deleteTaskDir: async (taskId: string): Promise<string> => {
      const dir = join(rootDir, ".fusion", "tasks", taskId);
      await rm(dir, { recursive: true, force: true });
      return dir;
    },
    createSourceIssueFixture: () => ({
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "I_kgDOExample",
      issueNumber: 2471,
      url: "https://github.com/runfusion/fusion/issues/2471",
    }),
    insertLogEntryWithTimestamp: (...args: any[]): void => {
      let targetStore: TaskStore = store;
      let taskId: string;
      let text: string;
      let type: string;
      let timestamp: string;
      let detail: string | undefined;
      let agent: string | undefined;

      if (typeof args[0] === "object") {
        [targetStore, taskId, text, type, timestamp, detail, agent] = args;
      } else {
        [taskId, text, type, timestamp, detail, agent] = args;
      }

      const taskDir = join((targetStore as any).getFusionDir(), "tasks", taskId);
      mkdirSync(taskDir, { recursive: true });
      appendFileSync(
        getAgentLogFilePath(taskDir),
        `${JSON.stringify({
          taskId,
          timestamp,
          text,
          type,
          ...(detail !== undefined && { detail }),
          ...(agent !== undefined && { agent }),
        })}\n`,
        "utf8",
      );
    },
  };
}

export function createSharedTaskStoreTestHarness() {
  let rootDir = "";
  let globalDir = "";
  let sharedStore: TaskStore;
  let currentStore: TaskStore;
  let isolatedStore: TaskStore | null = null;
  let isolatedRootDir: string | null = null;
  let isolatedGlobalDir: string | null = null;
  let configRowSnapshot: {
    nextId: number;
    nextWorkflowStepId: number;
    settings: string;
    workflowSteps: string;
  } = {
    nextId: 1,
    nextWorkflowStepId: 1,
    settings: JSON.stringify(DEFAULT_PROJECT_SETTINGS),
    workflowSteps: "[]",
  };
  let distributedStateSnapshot: Array<{
    prefix: string;
    nextSequence: number;
    committedClusterTaskCount: number;
    lastCommittedTaskId: string | null;
    updatedAt: string;
  }> = [];

  const resetConfigRow = (db: Database) => {
    const now = new Date().toISOString();
    db.prepare("DELETE FROM config").run();
    db.prepare(
      `INSERT INTO config (id, nextId, nextWorkflowStepId, settings, workflowSteps, updatedAt)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      configRowSnapshot.nextId,
      configRowSnapshot.nextWorkflowStepId,
      configRowSnapshot.settings,
      configRowSnapshot.workflowSteps,
      now,
    );
  };

  const resetDistributedState = (db: Database) => {
    db.prepare("DELETE FROM distributed_task_id_reservations").run();
    db.prepare("DELETE FROM distributed_task_id_state").run();
    const insert = db.prepare(
      `INSERT INTO distributed_task_id_state
        (prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of distributedStateSnapshot) {
      insert.run(
        row.prefix,
        row.nextSequence,
        row.committedClusterTaskCount,
        row.lastCommittedTaskId,
        new Date().toISOString(),
      );
    }
  };

  const closeIsolatedStoreIfAny = async () => {
    if (!isolatedStore) {
      return;
    }
    try {
      isolatedStore.close();
    } catch {
      // ignored
    }
    isolatedStore = null;
    currentStore = sharedStore;
    if (isolatedRootDir) {
      await rm(isolatedRootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      isolatedRootDir = null;
    }
    if (isolatedGlobalDir) {
      await rm(isolatedGlobalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      isolatedGlobalDir = null;
    }
  };

  return {
    rootDir: () => (isolatedRootDir ?? rootDir),
    globalDir: () => (isolatedGlobalDir ?? globalDir),
    store: () => currentStore,
    beforeAll: async () => {
      rootDir = makeTmpDir();
      globalDir = makeTmpDir();
      sharedStore = new TaskStore(rootDir, globalDir);
      await sharedStore.init();
      currentStore = sharedStore;

      const db = (sharedStore as any).db as Database;
      const configRow = db
        .prepare("SELECT nextId, nextWorkflowStepId, settings, workflowSteps FROM config WHERE id = 1")
        .get() as typeof configRowSnapshot | undefined;
      if (configRow) {
        configRowSnapshot = configRow;
      }

      distributedStateSnapshot = db
        .prepare(
          `SELECT prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt
           FROM distributed_task_id_state
           ORDER BY prefix`,
        )
        .all() as typeof distributedStateSnapshot;
    },
    beforeEach: async () => {
      vi.useRealTimers();
      resetMockPassThroughs();
      currentStore = sharedStore;
      await closeIsolatedStoreIfAny();

      const db = (sharedStore as any).db as Database;
      const resetAllTablesSql = buildTruncationSql(db);
      db.transactionImmediate(() => {
        db.exec(resetAllTablesSql);
        db.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')`);
        resetConfigRow(db);
        resetDistributedState(db);
      });
      await resetStoreFilesystem(rootDir, globalDir, sharedStore);
      sharedStore.removeAllListeners();
      resetTaskStorePrivateState(sharedStore);
      (sharedStore as any).workflowStepsCache = null;
    },
    afterEach: async () => {
      vi.useRealTimers();
      currentStore.stopWatching();
      await delay(0);
      await closeIsolatedStoreIfAny();
      currentStore = sharedStore;
    },
    afterAll: async () => {
      await closeIsolatedStoreIfAny();
      sharedStore.close();
      await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
    /**
     * Opt out of shared in-memory reuse for disk-reopen/migration-shape tests.
     * Overusing this defeats the performance gains of createSharedTaskStoreTestHarness.
     */
    useIsolatedStore: async () => {
      await closeIsolatedStoreIfAny();
      isolatedRootDir = makeTmpDir();
      isolatedGlobalDir = makeTmpDir();
      isolatedStore = new TaskStore(isolatedRootDir, isolatedGlobalDir);
      await isolatedStore.init();
      currentStore = isolatedStore;
    },
    reopenDiskBackedStore: async () => {
      currentStore.close();
      currentStore = new TaskStore(isolatedRootDir ?? rootDir, isolatedGlobalDir ?? globalDir);
      await currentStore.init();
      if (isolatedStore) {
        isolatedStore = currentStore;
      }
    },
    createTestTask: async (): Promise<Task> => currentStore.createTask({ description: "Test task" }),
    createTaskWithSteps: async (): Promise<Task> => {
      const task = await currentStore.createTask({ description: "Task with steps" });
      const dir = join(isolatedRootDir ?? rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with steps

## Steps

### Step 0: Preflight

- [ ] Check things

### Step 1: Implementation

- [ ] Do stuff

### Step 2: Testing

- [ ] Test stuff
`,
      );
      return task;
    },
    deleteTaskDir: async (taskId: string): Promise<string> => {
      const dir = join(isolatedRootDir ?? rootDir, ".fusion", "tasks", taskId);
      await rm(dir, { recursive: true, force: true });
      return dir;
    },
    createSourceIssueFixture: () => ({
      provider: "github",
      repository: "runfusion/fusion",
      externalIssueId: "I_kgDOExample",
      issueNumber: 2471,
      url: "https://github.com/runfusion/fusion/issues/2471",
    }),
    insertLogEntryWithTimestamp: (...args: any[]): void => {
      let targetStore: TaskStore = currentStore;
      let taskId: string;
      let text: string;
      let type: string;
      let timestamp: string;
      let detail: string | undefined;
      let agent: string | undefined;

      if (typeof args[0] === "object") {
        [targetStore, taskId, text, type, timestamp, detail, agent] = args;
      } else {
        [taskId, text, type, timestamp, detail, agent] = args;
      }

      const taskDir = join((targetStore as any).getFusionDir(), "tasks", taskId);
      mkdirSync(taskDir, { recursive: true });
      appendFileSync(
        getAgentLogFilePath(taskDir),
        `${JSON.stringify({
          taskId,
          timestamp,
          text,
          type,
          ...(detail !== undefined && { detail }),
          ...(agent !== undefined && { agent }),
        })}\n`,
        "utf8",
      );
    },
  };
}
