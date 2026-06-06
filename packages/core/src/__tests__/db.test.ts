import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import {
  Database,
  createDatabase,
  quickCheckSqliteFile,
  toJson,
  toJsonNullable,
  fromJson,
  normalizeTaskComments,
  getSchemaSqlTableSchemas,
  MIGRATION_ONLY_TABLE_SCHEMAS,
} from "../db.js";
import { DEFAULT_PROJECT_SETTINGS } from "../types.js";
import { TaskStore } from "../store.js";
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ensureRoadmapSchema } from "../../../../plugins/fusion-plugin-roadmap/src/roadmap-schema.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

const createdTmpDirs = new Set<string>();
const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const TMP_DIR_CLEANUP_HOOK_KEY = Symbol.for("fusion.core.db-test.tmp-cleanup-hooks-installed");

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-db-test-"));
  createdTmpDirs.add(dir);
  return dir;
}

async function removeTrackedTmpDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    try {
      rmSync(dir, TMP_DIR_RM_OPTIONS);
    } catch {
      // best-effort fallback during teardown
    }
  } finally {
    createdTmpDirs.delete(dir);
  }
}

async function cleanupTmpDirsAsync(): Promise<void> {
  killLockChildrenSync();
  const cleanup = Array.from(createdTmpDirs);
  await Promise.all(cleanup.map((dir) => removeTrackedTmpDir(dir)));
}

function removeTrackedTmpDirSync(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort fallback during teardown
  } finally {
    createdTmpDirs.delete(dir);
  }
}

// Lock-helper child processes hold open WAL/SHM file handles on the test db.
// If a test is force-killed (timeout → fork recycle → SIGTERM) before its
// `lock.release()` finally runs, those children outlive the test process and
// block recursive removal of the parent tmp dir on macOS, leaking
// `kb-db-test-*` directories. Track them so cleanup can kill stragglers.
const activeLockChildren = new Set<ChildProcessWithoutNullStreams>();

function killLockChildrenSync(): void {
  const children = Array.from(activeLockChildren);
  for (const child of children) {
    try {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    } catch {
      // best-effort
    } finally {
      activeLockChildren.delete(child);
    }
  }
}

function cleanupTmpDirsSync(): void {
  killLockChildrenSync();
  const cleanup = Array.from(createdTmpDirs);
  for (const dir of cleanup) {
    removeTrackedTmpDirSync(dir);
  }
}

// Full-suite worker shutdown can skip Vitest's normal afterAll timing if the worker
// is already draining, so keep a process-level sync cleanup backstop for kb-db-test-*.
// (Signal handlers were tried here but vitest forks deliver SIGHUP/SIGTERM during
// the suite — re-raising killed the runner. The lock-child kill in
// `cleanupTmpDirsAsync`/`afterEach` covers the macOS file-handle case that was
// the actual leak driver.)
const processWithCleanupFlag = process as typeof process & {
  [TMP_DIR_CLEANUP_HOOK_KEY]?: boolean;
};
if (!processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY]) {
  process.once("beforeExit", cleanupTmpDirsSync);
  process.once("exit", cleanupTmpDirsSync);
  processWithCleanupFlag[TMP_DIR_CLEANUP_HOOK_KEY] = true;
}

afterAll(() => {
  cleanupTmpDirsSync();
});

