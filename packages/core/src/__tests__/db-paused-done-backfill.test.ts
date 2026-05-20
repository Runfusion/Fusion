import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../db.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-done-paused-backfill-"));
}

describe("done paused backfill", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("repairs drifted done pause metadata in DB migration and TaskStore startup sweep", async () => {
    const rootDir = makeTmpDir();
    const globalDir = makeTmpDir();
    dirs.push(rootDir, globalDir);

    const seedStore = new TaskStore(rootDir, globalDir);
    await seedStore.init();
    const task = await seedStore.createTask({ description: "drifted done paused task" });
    await seedStore.moveTask(task.id, "todo");
    await seedStore.moveTask(task.id, "in-progress");
    await seedStore.moveTask(task.id, "in-review");
    await seedStore.moveTask(task.id, "done");
    await seedStore.updateTask(task.id, {
      paused: true,
      userPaused: true,
      pausedByAgentId: "agent-x",
      pausedReason: "manual-hold",
    });
    seedStore.close();

    const fusionDir = join(rootDir, ".fusion");
    const schemaDowngradeDb = new Database(fusionDir);
    schemaDowngradeDb.init();
    schemaDowngradeDb.prepare("UPDATE __meta SET value = '87' WHERE key = 'schemaVersion'").run();
    schemaDowngradeDb.close();

    const migrationLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = new Database(fusionDir);
    db.init();

    const migratedRow = db
      .prepare("SELECT paused, userPaused, pausedByAgentId, pausedReason FROM tasks WHERE id = ?")
      .get(task.id) as { paused: number; userPaused: number; pausedByAgentId: string | null; pausedReason: string | null };

    expect(migratedRow).toEqual({
      paused: 0,
      userPaused: 0,
      pausedByAgentId: null,
      pausedReason: null,
    });
    expect(migrationLog.mock.calls.some((call) => String(call[0]).includes("done-paused-backfill"))).toBe(true);
    db.close();

    const store = new TaskStore(rootDir, globalDir);
    await store.init();

    const writeSpy = vi.spyOn(store as any, "atomicWriteTaskJson");
    await store.watch();

    const taskJson = JSON.parse(readFileSync(join(rootDir, ".fusion", "tasks", task.id, "task.json"), "utf8")) as {
      paused?: boolean;
      userPaused?: boolean;
      pausedByAgentId?: string;
      pausedReason?: string;
    };

    expect(taskJson.paused).toBeUndefined();
    expect(taskJson.userPaused).toBeUndefined();
    expect(taskJson.pausedByAgentId).toBeUndefined();
    expect(taskJson.pausedReason).toBeUndefined();

    writeSpy.mockClear();
    await store.watch();
    expect(writeSpy).not.toHaveBeenCalled();

    store.close();
  });
});
