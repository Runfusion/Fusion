import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Database } from "../db.js";
import { TaskStore } from "../store.js";
import type { RunMutationContext, Task } from "../types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-store-concurrent-test-"));
}

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
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("BEGIN IMMEDIATE");
    db.exec(\"INSERT INTO tasks (id, description, \\\"column\\\", createdAt, updatedAt) VALUES ('FN-LOCK-HELPER', 'lock helper', 'todo', '2025-01-01', '2025-01-01') ON CONFLICT(id) DO NOTHING\");
    process.stdout.write("LOCKED\\n");
    const release = () => {
      try { db.exec("COMMIT"); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    };
    if (${JSON.stringify(releaseMode)} === "timer") {
      /*
      FNXC:CoreTests 2026-06-15-07:38:
      FN-6486 rescues this WAL lock-recovery regression by removing the helper's event-loop timer dependency. Under package-lane load, a delayed setTimeout could keep the external writer lock past the recovery window and mimic a product failure; a synchronous child-process sleep preserves the transient lock invariant without widening test or SQLite retry timeouts.
      */
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, ${holdMs});
      release();
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

  const ready = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("LOCKED")) resolve();
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
      if (child.exitCode !== null || child.killed) return;
      if (releaseMode === "timer") {
        await once(child, "exit");
        return;
      }
      child.stdin.write("RELEASE\n");
      await once(child, "exit");
    },
  };
}

async function createStores(rootDir: string, globalDir: string, count: number): Promise<TaskStore[]> {
  const stores = Array.from({ length: count }, () => new TaskStore(rootDir, globalDir));
  for (const store of stores) {
    await store.init();
  }
  return stores;
}

describe("TaskStore concurrent writes", () => {
  let rootDir: string;
  let globalDir: string;
  let fusionDir: string;
  let stores: TaskStore[];
  let primary: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    fusionDir = join(rootDir, ".fusion");
    stores = await createStores(rootDir, globalDir, 4);
    primary = stores[0];
  });

  afterEach(async () => {
    for (const store of stores) {
      try {
        store.stopWatching();
        store.close();
      } catch {
        // ignore
      }
    }
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("uses WAL on each disk-backed connection and recovers an immediate write after a transient lock", async () => {
    const dbA = new Database(fusionDir, { busyTimeoutMs: 0 });
    const dbB = new Database(fusionDir, { busyTimeoutMs: 0 });
    dbA.init();
    dbB.init();

    const journalA = dbA.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const journalB = dbB.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalA.journal_mode).toBe("wal");
    expect(journalB.journal_mode).toBe("wal");

    const lock = await holdWriteLock(dbA.getPath(), { releaseMode: "timer", holdMs: 150 });
    let callbackCalls = 0;

    try {
      dbB.transactionImmediate(() => {
        callbackCalls += 1;
        dbB.prepare(
          'INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
        ).run("FN-WAL-RECOVER", "Recovered write", "todo", "2025-01-01", "2025-01-01");
      });
    } finally {
      await lock.release();
      dbA.close();
      dbB.close();
    }

    const verifyDb = new Database(fusionDir);
    verifyDb.init();
    const row = verifyDb.prepare("SELECT id FROM tasks WHERE id = ?").get("FN-WAL-RECOVER");
    verifyDb.close();

    expect(callbackCalls).toBe(1);
    expect(row).toBeDefined();
  });

  it("serializes same-task disk-backed writes through withTaskLock", async () => {
    const task = await primary.createTask({ description: "Same-task serialization" });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        if (index % 2 === 0) {
          return primary.logEntry(task.id, `same-task-log-${index}`);
        }
        return primary.updateTask(task.id, { title: `Title ${index}` });
      }),
    );

    const updated = await primary.getTask(task.id);
    const customLogs = updated.log.filter((entry) => entry.action.startsWith("same-task-log-"));

    expect(customLogs).toHaveLength(10);
    expect(updated.title).toBe("Title 19");
  });

  it("updates different tasks concurrently across store connections without data loss", async () => {
    const tasks = await Promise.all(
      Array.from({ length: 16 }, (_, index) => primary.createTask({ description: `Concurrent task ${index}` })),
    );

    await Promise.all(
      tasks.map((task, index) =>
        stores[index % stores.length].updateTask(task.id, {
          title: `Updated title ${index}`,
          description: `Updated description ${index}`,
        }),
      ),
    );

    const reloaded = await Promise.all(tasks.map((task) => primary.getTask(task.id)));
    reloaded.forEach((task, index) => {
      expect(task.title).toBe(`Updated title ${index}`);
      expect(task.description).toBe(`Updated description ${index}`);
    });
  });

  it("records audit events atomically for concurrent logEntry writes with runContext", async () => {
    const runContextBase: Omit<RunMutationContext, "agentId"> = {
      runId: "run-concurrent-log-entry",
    };
    const tasks = await Promise.all(
      Array.from({ length: 12 }, (_, index) => primary.createTask({ description: `Audit task ${index}` })),
    );

    await Promise.all(
      tasks.map((task, index) =>
        stores[index % stores.length].logEntry(
          task.id,
          `audit-log-${index}`,
          undefined,
          { ...runContextBase, agentId: `agent-${index % 3}` },
        ),
      ),
    );

    const events = primary.getRunAuditEvents({ runId: runContextBase.runId });
    expect(events).toHaveLength(tasks.length);
    expect(events.every((event) => event.mutationType === "task:log")).toBe(true);

    const updatedTasks = await Promise.all(tasks.map((task) => primary.getTask(task.id)));
    updatedTasks.forEach((task, index) => {
      expect(task.log.some((entry) => entry.action === `audit-log-${index}`)).toBe(true);
    });
  });

  it("FN-4122/FN-4123/FN-4148: concurrent same-task writes across store instances don't ENOENT on task.json.tmp", async () => {
    // Reproducer for the in-review failure mode where two TaskStore instances
    // (e.g. engine + dashboard server) wrote to the same task simultaneously.
    // Both writers used a shared `task.json.tmp` filename: one rename consumed
    // the tmp, the other ENOENTed because it was no longer there. Fix uses a
    // unique tmp filename per write.
    const task = await primary.createTask({ description: "Cross-instance same-task race" });

    const writes = Array.from({ length: 40 }, (_, index) =>
      stores[index % stores.length].updateTask(task.id, {
        title: `Race title ${index}`,
      }),
    );

    // None should reject with ENOENT on task.json.tmp.
    const results = await Promise.allSettled(writes);
    const rejections = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejections.map((r) => (r.reason as Error).message)).toEqual([]);

    const reloaded = await primary.getTask(task.id);
    expect(reloaded.title).toMatch(/^Race title \d+$/);
  });

  it("moves different tasks concurrently without SQLITE_BUSY failures", async () => {
    const tasks: Task[] = await Promise.all(
      Array.from({ length: 10 }, (_, index) => primary.createTask({ description: `Move task ${index}` })),
    );

    await Promise.all(
      tasks.map((task, index) => stores[index % stores.length].moveTask(task.id, "todo")),
    );

    const moved = await Promise.all(tasks.map((task) => primary.getTask(task.id)));
    moved.forEach((task) => {
      expect(task.column).toBe("todo");
      expect(task.status).toBeUndefined();
    });
  });
});