async function holdWriteLock(
  dbPath: string,
  options?: { holdMs?: number; releaseMode?: "manual" | "timer" },
): Promise<{
  child: ChildProcessWithoutNullStreams;
  release: () => Promise<void>;
}> {
  const releaseMode = options?.releaseMode ?? "manual";
  const holdMs = options?.holdMs ?? 0;
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("LOCKED\\n");
    const release = () => {
      try { db.exec("COMMIT"); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    };
    if (${JSON.stringify(releaseMode)} === "timer") {
      setTimeout(release, ${holdMs});
    } else {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("RELEASE")) release();
      });
    }
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeLockChildren.add(child);
  child.once("exit", () => {
    activeLockChildren.delete(child);
  });

  const ready = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LOCKED")) {
        resolve();
      }
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Lock helper exited early (${code}): ${stderr || "no stderr"}`));
      }
    });
    child.once("error", reject);
  });

  await ready;

  return {
    child,
    release: async () => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      if (releaseMode === "timer") {
        await once(child, "exit");
        return;
      }
      child.stdin.write("RELEASE\n");
      await once(child, "exit");
    },
  };
}

describe("Database", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init(); // Explicit init required — createDatabase() does not auto-init
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await cleanupTmpDirsAsync();
  });

  describe("initialization", () => {
    it("creates the database file", () => {
      expect(existsSync(join(fusionDir, "fusion.db"))).toBe(true);
    });

    it("creates the .fusion directory if missing", () => {
      expect(existsSync(fusionDir)).toBe(true);
    });

    it("sets WAL journal mode", () => {
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
    });

    it("enables foreign keys", () => {
      const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    });

    it("sets WAL tuning pragmas for disk-backed databases", () => {
      const synchronous = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      const autoCheckpoint = db.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
      const journalSizeLimit = db.prepare("PRAGMA journal_size_limit").get() as { journal_size_limit: number };

      expect(synchronous.synchronous).toBe(2); // FULL
      expect(autoCheckpoint.wal_autocheckpoint).toBe(1000);
      expect(journalSizeLimit.journal_size_limit).toBe(4_194_304);
    });

    it("does not force WAL tuning pragmas for in-memory databases", () => {
      const memDb = new Database(fusionDir, { inMemory: true });
      memDb.init();

      const autoCheckpoint = memDb.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
      const journalSizeLimit = memDb.prepare("PRAGMA journal_size_limit").get() as { journal_size_limit: number };

      expect(autoCheckpoint.wal_autocheckpoint).toBe(1000);
      expect(journalSizeLimit.journal_size_limit).toBe(-1);

      memDb.close();
    });

    it("creates all expected tables", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const tableNames = tables.map((t) => t.name).sort();

      expect(tableNames).toContain("tasks");
      expect(tableNames).toContain("config");
      expect(tableNames).toContain("activityLog");
      expect(tableNames).toContain("archivedTasks");
      expect(tableNames).toContain("automations");
      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("agentHeartbeats");
      expect(tableNames).toContain("agentRuns");
      // agentLogEntries removed in migration 102 — now stored in per-task JSONL files
      expect(tableNames).toContain("agentTaskSessions");
      expect(tableNames).toContain("agentApiKeys");
      expect(tableNames).toContain("agentConfigRevisions");
      expect(tableNames).toContain("agentBlockedStates");
      expect(tableNames).toContain("__meta");
      // Mission hierarchy tables
      expect(tableNames).toContain("missions");
      expect(tableNames).toContain("milestones");
      expect(tableNames).toContain("slices");
      expect(tableNames).toContain("mission_features");
      expect(tableNames).toContain("mission_events");
      expect(tableNames).toContain("ai_sessions");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("agentRatings");
      expect(tableNames).toContain("task_documents");
      expect(tableNames).toContain("task_document_revisions");
      // Roadmap tables are plugin-owned (FN-3159) and initialized via plugin schema hooks.
      // Verification cache (migration 61)
      expect(tableNames).toContain("verification_cache");
      expect(tableNames).toContain("distributed_task_id_state");
      expect(tableNames).toContain("distributed_task_id_reservations");
    });

    it("creates all expected indexes", () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name).sort();

      expect(indexNames).toContain("idxActivityLogTimestamp");
      expect(indexNames).toContain("idxActivityLogType");
      expect(indexNames).toContain("idxActivityLogTaskId");
      expect(indexNames).toContain("idxDistributedTaskIdReservationsPrefixStatus");
      expect(indexNames).toContain("idxDistributedTaskIdReservationsExpiry");
      expect(indexNames).toContain("idxActivityLogTaskIdTimestamp");
      expect(indexNames).toContain("idxActivityLogTypeTimestamp");
      expect(indexNames).toContain("idxArchivedTasksId");
      expect(indexNames).toContain("idxAgentHeartbeatsAgentId");
      expect(indexNames).toContain("idxAgentHeartbeatsAgentIdTimestamp");
      expect(indexNames).toContain("idxAgentHeartbeatsRunId");
      expect(indexNames).toContain("idxAiSessionsStatus");
      expect(indexNames).toContain("idxAiSessionsStatusUpdatedAt");
      expect(indexNames).toContain("idxAiSessionsType");
      expect(indexNames).toContain("idxAiSessionsLock");
      expect(indexNames).toContain("idxAgentsState");
      expect(indexNames).toContain("idxMessagesCreatedAt");
      expect(indexNames).toContain("idxMessagesFrom");
      expect(indexNames).toContain("idxMessagesTo");
      expect(indexNames).toContain("idxAgentRatingsAgentId");
      expect(indexNames).toContain("idxAgentRatingsCreatedAt");
      expect(indexNames).toContain("idxMissionEventsMissionId");
      expect(indexNames).toContain("idxMissionEventsTimestamp");
      expect(indexNames).toContain("idxMissionEventsType");
      expect(indexNames).toContain("idxTaskDocumentsTaskKey");
      expect(indexNames).toContain("idxTaskDocumentsTaskId");
      expect(indexNames).toContain("idxTaskDocumentRevisionsTaskKey");
      expect(indexNames).toContain("idxAgentRunsAgentIdStartedAt");
      expect(indexNames).toContain("idxAgentRunsStatus");
      // agentLogEntries indexes removed in migration 102 — now stored in per-task JSONL files
      expect(indexNames).toContain("idxAgentApiKeysAgentId");
      expect(indexNames).toContain("idxAgentConfigRevisionsAgentIdCreatedAt");
      expect(indexNames).toContain("idxTasksCreatedAt");
      // Roadmap indexes are plugin-owned (FN-3159) and initialized via plugin schema hooks.
      // Verification cache index (migration 61)
      expect(indexNames).toContain("idxVerificationCacheRecordedAt");
    });

    it("seeds schema version", () => {
      expect(db.getSchemaVersion()).toBe(112);
      expect(db.getSchemaVersion()).toBe(112);
    });

    it("includes tokenUsageCacheWriteTokens on freshly initialized tasks table", () => {
      const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain("tokenUsageCacheWriteTokens");
    });

    it("creates branch_groups table, indexes, and autoMerge columns", () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toContain("branch_groups");

      const branchIndexes = db.prepare("PRAGMA index_list('branch_groups')").all() as Array<{ name: string }>;
      const indexNames = branchIndexes.map((row) => row.name);
      expect(indexNames).toContain("idxBranchGroupsSource");
      expect(indexNames).toContain("idxBranchGroupsBranchName");

      const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(taskColumns.map((column) => column.name)).toContain("autoMerge");

      const missionColumns = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
      expect(missionColumns.map((column) => column.name)).toContain("autoMerge");
    });
    it("seeds lastModified", () => {
      const ts = db.getLastModified();
      expect(ts).toBeGreaterThan(0);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });

    it("seeds bootstrappedAt and preserves it across reopen", () => {
      const bootstrappedAt = db.getBootstrappedAt();
      expect(bootstrappedAt).toBeTypeOf("number");
      expect(bootstrappedAt).toBeGreaterThan(0);
      expect(bootstrappedAt).toBeLessThanOrEqual(Date.now());

      const reopened = new Database(fusionDir);
      reopened.init();
      try {
        expect(reopened.getBootstrappedAt()).toBe(bootstrappedAt);
      } finally {
        reopened.close();
      }
    });

    it("seeds config row with all required fields", () => {
      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row).toBeDefined();
      expect(row.nextId).toBe(1);
      expect(row.nextWorkflowStepId).toBe(1);
      expect(row.settings).toBe(JSON.stringify(DEFAULT_PROJECT_SETTINGS));
      expect(row.workflowSteps).toBe("[]");
      expect(row.updatedAt).toBeTruthy();
      // updatedAt should be a valid ISO timestamp
      expect(new Date(row.updatedAt).toISOString()).toBe(row.updatedAt);
    });

    it("is idempotent - calling init() twice does not fail", () => {
      expect(() => db.init()).not.toThrow();
      expect(db.getSchemaVersion()).toBe(112);
      expect(db.getSchemaVersion()).toBe(112);
    });
    it("does not overwrite existing config on re-init", () => {
      // Update the config
      db.prepare("UPDATE config SET nextId = 42 WHERE id = 1").run();

      // Re-init
      db.init();

      // Should keep updated value
      const row = db.prepare("SELECT nextId FROM config WHERE id = 1").get() as any;
      expect(row.nextId).toBe(42);
    });

    it("sets wal_autocheckpoint to 1000", () => {
      const row = db.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
      expect(row.wal_autocheckpoint).toBe(1000);
    });

    it("sets journal_size_limit to 4 MB", () => {
      const row = db.prepare("PRAGMA journal_size_limit").get() as { journal_size_limit: number };
      expect(row.journal_size_limit).toBe(4194304);
    });

    it("sets synchronous to FULL (2)", () => {
      const row = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
      expect(row.synchronous).toBe(2); // FULL = 2
    });

    it("sets busy_timeout to 5000ms", () => {
      const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
      // node:sqlite returns PRAGMA results as objects; the key name varies
      const value = Object.values(row)[0];
      expect(value).toBe(5000);
    });

    it("skips WAL PRAGMAs for in-memory databases", () => {
      const memDb = new Database(":memory:", { inMemory: true });
      memDb.init();
      // journal_mode for :memory: is "memory", not "wal"
      const row = memDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("memory");
      memDb.close();
    });
  });

  describe("startup integrity check", () => {
    it("schedules full integrity check after init instead of blocking startup", () => {
      vi.useFakeTimers();
      const integritySpy = vi.spyOn(Database.prototype, "integrityCheck");

      const freshDir = makeTmpDir();
      const freshFusionDir = join(freshDir, ".fusion");
      const freshDb = new Database(freshFusionDir);

      try {
        expect(() => freshDb.init()).not.toThrow();
        expect(freshDb.integrityCheckPending).toBe(true);
        expect(integritySpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(60_000);

        expect(integritySpy).toHaveBeenCalledTimes(1);
        expect(freshDb.integrityCheckPending).toBe(false);
        expect(freshDb.integrityCheckLastRunAt).toBeTruthy();
      } finally {
        freshDb.close();
        removeTrackedTmpDirSync(freshDir);
        integritySpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("does not schedule duplicate background integrity checks across repeated init calls", () => {
      vi.useFakeTimers();
      const integritySpy = vi.spyOn(Database.prototype, "integrityCheck");
      const freshDir = makeTmpDir();
      const freshFusionDir = join(freshDir, ".fusion");
      const freshDb = new Database(freshFusionDir);

      try {
        freshDb.init();
        expect(freshDb.integrityCheckPending).toBe(true);

        freshDb.init();
        vi.advanceTimersByTime(60_000);

        expect(integritySpy).toHaveBeenCalledTimes(1);
      } finally {
        freshDb.close();
        removeTrackedTmpDirSync(freshDir);
        integritySpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("deduplicates background integrity check across multiple instances sharing a db path", () => {
      vi.useFakeTimers();
      const integritySpy = vi.spyOn(Database.prototype, "integrityCheck");
      const freshDir = makeTmpDir();
      const freshFusionDir = join(freshDir, ".fusion");
      const dbA = new Database(freshFusionDir);
      const dbB = new Database(freshFusionDir);

      try {
        dbA.init();
        dbB.init();

        expect(dbA.integrityCheckPending).toBe(true);
        expect(dbB.integrityCheckPending).toBe(true);

        vi.advanceTimersByTime(60_000);

        expect(integritySpy).toHaveBeenCalledTimes(1);
        expect(dbA.integrityCheckPending).toBe(false);
        expect(dbB.integrityCheckPending).toBe(false);
        expect(dbA.integrityCheckLastRunAt).toBeTruthy();
        expect(dbB.integrityCheckLastRunAt).toBeTruthy();
        expect(dbA.corruptionDetected).toBe(false);
        expect(dbB.corruptionDetected).toBe(false);
        expect(dbA.integrityCheckErrors).toEqual([]);
        expect(dbB.integrityCheckErrors).toEqual([]);
      } finally {
        dbA.close();
        dbB.close();
        removeTrackedTmpDirSync(freshDir);
        integritySpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("fans out corruption detection to all instances participating in shared background check", () => {
      vi.useFakeTimers();
      const integritySpy = vi.spyOn(Database.prototype, "integrityCheck").mockReturnValue({
        ok: false,
        errors: ["malformed database", "broken index"],
      });
      const freshDir = makeTmpDir();
      const freshFusionDir = join(freshDir, ".fusion");
      const dbA = new Database(freshFusionDir);
      const dbB = new Database(freshFusionDir);

      try {
        dbA.init();
        dbB.init();

        vi.advanceTimersByTime(60_000);

        expect(integritySpy).toHaveBeenCalledTimes(1);
        expect(dbA.integrityCheckPending).toBe(false);
        expect(dbB.integrityCheckPending).toBe(false);
        expect(dbA.integrityCheckLastRunAt).toBeTruthy();
        expect(dbB.integrityCheckLastRunAt).toBeTruthy();
        expect(dbA.corruptionDetected).toBe(true);
        expect(dbB.corruptionDetected).toBe(true);
        expect(dbA.integrityCheckErrors).toEqual(["malformed database", "broken index"]);
        expect(dbB.integrityCheckErrors).toEqual(["malformed database", "broken index"]);
      } finally {
        dbA.close();
        dbB.close();
        removeTrackedTmpDirSync(freshDir);
        integritySpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("change detection", () => {
    it("getLastModified returns a timestamp", () => {
      const ts = db.getLastModified();
      expect(typeof ts).toBe("number");
      expect(ts).toBeGreaterThan(0);
    });

    it("bumpLastModified strictly increases the timestamp", () => {
      // Set lastModified to a known past value
      db.prepare("UPDATE __meta SET value = '1000' WHERE key = 'lastModified'").run();
      expect(db.getLastModified()).toBe(1000);

      db.bumpLastModified();
      const after = db.getLastModified();
      expect(after).toBeGreaterThan(1000);
    });

    it("bumpLastModified is monotonic across rapid consecutive calls", () => {
      const values: number[] = [];
      for (let i = 0; i < 5; i++) {
        db.bumpLastModified();
        values.push(db.getLastModified());
      }
      // Each value must be strictly greater than the previous
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });

    it("lastModified survives close and reopen", () => {
      db.bumpLastModified();
      const ts = db.getLastModified();
      expect(ts).toBeGreaterThan(0);

      // Close and reopen
      db.close();
      const db2 = new Database(fusionDir);
      db2.init();

      expect(db2.getLastModified()).toBe(ts);
      db2.close();

      // Re-assign so afterEach doesn't fail
      db = new Database(fusionDir);
      db.init();
    });

    it("lastModified is stored as a row in __meta", () => {
      db.bumpLastModified();
      const row = db.prepare("SELECT key, value FROM __meta WHERE key = 'lastModified'").get() as { key: string; value: string };
      expect(row).toBeDefined();
      expect(row.key).toBe("lastModified");
      expect(parseInt(row.value, 10)).toBeGreaterThan(0);
    });

    it("both schemaVersion and lastModified exist in __meta", () => {
      const rows = db.prepare("SELECT key FROM __meta ORDER BY key").all() as { key: string }[];
      const keys = rows.map(r => r.key);
      expect(keys).toContain("schemaVersion");
      expect(keys).toContain("lastModified");
    });
  });

  describe("walCheckpoint", () => {
    it("runs WAL checkpoint and returns stats", () => {
      const result = db.walCheckpoint();
      expect(result).toHaveProperty("busy");
      expect(result).toHaveProperty("log");
      expect(result).toHaveProperty("checkpointed");
      expect(typeof result.busy).toBe("number");
      expect(typeof result.log).toBe("number");
      expect(typeof result.checkpointed).toBe("number");
    });

    it("supports explicit truncate checkpoints when requested", () => {
      const result = db.walCheckpoint("TRUNCATE");
      expect(result).toHaveProperty("busy");
      expect(result).toHaveProperty("log");
      expect(result).toHaveProperty("checkpointed");
    });
  });

  describe("vacuum", () => {
    it("returns a no-op result for in-memory databases", () => {
      const memDb = new Database(fusionDir, { inMemory: true });
      memDb.init();

      expect(memDb.vacuum()).toEqual({
        beforeBytes: 0,
        afterBytes: 0,
        durationMs: 0,
      });

      memDb.close();
    });

    it("runs disk-backed compaction and preserves stored rows", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      ).run("FN-VACUUM", "vacuum task", "todo", now, now);

      for (let i = 0; i < 100; i += 1) {
        db.prepare(
          "INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(`vac-${i}`, now, "task:updated", "FN-VACUUM", "vacuum task", `entry-${i}`, null);
      }

      const dbFile = join(fusionDir, "fusion.db");
      const expectedBeforeBytes = existsSync(dbFile) ? statSync(dbFile).size : 0;
      const result = db.vacuum();

      expect(result.beforeBytes).toBe(expectedBeforeBytes);
      expect(typeof result.beforeBytes).toBe("number");
      expect(typeof result.afterBytes).toBe("number");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const stored = db.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-VACUUM") as
        | { id: string }
        | undefined;
      expect(stored?.id).toBe("FN-VACUUM");
      const expectedAfterBytes = existsSync(dbFile) ? statSync(dbFile).size : 0;
      expect(result.afterBytes).toBe(expectedAfterBytes);
    });

    it("throws a descriptive error when checkpointing fails", () => {
      const checkpointSpy = vi
        .spyOn(db, "walCheckpoint")
        .mockImplementation(() => {
          throw new Error("checkpoint exploded");
        });

      expect(() => db.vacuum()).toThrow(
        /Database vacuum maintenance failed during WAL checkpoint.*checkpoint exploded/,
      );
      checkpointSpy.mockRestore();
    });
  });

  describe("transactions", () => {
    it("commits on success", () => {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-001", "Test task", "triage", "2025-01-01", "2025-01-01");
      });

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get() as any;
      expect(row).toBeDefined();
      expect(row.description).toBe("Test task");
    });

    it("rolls back on error", () => {
      expect(() => {
        db.transaction(() => {
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-002", "Test task 2", "triage", "2025-01-01", "2025-01-01");
          throw new Error("Simulated failure");
        });
      }).toThrow("Simulated failure");

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'KB-002'").get();
      expect(row).toBeUndefined();
    });

    it("returns the function result", async () => {
      const result = db.transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-003", "Test", "todo", "2025-01-01", "2025-01-01");
        return 42;
      });
      expect(result).toBe(42);
    });

    it("supports nested transactions via savepoints", () => {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-OUTER", "Outer task", "triage", "2025-01-01", "2025-01-01");

        // Nested transaction
        db.transaction(() => {
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-INNER", "Inner task", "triage", "2025-01-01", "2025-01-01");
        });
      });

      // Both should exist
      const outer = db.prepare("SELECT * FROM tasks WHERE id = 'FN-OUTER'").get();
      const inner = db.prepare("SELECT * FROM tasks WHERE id = 'FN-INNER'").get();
      expect(outer).toBeDefined();
      expect(inner).toBeDefined();
    });

    it("nested transaction rollback only affects inner scope", () => {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-OUTER2", "Outer task 2", "triage", "2025-01-01", "2025-01-01");

        try {
          db.transaction(() => {
            db.prepare(
              "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
            ).run("FN-INNER2", "Inner task 2", "triage", "2025-01-01", "2025-01-01");
            throw new Error("Inner failure");
          });
        } catch {
          // Expected — inner transaction rolled back
        }
      });

      // Outer should exist, inner should not
      const outer = db.prepare("SELECT * FROM tasks WHERE id = 'FN-OUTER2'").get();
      const inner = db.prepare("SELECT * FROM tasks WHERE id = 'FN-INNER2'").get();
      expect(outer).toBeDefined();
      expect(inner).toBeUndefined();
    });

    it("outer transaction can continue after inner rollback", () => {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-PRE", "Before inner", "triage", "2025-01-01", "2025-01-01");

        // Inner transaction fails
        try {
          db.transaction(() => {
            db.prepare(
              "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
            ).run("FN-FAIL", "Inner fail", "triage", "2025-01-01", "2025-01-01");
            throw new Error("Inner failure");
          });
        } catch {
          // Expected
        }

        // Additional work in outer transaction after inner rollback
        db.prepare(
          "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
        ).run("FN-POST", "After inner", "triage", "2025-01-01", "2025-01-01");
      });

      // PRE and POST should exist, FAIL should not
      expect(db.prepare("SELECT * FROM tasks WHERE id = 'FN-PRE'").get()).toBeDefined();
      expect(db.prepare("SELECT * FROM tasks WHERE id = 'FN-POST'").get()).toBeDefined();
      expect(db.prepare("SELECT * FROM tasks WHERE id = 'FN-FAIL'").get()).toBeUndefined();
    });

    it("transaction is atomic — partial writes roll back", () => {
      try {
        db.transaction(() => {
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-A", "Task A", "triage", "2025-01-01", "2025-01-01");
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-B", "Task B", "triage", "2025-01-01", "2025-01-01");
          // This should fail - duplicate PK
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-A", "Duplicate", "triage", "2025-01-01", "2025-01-01");
        });
      } catch {
        // expected
      }

      // Neither task should exist
      const rowA = db.prepare("SELECT * FROM tasks WHERE id = 'KB-A'").get();
      const rowB = db.prepare("SELECT * FROM tasks WHERE id = 'KB-B'").get();
      expect(rowA).toBeUndefined();
      expect(rowB).toBeUndefined();
    });

    it("allows deferred read-only transactions to start while another connection holds the writer lock", async () => {
      const dbPath = db.getPath();
      db.exec("PRAGMA busy_timeout = 0");
      const lock = await holdWriteLock(dbPath, { releaseMode: "manual" });
      let callbackCalls = 0;

      try {
        const rowCount = db.transaction(() => {
          callbackCalls += 1;
          return (db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count;
        });

        expect(rowCount).toBe(0);
      } finally {
        await lock.release();
      }

      expect(callbackCalls).toBe(1);
    });

    it("recovers outermost immediate transactions after a transient writer lock", async () => {
      const dbPath = db.getPath();
      db.exec("PRAGMA busy_timeout = 0");
      const lock = await holdWriteLock(dbPath, { releaseMode: "timer", holdMs: 150 });
      let callbackCalls = 0;

      try {
        db.transactionImmediate(() => {
          callbackCalls += 1;
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-LOCK-RECOVER", "Recovered after lock", "todo", "2025-01-01", "2025-01-01");
        });
      } finally {
        await lock.release();
      }

      const row = db.prepare("SELECT id, description FROM tasks WHERE id = ?").get("FN-LOCK-RECOVER") as
        | { id: string; description: string }
        | undefined;
      expect(callbackCalls).toBe(1);
      expect(row).toEqual({ id: "FN-LOCK-RECOVER", description: "Recovered after lock" });
    });

    it("preserves nested savepoint rollback semantics after recovering the outer immediate writer lock", async () => {
      const dbPath = db.getPath();
      db.exec("PRAGMA busy_timeout = 0");
      const lock = await holdWriteLock(dbPath, { releaseMode: "timer", holdMs: 150 });
      let callbackCalls = 0;

      try {
        db.transactionImmediate(() => {
          callbackCalls += 1;
          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-LOCK-OUTER", "Outer task", "todo", "2025-01-01", "2025-01-01");

          try {
            db.transaction(() => {
              db.prepare(
                "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
              ).run("FN-LOCK-INNER", "Inner task", "todo", "2025-01-01", "2025-01-01");
              throw new Error("inner rollback");
            });
          } catch (error) {
            expect((error as Error).message).toBe("inner rollback");
          }

          db.prepare(
            "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
          ).run("FN-LOCK-POST", "After inner rollback", "todo", "2025-01-01", "2025-01-01");
        });
      } finally {
        await lock.release();
      }

      expect(callbackCalls).toBe(1);
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-LOCK-OUTER")).toBeDefined();
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-LOCK-INNER")).toBeUndefined();
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-LOCK-POST")).toBeDefined();
    });

    it("fails without invoking the callback when an immediate lock outlives the recovery window", async () => {
      const retryDb = new Database(fusionDir, {
        busyTimeoutMs: 0,
        lockRecoveryWindowMs: 100,
        lockRecoveryDelayMs: 25,
      });
      retryDb.init();
      const lock = await holdWriteLock(retryDb.getPath(), { releaseMode: "manual" });
      let callbackCalls = 0;

      try {
        expect(() => {
          retryDb.transactionImmediate(() => {
            callbackCalls += 1;
            retryDb.prepare(
              "INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
            ).run("FN-LOCK-TIMEOUT", "Should not write", "todo", "2025-01-01", "2025-01-01");
          });
        }).toThrow(/BEGIN IMMEDIATE failed/);
      } finally {
        await lock.release();
        retryDb.close();
      }

      expect(callbackCalls).toBe(0);
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-LOCK-TIMEOUT")).toBeUndefined();
    });
  });

  describe("runPluginSchemaInits", () => {
    it("returns without error when no hooks are provided", async () => {
      await expect(db.runPluginSchemaInits([])).resolves.toBeUndefined();
    });

    it("executes a single schema hook and creates its table", async () => {
      await db.runPluginSchemaInits([
        {
          pluginId: "plugin-single",
          hook: (database) => {
            database.exec("CREATE TABLE IF NOT EXISTS plugin_single_table (id TEXT PRIMARY KEY)");
          },
        },
      ]);

      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_single_table'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("plugin_single_table");
    });

    it("executes multiple schema hooks in order", async () => {
      const order: string[] = [];
      await db.runPluginSchemaInits([
        {
          pluginId: "plugin-a",
          hook: (database) => {
            order.push("a");
            database.exec("CREATE TABLE IF NOT EXISTS plugin_table_a (id TEXT PRIMARY KEY)");
          },
        },
        {
          pluginId: "plugin-b",
          hook: (database) => {
            order.push("b");
            database.exec("CREATE TABLE IF NOT EXISTS plugin_table_b (id TEXT PRIMARY KEY)");
          },
        },
      ]);

      expect(order).toEqual(["a", "b"]);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plugin_table_a','plugin_table_b') ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(["plugin_table_a", "plugin_table_b"]);
    });

    it("continues executing hooks after a hook throws", async () => {
      await db.runPluginSchemaInits([
        {
          pluginId: "plugin-fail",
          hook: () => {
            throw new Error("boom");
          },
        },
        {
          pluginId: "plugin-after",
          hook: (database) => {
            database.exec("CREATE TABLE IF NOT EXISTS plugin_after_table (id TEXT PRIMARY KEY)");
          },
        },
      ]);

      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_after_table'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("plugin_after_table");
    });

    it("is idempotent when called repeatedly with the same hooks", async () => {
      const hooks = [
        {
          pluginId: "plugin-idempotent",
          hook: (database: Database) => {
            database.exec("CREATE TABLE IF NOT EXISTS plugin_idempotent_table (id TEXT PRIMARY KEY)");
            database.exec("CREATE INDEX IF NOT EXISTS idx_plugin_idempotent_id ON plugin_idempotent_table(id)");
          },
        },
      ];

      await expect(db.runPluginSchemaInits(hooks)).resolves.toBeUndefined();
      await expect(db.runPluginSchemaInits(hooks)).resolves.toBeUndefined();
    });

    it("executes roadmap plugin schema hook to create roadmap-owned tables and indexes", async () => {
      await db.runPluginSchemaInits([
        {
          pluginId: "fusion-plugin-roadmap",
          hook: ensureRoadmapSchema,
        },
      ]);

      const roadmapTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('roadmaps', 'roadmap_milestones', 'roadmap_features') ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(roadmapTables.map((table) => table.name)).toEqual([
        "roadmap_features",
        "roadmap_milestones",
        "roadmaps",
      ]);

      const roadmapIndexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idxRoadmapMilestonesRoadmapOrder', 'idxRoadmapFeaturesMilestoneOrder') ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(roadmapIndexes.map((index) => index.name)).toEqual([
        "idxRoadmapFeaturesMilestoneOrder",
        "idxRoadmapMilestonesRoadmapOrder",
      ]);
    });
  });

  describe("foreign key cascade", () => {
    it("deleting an agent cascades to heartbeats", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO agents (id, name, role, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("agent-1", "Agent 1", "executor", "idle", now, now);

      db.prepare(
        "INSERT INTO agentHeartbeats (agentId, timestamp, status, runId) VALUES (?, ?, ?, ?)"
      ).run("agent-1", now, "ok", "run-1");

      db.prepare(
        "INSERT INTO agentHeartbeats (agentId, timestamp, status, runId) VALUES (?, ?, ?, ?)"
      ).run("agent-1", now, "ok", "run-1");

      // Delete agent
      db.prepare("DELETE FROM agents WHERE id = 'agent-1'").run();

      // Heartbeats should be cascade-deleted
      const heartbeats = db.prepare("SELECT * FROM agentHeartbeats WHERE agentId = 'agent-1'").all();
      expect(heartbeats).toHaveLength(0);
    });
  });

  describe("integrity check", () => {
    it("returns ok for healthy databases and leaves corruption flag false", () => {
      expect(db.corruptionDetected).toBe(false);
      expect(db.integrityCheck()).toEqual({ ok: true });
      expect(db.integrityCheckErrors).toEqual([]);
    });

    it("keeps corruptionDetected false after init for healthy database", () => {
      const diskDb = new Database(fusionDir);
      diskDb.init();
      expect(diskDb.corruptionDetected).toBe(false);
      expect(diskDb.integrityCheckPending).toBe(true);
      diskDb.close();
    });

    it("skips background integrity check scheduling for in-memory databases", () => {
      const memDb = new Database(fusionDir, { inMemory: true });
      memDb.init();
      expect(memDb.integrityCheck()).toEqual({ ok: true });
      expect(memDb.corruptionDetected).toBe(false);
      expect(memDb.integrityCheckPending).toBe(false);
      expect(memDb.integrityCheckLastRunAt).toBeNull();
      memDb.close();
    });
  });

  describe("foreign key cascade across reopen", () => {
    it("cascade delete works after closing and reopening the database", () => {
      const now = new Date().toISOString();

      // Insert agent and heartbeats
      db.prepare(
        "INSERT INTO agents (id, name, role, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("agent-reopen", "Agent", "executor", "idle", now, now);
      db.prepare(
        "INSERT INTO agentHeartbeats (agentId, timestamp, status, runId) VALUES (?, ?, ?, ?)"
      ).run("agent-reopen", now, "ok", "run-1");

      // Close and reopen
      db.close();
      db = new Database(fusionDir);
      db.init();

      // Verify foreign key enforcement is active after reopen
      const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);

      // Delete agent — heartbeats should cascade
      db.prepare("DELETE FROM agents WHERE id = 'agent-reopen'").run();
      const heartbeats = db.prepare("SELECT * FROM agentHeartbeats WHERE agentId = 'agent-reopen'").all();
      expect(heartbeats).toHaveLength(0);
    });
  });

  describe("task round-trip", () => {
    it("stores and retrieves a fully populated task record", () => {
      const now = new Date().toISOString();
      const task = {
        id: "FN-100",
        title: "Full task test",
        description: "Test all fields",
        column: "in-progress",
        status: "running",
        size: "L",
        reviewLevel: 3,
        currentStep: 2,
        worktree: "/tmp/wt",
        blockedBy: "FN-099",
        paused: 1,
        baseBranch: "main",
        modelPresetId: "complex",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
        mergeRetries: 2,
        error: "Something went wrong",
        summary: "Fixed the bug",
        thinkingLevel: "high",
        createdAt: now,
        updatedAt: now,
        columnMovedAt: now,
        dependencies: JSON.stringify(["FN-098", "FN-097"]),
        steps: JSON.stringify([{ name: "Step 1", status: "done" }, { name: "Step 2", status: "in-progress" }]),
        log: JSON.stringify([{ timestamp: now, action: "Created" }]),
        attachments: JSON.stringify([{ filename: "test.png", originalName: "test.png", mimeType: "image/png", size: 1024, createdAt: now }]),
        comments: JSON.stringify([{ id: "c1", text: "Do this", createdAt: now, author: "user" }]),
        workflowStepResults: JSON.stringify([{ workflowStepId: "WS-001", workflowStepName: "QA", status: "passed" }]),
        prInfo: JSON.stringify({ url: "https://github.com/test/pr/1", number: 1, status: "open", title: "PR", headBranch: "feature", baseBranch: "main", commentCount: 0 }),
        issueInfo: JSON.stringify({ url: "https://github.com/test/issues/1", number: 1, state: "open", title: "Issue" }),
        breakIntoSubtasks: 1,
        enabledWorkflowSteps: JSON.stringify(["WS-001", "WS-002"]),
      };

      db.prepare(`
        INSERT INTO tasks (
          id, title, description, "column", status, size, reviewLevel, currentStep,
          worktree, blockedBy, paused, baseBranch, modelPresetId, modelProvider,
          modelId, validatorModelProvider, validatorModelId, mergeRetries, error,
          summary, thinkingLevel, createdAt, updatedAt, columnMovedAt,
          dependencies, steps, log, attachments, comments,
          workflowStepResults, prInfo, issueInfo, breakIntoSubtasks,
          enabledWorkflowSteps
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        task.id, task.title, task.description, task.column, task.status,
        task.size, task.reviewLevel, task.currentStep, task.worktree,
        task.blockedBy, task.paused, task.baseBranch, task.modelPresetId,
        task.modelProvider, task.modelId, task.validatorModelProvider,
        task.validatorModelId, task.mergeRetries, task.error, task.summary,
        task.thinkingLevel, task.createdAt, task.updatedAt, task.columnMovedAt,
        task.dependencies, task.steps, task.log, task.attachments,
        task.comments, task.workflowStepResults, task.prInfo,
        task.issueInfo, task.breakIntoSubtasks, task.enabledWorkflowSteps,
      );

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'FN-100'").get() as any;
      expect(row.id).toBe("FN-100");
      expect(row.title).toBe("Full task test");
      expect(row.column).toBe("in-progress");
      expect(row.thinkingLevel).toBe("high");
      expect(row.mergeRetries).toBe(2);
      expect(row.paused).toBe(1);
      expect(row.breakIntoSubtasks).toBe(1);

      // Verify JSON round-trip
      expect(JSON.parse(row.dependencies)).toEqual(["FN-098", "FN-097"]);
      expect(JSON.parse(row.steps)).toHaveLength(2);
      expect(JSON.parse(row.log)).toHaveLength(1);
      expect(JSON.parse(row.attachments)).toHaveLength(1);
      expect(JSON.parse(row.comments)).toHaveLength(1);
      expect(JSON.parse(row.workflowStepResults)).toHaveLength(1);
      expect(JSON.parse(row.prInfo).number).toBe(1);
      expect(JSON.parse(row.issueInfo).state).toBe("open");
      expect(JSON.parse(row.enabledWorkflowSteps)).toEqual(["WS-001", "WS-002"]);
    });
  });

  describe("config round-trip", () => {
    it("stores and retrieves config with nested settings and workflow steps", () => {
      const settings = {
        maxConcurrent: 4,
        autoMerge: false,
        taskPrefix: "PROJ",
      };
      const workflowSteps = [
        { id: "WS-001", name: "Doc Review", description: "Review docs", prompt: "Check docs", enabled: true, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
      ];

      db.prepare("UPDATE config SET settings = ?, workflowSteps = ?, nextId = ?, nextWorkflowStepId = ? WHERE id = 1")
        .run(JSON.stringify(settings), JSON.stringify(workflowSteps), 42, 2);

      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row.nextId).toBe(42);
      expect(row.nextWorkflowStepId).toBe(2);
      expect(JSON.parse(row.settings).maxConcurrent).toBe(4);
      expect(JSON.parse(row.settings).taskPrefix).toBe("PROJ");
      expect(JSON.parse(row.workflowSteps)).toHaveLength(1);
      expect(JSON.parse(row.workflowSteps)[0].id).toBe("WS-001");
    });
  });
});

describe("comment normalization", () => {
  it("merges overlapping legacy and unified comments exactly once", () => {
    const normalized = normalizeTaskComments(
      [{ id: "c1", text: "Legacy note", author: "user", createdAt: "2025-01-01T00:00:00.000Z" }],
      [{ id: "c1", text: "Legacy note", author: "user", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }],
    );

    expect(normalized.comments).toEqual([
      {
        id: "c1",
        text: "Legacy note",
        author: "user",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      },
    ]);
    expect(normalized.steeringComments).toHaveLength(1);
  });
});

describe("JSON helpers", () => {
  describe("toJson", () => {
    it("stringifies arrays", () => {
      expect(toJson(["a", "b"])).toBe('["a","b"]');
    });

    it("stringifies objects", () => {
      expect(toJson({ a: 1 })).toBe('{"a":1}');
    });

    it("returns '[]' for empty arrays", () => {
      expect(toJson([])).toBe("[]");
    });

    it("returns '[]' for undefined", () => {
      expect(toJson(undefined)).toBe("[]");
    });

    it("returns '[]' for null", () => {
      expect(toJson(null)).toBe("[]");
    });

    it("stringifies booleans", () => {
      expect(toJson(true)).toBe("true");
    });

    it("stringifies numbers", () => {
      expect(toJson(42)).toBe("42");
    });
  });

  describe("toJsonNullable", () => {
    it("stringifies objects", () => {
      expect(toJsonNullable({ a: 1 })).toBe('{"a":1}');
    });

    it("returns null for undefined", () => {
      expect(toJsonNullable(undefined)).toBeNull();
    });

    it("returns null for null", () => {
      expect(toJsonNullable(null)).toBeNull();
    });

    it("stringifies arrays", () => {
      expect(toJsonNullable(["a"])).toBe('["a"]');
    });
  });

  describe("fromJson", () => {
    it("parses arrays", () => {
      expect(fromJson<string[]>('["a","b"]')).toEqual(["a", "b"]);
    });

    it("parses objects", () => {
      expect(fromJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    });

    it("returns undefined for null", () => {
      expect(fromJson(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(fromJson(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(fromJson("")).toBeUndefined();
    });

    it("returns undefined for 'null' string", () => {
      expect(fromJson("null")).toBeUndefined();
    });

    it("returns undefined for invalid JSON", () => {
      expect(fromJson("{bad json")).toBeUndefined();
    });

    it("round-trips: fromJson(toJson([])) returns empty array", () => {
      expect(fromJson(toJson([]))).toEqual([]);
    });

    it("round-trips: fromJson(toJson(['a'])) returns the array", () => {
      expect(fromJson(toJson(["a"]))).toEqual(["a"]);
    });

    it("round-trips: fromJson(toJson({a:1})) returns the object", () => {
      expect(fromJson(toJson({ a: 1 }))).toEqual({ a: 1 });
    });

    it("round-trips: fromJson(toJson(undefined)) returns empty array (array-default)", () => {
      // toJson(undefined) = '[]', fromJson('[]') = []
      const result = fromJson(toJson(undefined));
      expect(result).toEqual([]);
    });
  });
});

describe("schema migrations", () => {
  let tmpDir: string;

  afterEach(async () => {
    await removeTrackedTmpDir(tmpDir);
  });

  it("migrates a v1 database by adding missing columns", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    // Create a v1 database manually (without comments and mergeDetails columns)
    const db = new Database(fusionDir);
    // Create tables without the new columns
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        status TEXT,
        size TEXT,
        reviewLevel INTEGER,
        currentStep INTEGER DEFAULT 0,
        worktree TEXT,
        blockedBy TEXT,
        paused INTEGER DEFAULT 0,
        baseBranch TEXT,
        modelPresetId TEXT,
        modelProvider TEXT,
        modelId TEXT,
        validatorModelProvider TEXT,
        validatorModelId TEXT,
        mergeRetries INTEGER,
        error TEXT,
        summary TEXT,
        thinkingLevel TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        columnMovedAt TEXT,
        dependencies TEXT DEFAULT '[]',
        steps TEXT DEFAULT '[]',
        log TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        steeringComments TEXT DEFAULT '[]',
        workflowStepResults TEXT DEFAULT '[]',
        prInfo TEXT,
        issueInfo TEXT,
        breakIntoSubtasks INTEGER DEFAULT 0,
        enabledWorkflowSteps TEXT DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS activityLog (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL,
        taskId TEXT, taskTitle TEXT, details TEXT NOT NULL, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS archivedTasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, archivedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        scheduleType TEXT NOT NULL, cronExpression TEXT NOT NULL, command TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, timeoutMs INTEGER, steps TEXT,
        nextRunAt TEXT, lastRunAt TEXT, lastRunResult TEXT,
        runCount INTEGER DEFAULT 0, runHistory TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle', taskId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        lastHeartbeatAt TEXT, metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS agentHeartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL, runId TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '1')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    // Insert a task on the v1 schema
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('KB-1', 'test', 'triage', '2025-01-01', '2025-01-01')`);

    // Now run init() which should trigger migration
    db.init();

    // Verify version bumped to 29 (includes v1→v2 through v26→v29)
    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    // Verify new columns exist and existing data is intact
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("comments");
    expect(colNames).toContain("mergeDetails");

    // Existing task should still be readable
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'KB-1'").get() as any;
    expect(task.description).toBe("test");

    // New columns should have defaults
    expect(task.comments).toBe("[]");
    expect(task.mergeDetails).toBeNull();

    db.close();
  });

  it("skips migration if already at target version", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);
    db.init();

    expect(db.getSchemaVersion()).toBe(112);

    // Re-init should not fail
    db.init();
    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    // Re-init should not fail
    db.init();
    expect(db.getSchemaVersion()).toBe(112);

    db.close();
  });

  it("migrates v42 databases by adding task priority with normal default", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);

    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        executionMode TEXT DEFAULT 'standard'
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '42')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-1', 'legacy', 'triage', '2026-01-01', '2026-01-01')`);

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("priority");

    const task = db.prepare("SELECT priority FROM tasks WHERE id = 'FN-1'").get() as { priority: string };
    expect(task.priority).toBe("normal");

    db.close();
  });

  it("migrates v43 databases by adding task token-usage aggregate columns with null-compatible defaults", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);

    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '43')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-2', 'legacy v43', 'todo', '2026-01-01', '2026-01-01')`);

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = cols.map((col) => col.name);
    expect(colNames).toContain("tokenUsageInputTokens");
    expect(colNames).toContain("tokenUsageOutputTokens");
    expect(colNames).toContain("tokenUsageCachedTokens");
    expect(colNames).toContain("tokenUsageCacheWriteTokens");
    expect(colNames).toContain("tokenUsageTotalTokens");
    expect(colNames).toContain("tokenUsageFirstUsedAt");
    expect(colNames).toContain("tokenUsageLastUsedAt");

    const task = db.prepare(`
      SELECT
        tokenUsageInputTokens,
        tokenUsageOutputTokens,
        tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens,
        tokenUsageTotalTokens,
        tokenUsageFirstUsedAt,
        tokenUsageLastUsedAt
      FROM tasks
      WHERE id = 'FN-2'
    `).get() as Record<string, null>;

    expect(task.tokenUsageInputTokens).toBeNull();
    expect(task.tokenUsageOutputTokens).toBeNull();
    expect(task.tokenUsageCachedTokens).toBeNull();
    expect(task.tokenUsageCacheWriteTokens).toBeNull();
    expect(task.tokenUsageTotalTokens).toBeNull();
    expect(task.tokenUsageFirstUsedAt).toBeNull();
    expect(task.tokenUsageLastUsedAt).toBeNull();

    db.close();
  });

  it("migrates v44 databases by adding source issue columns with null-compatible defaults", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);

    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        tokenUsageInputTokens INTEGER,
        tokenUsageOutputTokens INTEGER,
        tokenUsageCachedTokens INTEGER,
        tokenUsageTotalTokens INTEGER,
        tokenUsageFirstUsedAt TEXT,
        tokenUsageLastUsedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '44')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-3', 'legacy v44', 'todo', '2026-01-01', '2026-01-01')`);

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = cols.map((col) => col.name);
    expect(colNames).toContain("sourceIssueProvider");
    expect(colNames).toContain("sourceIssueRepository");
    expect(colNames).toContain("sourceIssueExternalIssueId");
    expect(colNames).toContain("sourceIssueNumber");
    expect(colNames).toContain("sourceIssueUrl");

    const task = db.prepare(`
      SELECT
        sourceIssueProvider,
        sourceIssueRepository,
        sourceIssueExternalIssueId,
        sourceIssueNumber,
        sourceIssueUrl
      FROM tasks
      WHERE id = 'FN-3'
    `).get() as Record<string, null>;

    expect(task.sourceIssueProvider).toBeNull();
    expect(task.sourceIssueRepository).toBeNull();
    expect(task.sourceIssueExternalIssueId).toBeNull();
    expect(task.sourceIssueNumber).toBeNull();
    expect(task.sourceIssueUrl).toBeNull();

    db.close();
  });

  it("reconciles missing columns across all SCHEMA_SQL tables even when schemaVersion is current", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const dbSourcePath = fileURLToPath(new URL("../db.ts", import.meta.url));
    const source = readFileSync(dbSourcePath, "utf8");
    const versionMatch = source.match(/^const SCHEMA_VERSION = (\d+);/m);
    expect(versionMatch).not.toBeNull();
    const schemaVersion = Number(versionMatch?.[1]);

    const legacyDb = new Database(fusionDir);
    legacyDb.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");

    const schemaTables = getSchemaSqlTableSchemas();
    const indexedColumnsByTable = new Map<string, Set<string>>();
    for (const match of source.matchAll(/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)/g)) {
      const table = match[1];
      const cols = match[2]
        .split(",")
        .map((column) => column.trim().replace(/\s+(ASC|DESC)$/i, ""));
      const set = indexedColumnsByTable.get(table) ?? new Set<string>();
      cols.forEach((column) => set.add(column));
      indexedColumnsByTable.set(table, set);
    }

    const requiredDrops = new Map<string, string>([
      ["tasks", "checkoutNodeId"],
      ["agents", "currentTaskId"],
      ["missions", "autoAdvance"],
      ["routines", "agentId"],
    ]);

    const isSafeToDrop = (definition: string): boolean => {
      const upper = definition.toUpperCase();
      if (upper.includes("PRIMARY KEY")) return false;
      if (upper.includes("NOT NULL") && !upper.includes("DEFAULT")) return false;
      return true;
    };

    for (const [tableName, columns] of schemaTables) {
      const entries = [...columns.entries()];
      const dropped = new Set<string>();
      const indexedColumns = indexedColumnsByTable.get(tableName) ?? new Set<string>();
      entries.forEach(([name, definition], index) => {
        if (index % 4 === 0 && entries.length > 1 && isSafeToDrop(definition) && !indexedColumns.has(name)) {
          dropped.add(name);
        }
      });
      const forcedDrop = requiredDrops.get(tableName);
      if (forcedDrop) dropped.add(forcedDrop);

      const kept = entries.filter(([name]) => !dropped.has(name));
      const chosen = kept.length > 0 ? kept : entries.slice(0, 1);
      const columnSql = chosen.map(([name, def]) => `  "${name}" ${def}`).join(",\n");
      legacyDb.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (\n${columnSql}\n)`);
    }

    const validatorColumns = Object.entries(MIGRATION_ONLY_TABLE_SCHEMAS.mission_validator_runs)
      .filter(([name, definition], index) => name === "id" || (name !== "taskId" && (index % 4 !== 0 || !isSafeToDrop(definition))))
      .map(([name, def]) => `  "${name}" ${def}`)
      .join(",\n");
    legacyDb.exec(`CREATE TABLE IF NOT EXISTS mission_validator_runs (\n${validatorColumns}\n)`);

    legacyDb.exec(`INSERT INTO __meta (key, value) VALUES ('schemaVersion', '${schemaVersion}')`);
    legacyDb.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    legacyDb.close();

    const opened = new Database(fusionDir);
    opened.init();

    for (const [tableName, columns] of schemaTables) {
      const actualColumns = new Set(
        (opened.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      for (const [columnName] of columns) {
        expect(actualColumns.has(columnName), `expected column ${tableName}.${columnName} after init() but it is missing`).toBe(true);
      }
    }

    const missionValidatorColumns = new Set(
      (opened.prepare("PRAGMA table_info(mission_validator_runs)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    expect(
      missionValidatorColumns.has("taskId"),
      "expected column mission_validator_runs.taskId after init() but it is missing",
    ).toBe(true);

    opened.close();
  });

  it("backfills missing checkout lease columns when schemaVersion is already current", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const legacyDb = new Database(fusionDir);

    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    legacyDb.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '70')");
    legacyDb.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    legacyDb.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-lease', 'legacy', 'triage', '2026-01-01', '2026-01-01')`);
    legacyDb.close();

    const db = new Database(fusionDir);
    db.init();

    expect(() => db.prepare("SELECT checkoutNodeId FROM tasks WHERE id = 'FN-lease'").get()).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toContain("checkedOutBy");
    expect(columnNames).toContain("checkedOutAt");
    expect(columnNames).toContain("checkoutNodeId");
    expect(columnNames).toContain("checkoutRunId");
    expect(columnNames).toContain("checkoutLeaseRenewedAt");
    expect(columnNames).toContain("checkoutLeaseEpoch");

    const task = db.prepare("SELECT checkoutLeaseEpoch FROM tasks WHERE id = 'FN-lease'").get() as { checkoutLeaseEpoch: number | null };
    expect(task.checkoutLeaseEpoch).toBe(0);

    db.close();
  });

  it("backfills legacy routines table missing agentId with safe defaults", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);

    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        triggerType TEXT NOT NULL,
        triggerConfig TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '55')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      INSERT INTO routines (id, name, description, triggerType, triggerConfig, enabled, createdAt, updatedAt)
      VALUES ('routine-1', 'Database Backup', 'legacy row', 'cron', '{}', 1, '2026-01-01', '2026-01-01')
    `);

    db.init();

    const columns = db.prepare("PRAGMA table_info(routines)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("agentId");

    const row = db.prepare("SELECT agentId FROM routines WHERE id = 'routine-1'").get() as { agentId: string | null };
    expect(row.agentId).toBe("");

    db.close();
  });

  it("migrates v50 databases by adding chat message attachments column", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = new Database(fusionDir);

    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '50')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`INSERT INTO chat_messages (id, sessionId, role, content, createdAt) VALUES ('msg-1', 'chat-1', 'user', 'hello', '2026-01-01T00:00:00.000Z')`);

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("attachments");

    const row = db.prepare("SELECT attachments FROM chat_messages WHERE id = 'msg-1'").get() as { attachments: string | null };
    expect(row.attachments).toBeNull();

    db.close();
  });

  it("migration v53 adds task provenance columns", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const localDb = new Database(fusionDir);
    localDb.init();

    const columns = localDb.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("sourceType");
    expect(columnNames).toContain("sourceAgentId");
    expect(columnNames).toContain("sourceRunId");
    expect(columnNames).toContain("sourceSessionId");
    expect(columnNames).toContain("sourceMessageId");
    expect(columnNames).toContain("sourceParentTaskId");
    expect(columnNames).toContain("sourceMetadata");

    localDb.close();
  });

  it("migration v53 backfills sourceType to unknown", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const legacyDb = new Database(fusionDir);

    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    legacyDb.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '52')");
    legacyDb.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    legacyDb.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-53', 'legacy', 'triage', '2026-01-01', '2026-01-01')`);

    legacyDb.init();
    const row = legacyDb.prepare("SELECT sourceType FROM tasks WHERE id = 'FN-53'").get() as { sourceType: string | null };
    expect(row.sourceType).toBe("unknown");
    legacyDb.close();
  });

  it("applies migration 14+15 by creating agentRatings and ai_sessions indexes", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '13')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'agentRatings'").all() as Array<{ name: string }>;
    expect(tables).toEqual([{ name: "agentRatings" }]);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'agentRatings' ORDER BY name").all() as Array<{ name: string }>;
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).toContain("idxAgentRatingsAgentId");
    expect(indexNames).toContain("idxAgentRatingsCreatedAt");

    db.close();
  });

  it("migrates a v16 database by creating mission_events table and indexes", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '16')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'mission_events'").all() as Array<{ name: string }>;
    expect(tables).toEqual([{ name: "mission_events" }]);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'mission_events' ORDER BY name").all() as Array<{ name: string }>;
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).toContain("idxMissionEventsMissionId");
    expect(indexNames).toContain("idxMissionEventsTimestamp");
    expect(indexNames).toContain("idxMissionEventsType");

    db.close();
  });

  it("migrates a v2 database by adding missionId and sliceId columns", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    // Create a v2 database manually (without missionId and sliceId columns)
    const db = new Database(fusionDir);
    // Create tables without the new columns (matching v2 schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        status TEXT,
        size TEXT,
        reviewLevel INTEGER,
        currentStep INTEGER DEFAULT 0,
        worktree TEXT,
        blockedBy TEXT,
        paused INTEGER DEFAULT 0,
        baseBranch TEXT,
        modelPresetId TEXT,
        modelProvider TEXT,
        modelId TEXT,
        validatorModelProvider TEXT,
        validatorModelId TEXT,
        mergeRetries INTEGER,
        error TEXT,
        summary TEXT,
        thinkingLevel TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        columnMovedAt TEXT,
        dependencies TEXT DEFAULT '[]',
        steps TEXT DEFAULT '[]',
        log TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        steeringComments TEXT DEFAULT '[]',
        comments TEXT DEFAULT '[]',
        workflowStepResults TEXT DEFAULT '[]',
        prInfo TEXT,
        issueInfo TEXT,
        mergeDetails TEXT,
        breakIntoSubtasks INTEGER DEFAULT 0,
        enabledWorkflowSteps TEXT DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS activityLog (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL,
        taskId TEXT, taskTitle TEXT, details TEXT NOT NULL, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS archivedTasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, archivedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        scheduleType TEXT NOT NULL, cronExpression TEXT NOT NULL, command TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, timeoutMs INTEGER, steps TEXT,
        nextRunAt TEXT, lastRunAt TEXT, lastRunResult TEXT,
        runCount INTEGER DEFAULT 0, runHistory TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle', taskId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        lastHeartbeatAt TEXT, metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS agentHeartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL, runId TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '2')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    // Insert a task on the v2 schema
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('KB-2', 'test v2', 'triage', '2025-01-01', '2025-01-01')`);

    // Now run init() which should trigger migrations v2→v3→v4
    db.init();

    // Verify version bumped to 29
    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);

    // Verify new columns exist and existing data is intact
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("missionId");
    expect(colNames).toContain("sliceId");
    expect(colNames).toContain("branch");

    // Existing task should still be readable
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'KB-2'").get() as any;
    expect(task.description).toBe("test v2");

    // New columns should have null defaults
    expect(task.missionId).toBeNull();
    expect(task.sliceId).toBeNull();

    // Mission tables should be created
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("missions");
    expect(tableNames).toContain("milestones");
    expect(tableNames).toContain("slices");
    expect(tableNames).toContain("mission_features");

    db.close();
  });

  it("migrates pre-comments databases by copying steering comments into unified comments exactly once", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    const db = new Database(fusionDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        steeringComments TEXT DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS activityLog (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL,
        taskId TEXT, taskTitle TEXT, details TEXT NOT NULL, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS archivedTasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, archivedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        scheduleType TEXT NOT NULL, cronExpression TEXT NOT NULL, command TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, timeoutMs INTEGER, steps TEXT,
        nextRunAt TEXT, lastRunAt TEXT, lastRunResult TEXT,
        runCount INTEGER DEFAULT 0, runHistory TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle', taskId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        lastHeartbeatAt TEXT, metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS agentHeartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL, runId TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '1')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.prepare("INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt, steeringComments) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "FN-100",
        "legacy comments",
        "todo",
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        JSON.stringify([{ id: "legacy-1", text: "Use TypeScript", author: "user", createdAt: "2025-01-01T00:00:00.000Z" }]),
      );

    db.init();

    const row = db.prepare("SELECT steeringComments, comments FROM tasks WHERE id = 'FN-100'").get() as any;
    expect(JSON.parse(row.steeringComments)).toHaveLength(1);
    expect(JSON.parse(row.comments)).toEqual([
      {
        id: "legacy-1",
        text: "Use TypeScript",
        author: "user",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    db.close();
  });

  it("deduplicates overlapping steeringComments and comments during schema upgrade", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    const db = new Database(fusionDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        steeringComments TEXT DEFAULT '[]',
        comments TEXT DEFAULT '[]',
        mergeDetails TEXT
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS activityLog (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL,
        taskId TEXT, taskTitle TEXT, details TEXT NOT NULL, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS archivedTasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, archivedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        scheduleType TEXT NOT NULL, cronExpression TEXT NOT NULL, command TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, timeoutMs INTEGER, steps TEXT,
        nextRunAt TEXT, lastRunAt TEXT, lastRunResult TEXT,
        runCount INTEGER DEFAULT 0, runHistory TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'idle', taskId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        lastHeartbeatAt TEXT, metadata TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS agentHeartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT NOT NULL, runId TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '4')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.prepare("INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt, steeringComments, comments) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "FN-101",
        "mixed comments",
        "todo",
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        JSON.stringify([{ id: "c1", text: "Keep it simple", author: "user", createdAt: "2025-01-01T00:00:00.000Z" }]),
        JSON.stringify([
          { id: "c1", text: "Keep it simple", author: "user", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" },
          { id: "c2", text: "Already unified", author: "alice", createdAt: "2025-01-03T00:00:00.000Z" },
        ]),
      );

    db.init();

    const row = db.prepare("SELECT comments FROM tasks WHERE id = 'FN-101'").get() as any;
    expect(JSON.parse(row.comments)).toEqual([
      { id: "c1", text: "Keep it simple", author: "user", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" },
      { id: "c2", text: "Already unified", author: "alice", createdAt: "2025-01-03T00:00:00.000Z" },
    ]);

    db.close();
  });

  it("migration v74 adds tokenUsageCacheWriteTokens without data loss", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const localDb = new Database(fusionDir);

    localDb.exec(`
      CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        tokenUsageInputTokens INTEGER,
        tokenUsageOutputTokens INTEGER,
        tokenUsageCachedTokens INTEGER,
        tokenUsageTotalTokens INTEGER,
        tokenUsageFirstUsedAt TEXT,
        tokenUsageLastUsedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nextId INTEGER DEFAULT 1,
        nextWorkflowStepId INTEGER DEFAULT 1,
        settings TEXT DEFAULT '{}',
        workflowSteps TEXT DEFAULT '[]',
        updatedAt TEXT
      );
    `);
    localDb.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '73')");
    localDb.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    localDb.exec(`INSERT INTO tasks (id, description, "column", tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens, tokenUsageTotalTokens, createdAt, updatedAt) VALUES ('FN-74', 'legacy v73', 'todo', 10, 20, 30, 60, '2026-01-01', '2026-01-01')`);

    localDb.init();

    expect(localDb.getSchemaVersion()).toBe(112);
    expect(localDb.getSchemaVersion()).toBe(112);
    const columns = localDb.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("tokenUsageCacheWriteTokens");

    const row = localDb.prepare(`
      SELECT tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens, tokenUsageCacheWriteTokens, tokenUsageTotalTokens
      FROM tasks
      WHERE id = 'FN-74'
    `).get() as {
      tokenUsageInputTokens: number;
      tokenUsageOutputTokens: number;
      tokenUsageCachedTokens: number;
      tokenUsageCacheWriteTokens: number | null;
      tokenUsageTotalTokens: number;
    };

    expect(row.tokenUsageInputTokens).toBe(10);
    expect(row.tokenUsageOutputTokens).toBe(20);
    expect(row.tokenUsageCachedTokens).toBe(30);
    expect(row.tokenUsageCacheWriteTokens).toBeNull();
    expect(row.tokenUsageTotalTokens).toBe(60);

    localDb.close();
  });

  it("SCHEMA_VERSION matches the highest applyMigration target", () => {
    tmpDir = makeTmpDir();
    const dbSourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "db.ts");
    const source = readFileSync(dbSourcePath, "utf8");

    const versionMatch = source.match(/^const SCHEMA_VERSION = (\d+);/m);
    expect(versionMatch, "SCHEMA_VERSION constant not found in db.ts").not.toBeNull();
    const declaredVersion = Number(versionMatch![1]);

    const migrationTargets = Array.from(source.matchAll(/this\.applyMigration\((\d+),/g)).map(
      (m) => Number(m[1]),
    );
    expect(migrationTargets.length).toBeGreaterThan(0);
    const maxMigration = Math.max(...migrationTargets);

    expect(declaredVersion).toBe(maxMigration);
  });
});

describe("FTS5 full-text search", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await removeTrackedTmpDir(tmpDir);
  });

  it("creates tasks_fts virtual table after init", () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_fts'"
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe("tasks_fts");
  });

  it("creates FTS5 triggers after init", () => {
    const triggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger'"
    ).all() as { name: string; sql: string }[];
    const triggerNames = triggers.map((t) => t.name);

    expect(triggerNames).toContain("tasks_fts_ai");
    expect(triggerNames).toContain("tasks_fts_au");
    expect(triggerNames).toContain("tasks_fts_ad");

    const updateTrigger = triggers.find((t) => t.name === "tasks_fts_au");
    expect(updateTrigger?.sql).toContain("AFTER UPDATE OF id, title, description, comments");
  });

  it("populates FTS index from existing tasks on migration", () => {
    // Insert a task directly into the database (bypassing triggers for this test)
    db.prepare(
      "INSERT INTO tasks (id, title, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "FN-FTS-001",
      "Full-text search test",
      "Testing the FTS index",
      "todo",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z"
    );

    // Verify the task appears in the FTS index by joining with tasks table
    const ftsRow = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.id = 'FN-FTS-001'
    `).get() as any;

    expect(ftsRow).toBeDefined();
    expect(ftsRow.id).toBe("FN-FTS-001");
    expect(ftsRow.title).toBe("Full-text search test");
    expect(ftsRow.description).toBe("Testing the FTS index");
  });

  it("INSERT trigger indexes new tasks", () => {
    // Use upsertTask equivalent via direct insert
    db.prepare(`
      INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt)
      VALUES ('FN-FTS-002', 'New task title', 'New task description', 'triage', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();

    // Verify the task appears in the FTS index via trigger by joining with tasks
    const ftsRow = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.id = 'FN-FTS-002'
    `).get() as any;

    expect(ftsRow).toBeDefined();
    expect(ftsRow.id).toBe("FN-FTS-002");
    expect(ftsRow.title).toBe("New task title");
  });

  it("UPDATE trigger reindexes updated tasks", () => {
    // Insert a task
    db.prepare(`
      INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt)
      VALUES ('FN-FTS-003', 'Original title', 'Original description', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();

    // Update the task
    db.prepare(`
      UPDATE tasks SET title = 'Updated title', updatedAt = '2025-01-02T00:00:00.000Z' WHERE id = 'FN-FTS-003'
    `).run();

    // Verify FTS index has the updated content
    const ftsRow = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.id = 'FN-FTS-003'
    `).get() as any;

    expect(ftsRow).toBeDefined();
    expect(ftsRow.title).toBe("Updated title");
    expect(ftsRow.description).toBe("Original description"); // description should still be there
  });

  it("DELETE trigger removes tasks from index", () => {
    // Insert a task
    db.prepare(`
      INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt)
      VALUES ('FN-FTS-004', 'Task to delete', 'Will be removed', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();

    // Verify it's in the FTS index
    const beforeDelete = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.id = 'FN-FTS-004'
    `).get();
    expect(beforeDelete).toBeDefined();

    // Delete the task
    db.prepare("DELETE FROM tasks WHERE id = 'FN-FTS-004'").run();

    // Verify it's no longer in the FTS index
    const afterDelete = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE t.id = 'FN-FTS-004'
    `).get();
    expect(afterDelete).toBeUndefined();
  });

  it("FTS index includes comments in JSON format", () => {
    // Insert a task with comments
    db.prepare(`
      INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt, comments)
      VALUES ('FN-FTS-005', 'Task with comments', 'Has a comment', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '[{"id":"c1","text":"xylophone_plan_keyword","author":"tester","createdAt":"2025-01-01T00:00:00.000Z"}]')
    `).run();

    // Verify the task appears in FTS with comments tokenized using MATCH
    const ftsRows = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE tasks_fts MATCH 'xylophone'
    `).all() as any[];

    expect(ftsRows.length).toBeGreaterThan(0);
    const ftsRow = ftsRows.find((r) => r.id === "FN-FTS-005");
    expect(ftsRow).toBeDefined();
    expect(ftsRow.comments).toContain("xylophone");
  });

  it("rebuildFts5Index recreates and repopulates the FTS table", () => {
    db.prepare(`
      INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt)
      VALUES ('FN-FTS-REBUILD', 'Rebuild title', 'Rebuild description', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();

    db.exec("DROP TRIGGER IF EXISTS tasks_fts_ai");
    db.exec("DROP TRIGGER IF EXISTS tasks_fts_au");
    db.exec("DROP TRIGGER IF EXISTS tasks_fts_ad");
    db.exec("DROP TABLE IF EXISTS tasks_fts");
    db.exec(`
      CREATE VIRTUAL TABLE tasks_fts USING fts5(
        id,
        title,
        description,
        comments,
        content='tasks',
        content_rowid='rowid'
      )
    `);

    const missingTrigger = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='tasks_fts_ai'"
    ).get() as { name: string } | undefined;
    expect(missingTrigger).toBeUndefined();

    expect(db.rebuildFts5Index()).toBe(true);

    const searchRows = db.prepare(`
      SELECT t.id FROM tasks t
      JOIN tasks_fts fts ON t.rowid = fts.rowid
      WHERE tasks_fts MATCH 'Rebuild'
    `).all() as Array<{ id: string }>;
    expect(searchRows.some((row) => row.id === "FN-FTS-REBUILD")).toBe(true);
  });

  it("checkFts5Integrity returns true for healthy index", () => {
    expect(db.checkFts5Integrity()).toBe(true);
  });

  it("checkFts5Integrity returns false when integrity-check command fails", () => {
    const execSpy = vi.spyOn((db as any).db, "exec");
    execSpy.mockImplementation(((sql: string) => {
      if (sql.includes("integrity-check")) {
        throw new Error("corruption found reading blob");
      }
      return undefined;
    }) as never);

    expect(db.checkFts5Integrity()).toBe(false);
  });

  it("isFts5CorruptionError detects known corruption signatures", () => {
    expect(db.isFts5CorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(db.isFts5CorruptionError(new Error("FTS5 index corrupt at segment 4"))).toBe(true);
    expect(db.isFts5CorruptionError(new Error("some other sqlite error"))).toBe(false);
  });
});

describe("Database FTS5 guard behavior", () => {
  it("rebuildFts5Index returns false when FTS5 is unavailable", async () => {
    const prevEnv = process.env.FUSION_DISABLE_FTS5;
    process.env.FUSION_DISABLE_FTS5 = "1";

    const tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const localDb = new Database(fusionDir);

    try {
      localDb.init();
      expect(localDb.rebuildFts5Index()).toBe(false);
    } finally {
      localDb.close();
      await removeTrackedTmpDir(tmpDir);
      if (prevEnv === undefined) {
        delete process.env.FUSION_DISABLE_FTS5;
      } else {
        process.env.FUSION_DISABLE_FTS5 = prevEnv;
      }
    }
  });
});

describe("createDatabase factory", () => {
  let tmpDir: string;

  afterEach(async () => {
    await removeTrackedTmpDir(tmpDir);
  });

  it("creates a database instance without auto-init", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = createDatabase(fusionDir);

    // DB file exists (created on open) but schema not initialized
    expect(existsSync(join(fusionDir, "fusion.db"))).toBe(true);
    // Schema is NOT yet created — querying __meta would fail
    expect(() => db.getSchemaVersion()).toThrow();

    db.close();
  });

  it("works after explicit init()", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = createDatabase(fusionDir);
    db.init();

    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getSchemaVersion()).toBe(112);
    expect(db.getLastModified()).toBeGreaterThan(0);

    db.close();
  });

  it("getPath returns the database file path", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");
    const db = createDatabase(fusionDir);

    expect(db.getPath()).toBe(join(fusionDir, "fusion.db"));

    db.close();
  });

  it("is idempotent when init() called multiple times", () => {
    tmpDir = makeTmpDir();
    const fusionDir = join(tmpDir, ".fusion");

    // First call
    const db1 = createDatabase(fusionDir);
    db1.init();
    db1.prepare("UPDATE config SET nextId = 99 WHERE id = 1").run();
    db1.close();

    // Second call — init should not overwrite data
    const db2 = createDatabase(fusionDir);
    db2.init();
    const row = db2.prepare("SELECT nextId FROM config WHERE id = 1").get() as any;
    expect(row.nextId).toBe(99);
    db2.close();
  });
});

// ── TaskStore — verification cache methods ────────────────────────────────

describe("TaskStore — verification cache", () => {
  const harness = createSharedTaskStoreTestHarness();
  let store: TaskStore;

  beforeAll(harness.beforeAll);
  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(harness.afterAll);

  it("returns null when no cache entry exists", () => {
    const hit = store.getVerificationCacheHit("abc1234", "pnpm test", "pnpm build");
    expect(hit).toBeNull();
  });

  it("records a pass and retrieves it as a cache hit", () => {
    const treeSha = "deadbeef1234567890";
    store.recordVerificationCachePass(treeSha, "pnpm test", "pnpm build", "FN-001");

    const hit = store.getVerificationCacheHit(treeSha, "pnpm test", "pnpm build");
    expect(hit).not.toBeNull();
    expect(hit!.taskId).toBe("FN-001");
    expect(new Date(hit!.recordedAt).toISOString()).toBe(hit!.recordedAt);
  });

  it("returns null for a different tree sha", () => {
    store.recordVerificationCachePass("sha-a", "pnpm test", "", "FN-001");

    const hit = store.getVerificationCacheHit("sha-b", "pnpm test", "");
    expect(hit).toBeNull();
  });

  it("distinguishes entries by testCommand", () => {
    const treeSha = "aabbccdd";
    store.recordVerificationCachePass(treeSha, "pnpm test", "", "FN-001");

    expect(store.getVerificationCacheHit(treeSha, "pnpm test", "")).not.toBeNull();
    expect(store.getVerificationCacheHit(treeSha, "vitest run", "")).toBeNull();
  });

  it("distinguishes entries by buildCommand", () => {
    const treeSha = "11223344";
    store.recordVerificationCachePass(treeSha, "", "pnpm build", "FN-002");

    expect(store.getVerificationCacheHit(treeSha, "", "pnpm build")).not.toBeNull();
    expect(store.getVerificationCacheHit(treeSha, "", "tsc --noEmit")).toBeNull();
  });

  it("normalizes undefined to empty string for stable primary key", () => {
    const treeSha = "normtest";
    // Pass undefined-ish values (coerced via nullish fallback in impl)
    store.recordVerificationCachePass(treeSha, "", "", "FN-003");

    const hit = store.getVerificationCacheHit(treeSha, "", "");
    expect(hit).not.toBeNull();
    expect(hit!.taskId).toBe("FN-003");
  });

  it("overwrites an existing entry on re-record (INSERT OR REPLACE)", () => {
    const treeSha = "upserttest";
    store.recordVerificationCachePass(treeSha, "pnpm test", "", "FN-010");
    store.recordVerificationCachePass(treeSha, "pnpm test", "", "FN-020");

    const hit = store.getVerificationCacheHit(treeSha, "pnpm test", "");
    expect(hit).not.toBeNull();
    expect(hit!.taskId).toBe("FN-020");
  });
});

describe("migration v77 task token budget columns", () => {
  it("includes task token budget columns on fresh init", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const fresh = new Database(fusion);
    try {
      fresh.init();
      const rows = fresh
        .prepare("PRAGMA table_info(tasks)")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((row) => row.name));
      expect(names.has("tokenBudgetSoftAlertedAt")).toBe(true);
      expect(names.has("tokenBudgetHardAlertedAt")).toBe(true);
      expect(names.has("tokenBudgetOverride")).toBe(true);
    } finally {
      try {
        fresh.close();
      } catch {
        // already closed
      }
      removeTrackedTmpDirSync(temp);
    }
  });

  it("adds task token budget columns during migration without dropping existing rows", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const localDb = new Database(fusion);
    let migrated: Database | undefined;

    try {
      localDb.init();
      localDb.prepare("INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
        .run("FN-MIGRATE", "migration row", "todo", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      localDb.prepare("UPDATE __meta SET value = '76' WHERE key = 'schemaVersion'").run();
      localDb.exec("ALTER TABLE tasks DROP COLUMN tokenBudgetSoftAlertedAt");
      localDb.exec("ALTER TABLE tasks DROP COLUMN tokenBudgetHardAlertedAt");
      localDb.exec("ALTER TABLE tasks DROP COLUMN tokenBudgetOverride");
      localDb.close();

      migrated = new Database(fusion);
      migrated.init();
      expect(migrated.getSchemaVersion()).toBe(112);
      expect(migrated.getSchemaVersion()).toBe(112);
      const rows = migrated.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const names = new Set(rows.map((row) => row.name));
      expect(names.has("tokenBudgetSoftAlertedAt")).toBe(true);
      expect(names.has("tokenBudgetHardAlertedAt")).toBe(true);
      expect(names.has("tokenBudgetOverride")).toBe(true);
      const task = migrated.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-MIGRATE") as { id: string } | undefined;
      expect(task?.id).toBe("FN-MIGRATE");
    } finally {
      try {
        migrated?.close();
      } catch {
        // already closed
      }
      try {
        localDb.close();
      } catch {
        // already closed
      }
      removeTrackedTmpDirSync(temp);
    }
  });
});

describe("migration v106 adds tasks.transitionPending (FN-1417)", () => {
  it("includes the transitionPending column on fresh init", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const fresh = new Database(fusion);
    try {
      fresh.init();
      expect(fresh.getSchemaVersion()).toBe(112);
      expect(fresh.getSchemaVersion()).toBe(112);
      const names = new Set(
        (fresh.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((r) => r.name),
      );
      expect(names.has("transitionPending")).toBe(true);
    } finally {
      try { fresh.close(); } catch { /* already closed */ }
      removeTrackedTmpDirSync(temp);
    }
  });

  it("from v105 → init() adds transitionPending; existing rows keep it NULL and survive", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const localDb = new Database(fusion);
    let migrated: Database | undefined;
    try {
      localDb.init();
      localDb
        .prepare('INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .run("FN-V105", "pre-106 row", "todo", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      // Roll back to v105 and drop the column the v106 migration adds.
      localDb.exec("ALTER TABLE tasks DROP COLUMN transitionPending");
      localDb.prepare("UPDATE __meta SET value = '105' WHERE key = 'schemaVersion'").run();
      localDb.close();

      migrated = new Database(fusion);
      migrated.init();
      expect(migrated.getSchemaVersion()).toBe(112);
      expect(migrated.getSchemaVersion()).toBe(112);
      const names = new Set(
        (migrated.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((r) => r.name),
      );
      expect(names.has("transitionPending")).toBe(true);
      const row = migrated
        .prepare("SELECT id, transitionPending FROM tasks WHERE id = ?")
        .get("FN-V105") as { id: string; transitionPending: string | null } | undefined;
      expect(row?.id).toBe("FN-V105");
      // Additive, nullable, no backfill — the pre-existing row stays NULL.
      expect(row?.transitionPending).toBeNull();
    } finally {
      try { migrated?.close(); } catch { /* already closed */ }
      try { localDb.close(); } catch { /* already closed */ }
      removeTrackedTmpDirSync(temp);
    }
  });
});

describe("migration v107 adds workflow_run_branches + index (FN-1417)", () => {
  it("creates the workflow_run_branches table and its index on fresh init", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const fresh = new Database(fusion);
    try {
      fresh.init();
      expect(fresh.getSchemaVersion()).toBe(112);
      expect(fresh.getSchemaVersion()).toBe(112);
      const table = fresh
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'workflow_run_branches'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("workflow_run_branches");
      const index = fresh
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_workflow_run_branches_task_run'")
        .get() as { name: string } | undefined;
      expect(index?.name).toBe("idx_workflow_run_branches_task_run");
    } finally {
      try { fresh.close(); } catch { /* already closed */ }
      removeTrackedTmpDirSync(temp);
    }
  });

  it("from v106 → init() adds workflow_run_branches + index without dropping existing rows", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const localDb = new Database(fusion);
    let migrated: Database | undefined;
    try {
      localDb.init();
      localDb
        .prepare('INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .run("FN-V106", "pre-107 row", "todo", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      // Roll back to v106 and drop the table the v107 migration creates. (v106
      // schema already has tasks.transitionPending, so we leave it in place.)
      localDb.exec("DROP INDEX IF EXISTS idx_workflow_run_branches_task_run");
      localDb.exec("DROP TABLE IF EXISTS workflow_run_branches");
      localDb.prepare("UPDATE __meta SET value = '106' WHERE key = 'schemaVersion'").run();
      localDb.close();

      migrated = new Database(fusion);
      migrated.init();
      expect(migrated.getSchemaVersion()).toBe(112);
      expect(migrated.getSchemaVersion()).toBe(112);
      const table = migrated
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'workflow_run_branches'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("workflow_run_branches");
      const index = migrated
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_workflow_run_branches_task_run'")
        .get() as { name: string } | undefined;
      expect(index?.name).toBe("idx_workflow_run_branches_task_run");
      const task = migrated.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-V106") as { id: string } | undefined;
      expect(task?.id).toBe("FN-V106");
    } finally {
      try { migrated?.close(); } catch { /* already closed */ }
      try { localDb.close(); } catch { /* already closed */ }
      removeTrackedTmpDirSync(temp);
    }
  });
});

describe("migration v67 drops orphan project auth tables", () => {
  it("drops project_auth_* tables left over from the removed pluggable auth feature", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const localDb = new Database(fusion);
    let migrated: Database | undefined;

    try {
      localDb.init();
      // Simulate a user who ran the old migration 63 (schema version 63–66) and
      // therefore has the orphan project_auth_* tables sitting in their DB. We
      // recreate them by hand and roll the schemaVersion back so the new
      // migration runs on the next init.
      localDb.exec(`CREATE TABLE IF NOT EXISTS project_auth_users (id TEXT PRIMARY KEY)`);
      localDb.exec(`CREATE TABLE IF NOT EXISTS project_auth_memberships (id TEXT PRIMARY KEY, userId TEXT, FOREIGN KEY (userId) REFERENCES project_auth_users(id) ON DELETE CASCADE)`);
      localDb.exec(`CREATE TABLE IF NOT EXISTS project_auth_providers (id TEXT PRIMARY KEY, userId TEXT, FOREIGN KEY (userId) REFERENCES project_auth_users(id) ON DELETE CASCADE)`);
      localDb.exec(`CREATE TABLE IF NOT EXISTS project_auth_sessions (id TEXT PRIMARY KEY, userId TEXT, membershipId TEXT, FOREIGN KEY (userId) REFERENCES project_auth_users(id) ON DELETE CASCADE, FOREIGN KEY (membershipId) REFERENCES project_auth_memberships(id) ON DELETE CASCADE)`);
      localDb.prepare("UPDATE __meta SET value = '66' WHERE key = 'schemaVersion'").run();
      localDb.close();

      migrated = new Database(fusion);
      migrated.init();
      expect(migrated.getSchemaVersion()).toBe(112);
      expect(migrated.getSchemaVersion()).toBe(112);
      const tables = migrated
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_auth_%'")
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([]);
    } finally {
      try {
        migrated?.close();
      } catch {
        // already closed
      }
      try {
        localDb.close();
      } catch {
        // already closed
      }
      removeTrackedTmpDirSync(temp);
    }
  });

  it("is a no-op on fresh DBs that never had the auth tables", () => {
    const temp = makeTmpDir();
    const fusion = join(temp, ".fusion");
    const fresh = new Database(fusion);

    try {
      fresh.init();
      expect(fresh.getSchemaVersion()).toBe(112);
      expect(fresh.getSchemaVersion()).toBe(112);
      const tables = fresh
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_auth_%'")
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([]);
    } finally {
      try {
        fresh.close();
      } catch {
        // already closed
      }
      removeTrackedTmpDirSync(temp);
    }
  });
});

describe("Database operational-log retention and recovery-table cleanup", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await cleanupTmpDirsAsync();
  });

  function insertActivity(id: string, timestamp: string): void {
    db.prepare(
      "INSERT INTO activityLog (id, timestamp, type, details) VALUES (?, ?, 'test', '{}')",
    ).run(id, timestamp);
  }

  function insertAgent(agentId: string): void {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO agents (id, name, role, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(agentId, `Agent ${agentId}`, "executor", "idle", now, now);
  }

  function insertAgentRun({
    id,
    agentId,
    startedAt,
    endedAt,
    status,
  }: {
    id: string;
    agentId: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
  }): void {
    db.prepare(
      "INSERT INTO agentRuns (id, agentId, data, startedAt, endedAt, status) VALUES (?, ?, '{}', ?, ?, ?)",
    ).run(id, agentId, startedAt, endedAt, status);
  }

  function insertAgentConfigRevision({
    id,
    agentId,
    createdAt,
  }: {
    id: string;
    agentId: string;
    createdAt: string;
  }): void {
    db.prepare(
      "INSERT INTO agentConfigRevisions (id, agentId, data, createdAt) VALUES (?, ?, '{}', ?)",
    ).run(id, agentId, createdAt);
  }

  it("pruneOperationalLogs deletes rows older than the retention window", () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    insertActivity("old-1", old);
    insertActivity("old-2", old);
    insertActivity("recent-1", recent);

    const result = db.pruneOperationalLogs(90 * 86_400_000);
    expect(result.deletedTotal).toBe(2);
    expect(result.deletedByTable.activityLog).toBe(2);

    const remaining = db.prepare("SELECT id FROM activityLog ORDER BY id").all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(["recent-1"]);
  });

  it("pruneOperationalLogs deletes old terminal agent runs but keeps recent ones", () => {
    insertAgent("agent-1");
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

    insertAgentRun({ id: "run-old-completed", agentId: "agent-1", startedAt: old, endedAt: old, status: "completed" });
    insertAgentRun({ id: "run-old-failed", agentId: "agent-1", startedAt: old, endedAt: old, status: "failed" });
    insertAgentRun({ id: "run-recent-completed", agentId: "agent-1", startedAt: recent, endedAt: recent, status: "completed" });

    const result = db.pruneOperationalLogs(90 * 86_400_000);
    expect(result.deletedByTable.agentRuns).toBe(2);
    expect(result.deletedTotal).toBe(2);

    const remaining = db
      .prepare("SELECT id FROM agentRuns ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["run-recent-completed"]);
  });

  it("pruneOperationalLogs never deletes in-flight agent runs", () => {
    insertAgent("agent-1");
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    insertAgentRun({ id: "run-active-old", agentId: "agent-1", startedAt: old, endedAt: null, status: "active" });

    const result = db.pruneOperationalLogs(7 * 86_400_000);
    expect(result.deletedByTable.agentRuns).toBe(0);
    expect(result.deletedTotal).toBe(0);
    expect(db.prepare("SELECT id, endedAt, status FROM agentRuns").all()).toEqual([
      { id: "run-active-old", endedAt: null, status: "active" },
    ]);
  });

  it("pruneOperationalLogs deletes old config revisions but preserves the latest per agent", () => {
    insertAgent("agent-1");
    insertAgent("agent-2");
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const mid = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

    insertAgentConfigRevision({ id: "agent-1-old-1", agentId: "agent-1", createdAt: old });
    insertAgentConfigRevision({ id: "agent-1-old-2", agentId: "agent-1", createdAt: mid });
    insertAgentConfigRevision({ id: "agent-1-recent", agentId: "agent-1", createdAt: recent });
    insertAgentConfigRevision({ id: "agent-2-old-1", agentId: "agent-2", createdAt: old });
    insertAgentConfigRevision({ id: "agent-2-old-2", agentId: "agent-2", createdAt: mid });

    const result = db.pruneOperationalLogs(90 * 86_400_000);
    expect(result.deletedByTable.agentConfigRevisions).toBe(3);
    expect(result.deletedTotal).toBe(3);

    const remaining = db
      .prepare("SELECT id FROM agentConfigRevisions ORDER BY agentId, createdAt, id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["agent-1-recent", "agent-2-old-2"]);
  });

  it("pruneOperationalLogs is a no-op when retention is disabled (<= 0)", () => {
    insertActivity("old-1", new Date(Date.now() - 200 * 86_400_000).toISOString());
    insertAgent("agent-1");
    insertAgentRun({
      id: "run-old-completed",
      agentId: "agent-1",
      startedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      endedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      status: "completed",
    });
    insertAgentConfigRevision({
      id: "revision-old",
      agentId: "agent-1",
      createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    });

    const result = db.pruneOperationalLogs(0);
    expect(result.deletedTotal).toBe(0);
    expect(db.prepare("SELECT count(*) AS c FROM activityLog").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM agentRuns").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM agentConfigRevisions").get()).toMatchObject({ c: 1 });
  });

  it("pruneOperationalLogs is idempotent for new retention targets", () => {
    insertAgent("agent-1");
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    insertAgentRun({ id: "run-old-completed", agentId: "agent-1", startedAt: old, endedAt: old, status: "completed" });
    insertAgentConfigRevision({ id: "revision-old", agentId: "agent-1", createdAt: old });
    insertAgentConfigRevision({ id: "revision-latest", agentId: "agent-1", createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString() });

    const first = db.pruneOperationalLogs(90 * 86_400_000);
    expect(first.deletedByTable.agentRuns).toBe(1);
    expect(first.deletedByTable.agentConfigRevisions).toBe(1);

    const second = db.pruneOperationalLogs(90 * 86_400_000);
    expect(second.deletedByTable.agentRuns).toBe(0);
    expect(second.deletedByTable.agentConfigRevisions).toBe(0);
    expect(second.deletedTotal).toBe(0);
  });

  it("dropOrphanRecoveryTables removes lost_and_found scratch tables", () => {
    db.exec("CREATE TABLE lost_and_found (x)");
    db.exec("CREATE TABLE lost_and_found_0 (x)");
    db.exec("CREATE TABLE lost_and_found_2 (x)");

    const dropped = db.dropOrphanRecoveryTables();
    expect(dropped).toBe(3);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lost_and_found%'")
      .all();
    expect(tables).toEqual([]);
  });

  it("init() drops pre-existing lost_and_found tables on open", () => {
    db.exec("CREATE TABLE lost_and_found_0 (x)");
    db.close();

    const reopened = new Database(fusionDir);
    reopened.init();
    try {
      const tables = reopened
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lost_and_found%'")
        .all();
      expect(tables).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

describe("Database.recoverIfCorrupt startup guard", () => {
  let tmpDir: string;
  let fusionDir: string;
  const sqlite3Available = (() => {
    const probe = spawnSync("sqlite3", ["--version"], { encoding: "utf-8" });
    return !probe.error && probe.status === 0;
  })();

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await cleanupTmpDirsAsync();
  });

  it("returns 'absent' when no database exists", () => {
    const result = Database.recoverIfCorrupt(fusionDir);
    expect(result.status).toBe("absent");
  });

  it("returns 'healthy' for an intact database", () => {
    if (!sqlite3Available) return;
    const db = new Database(fusionDir);
    db.init();
    db.close();
    const result = Database.recoverIfCorrupt(fusionDir);
    expect(result.status).toBe("healthy");
  });

  it("rebuilds a malformed database and preserves the corrupt original", () => {
    if (!sqlite3Available) return;
    const dbPath = join(fusionDir, "fusion.db");
    const db = new Database(fusionDir);
    db.init();
    // Span many pages so mid-file corruption lands on a B-tree page.
    for (let i = 0; i < 3000; i++) {
      db.prepare("INSERT INTO activityLog (id, timestamp, type, details) VALUES (?, ?, 'test', '{}')").run(
        `row-${i}`,
        new Date().toISOString(),
      );
    }
    db.walCheckpoint("TRUNCATE");
    db.close();

    // Corrupt an interior region while leaving the header page intact.
    const size = statSync(dbPath).size;
    const fd = openSync(dbPath, "r+");
    try {
      const garbage = Buffer.alloc(16 * 1024, 0xab);
      writeSync(fd, garbage, 0, garbage.length, Math.floor(size / 2));
    } finally {
      closeSync(fd);
    }

    // If the corruption didn't trip quick_check on this build, skip rather
    // than assert flakily.
    const pre = quickCheckSqliteFile(dbPath);
    if (pre.ok) return;

    // Whether `sqlite3 .recover` can rebuild a given byte-level corruption is
    // build-dependent, so assert the contract for whichever branch is taken:
    //   - "recovered": a clean db was swapped in and the corrupt original kept.
    //   - "failed":    the corrupt original is left untouched for manual repair
    //                  (the safe outcome — never swap in an unverified rebuild).
    const result = Database.recoverIfCorrupt(fusionDir);
    expect(["recovered", "failed"]).toContain(result.status);

    if (result.status === "recovered") {
      expect(result.corruptBackupPath).toBeDefined();
      expect(existsSync(result.corruptBackupPath!)).toBe(true);
      // The swapped-in database must now be clean and free of stale sidecars.
      expect(quickCheckSqliteFile(dbPath).ok).toBe(true);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);

      // And it must open and answer queries.
      const reopened = new Database(fusionDir);
      reopened.init();
      try {
        const row = reopened.prepare("SELECT count(*) AS c FROM activityLog").get() as { c: number };
        expect(row.c).toBeGreaterThanOrEqual(0);
      } finally {
        reopened.close();
      }
    } else {
      // Safety invariant: the original (still-corrupt) file is preserved in place.
      expect(existsSync(dbPath)).toBe(true);
      expect(quickCheckSqliteFile(dbPath).ok).toBe(false);
    }
  });
});
