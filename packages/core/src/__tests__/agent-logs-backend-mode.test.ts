import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAgentLogBatchImpl, flushAgentLogBufferImpl } from "../task-store/agent-logs.js";
import { appendAgentLogImpl } from "../task-store/workflow-integrity.js";
import { getAgentLogCountImpl, getAgentLogsImpl } from "../task-store/remaining-ops-7.js";
import { dbImpl } from "../task-store/remaining-ops-5.js";
import { readAgentLogEntries } from "../agent-log-file-store.js";

/**
 * FNXC:PostgresBackend 2026-06-27-00:40:
 * Regression for the PG-backend agent-log crash. The synchronous SQLite
 * `store.db` getter THROWS in backend mode; the agent-log flush/append path runs
 * on an unref'd setTimeout retry timer, so any unguarded `store.db` deref there
 * (including inside a catch handler that builds a `${store.db.path}` log string)
 * is an UNCAUGHT throw that exits the process — observed as `fn serve` exit(1)
 * after ~35s on the embedded-Postgres default.
 *
 * Surface enumeration: the buffer path has three entry points that all touched
 * `store.db` unguarded — flushAgentLogBufferImpl (single-append flush + retry
 * timer), appendAgentLogImpl (producer: backlog-cap warning + size/timer flush
 * catch handlers), and appendAgentLogBatchImpl (batch append). The invariant
 * these tests pin: NONE of them may dereference `store.db` when backendMode is
 * true, and all must still durably write the per-task agent-log.jsonl.
 */

const tempDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-agent-log-backend-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Minimal backend-mode store double whose `db`/`archiveDb` getters throw exactly
 * like the real TaskStore getters do when `backendMode` is true. `dbTouched()`
 * reports whether any code path reached into the SQLite handle.
 */
function makeBackendStore(fusionDir: string): { store: any; dbTouched: () => boolean } {
  let touched = false;
  const store: any = {
    backendMode: true,
    closing: false,
    fusionDir,
    agentLogBuffer: [] as unknown[],
    agentLogFlushTimer: null as ReturnType<typeof setTimeout> | null,
    get db(): never {
      touched = true;
      throw new Error(
        "TaskStore.db: SQLite Database is not available in backend mode (AsyncDataLayer injected)",
      );
    },
    get archiveDb(): never {
      touched = true;
      throw new Error("TaskStore.archiveDb: not available in backend mode");
    },
    taskDir: (id: string) => join(fusionDir, "tasks", id),
    scanAndRecordCitations: () => [],
    recordGoalCitations: async () => [],
    emit: () => true,
    flushAgentLogBuffer(this: any) {
      flushAgentLogBufferImpl(this);
    },
  };
  return { store, dbTouched: () => touched };
}

describe("backend-mode SQLite access guidance", () => {
  it("directs backend callers to AsyncDataLayer plugin authoring guidance", () => {
    expect(() => dbImpl({ backendMode: true } as never)).toThrow(/getAsyncLayer\(\).*docs\/PLUGIN_AUTHORING\.md/);
  });
});

describe("agent-log read filtering", () => {
  it("filters before pagination and counts the filtered result", async () => {
    const dir = tmp();
    const taskId = "FN-filter";
    const taskDir = join(dir, "tasks", taskId);
    const store = {
      backendMode: true,
      taskDir: () => taskDir,
      flushAgentLogBuffer: () => {},
    } as any;
    const lines = [
      { timestamp: "2026-01-01T00:00:00.000Z", taskId, text: "one", type: "text" },
      { timestamp: "2026-01-01T00:01:00.000Z", taskId, text: "status", type: "status" },
      { timestamp: "2026-01-01T00:02:00.000Z", taskId, text: "two", type: "text" },
      { timestamp: "2026-01-01T00:03:00.000Z", taskId, text: "three", type: "text" },
    ];
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "agent-log.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    await expect(getAgentLogsImpl(store, taskId, { type: "text", limit: 1, offset: 1 })).resolves.toMatchObject([{ text: "two" }]);
    await expect(getAgentLogCountImpl(store, taskId, { type: "text" })).resolves.toBe(3);
    await expect(getAgentLogCountImpl(store, taskId)).resolves.toBe(4);
  });
});

describe("agent-log buffer in PG backend mode", () => {
  it("flushAgentLogBufferImpl writes JSONL without dereferencing store.db", () => {
    const dir = tmp();
    const { store, dbTouched } = makeBackendStore(dir);
    store.agentLogBuffer.push({
      taskId: "FN-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      text: "hello",
      type: "text",
      detail: null,
      agent: null,
    });

    expect(() => flushAgentLogBufferImpl(store)).not.toThrow();
    expect(dbTouched()).toBe(false);
    expect(readAgentLogEntries(store.taskDir("FN-1")).map((e) => e.text)).toEqual(["hello"]);
    expect(store.agentLogBuffer).toHaveLength(0);
  });

  it("appendAgentLogImpl buffers + flushes without dereferencing store.db", async () => {
    const dir = tmp();
    const { store, dbTouched } = makeBackendStore(dir);

    await expect(appendAgentLogImpl(store, "FN-2", "world", "text")).resolves.toBeUndefined();
    flushAgentLogBufferImpl(store);

    expect(dbTouched()).toBe(false);
    expect(readAgentLogEntries(store.taskDir("FN-2")).map((e) => e.text)).toEqual(["world"]);
  });

  it("appendAgentLogBatchImpl persists every entry without dereferencing store.db", async () => {
    const dir = tmp();
    const { store, dbTouched } = makeBackendStore(dir);

    await expect(
      appendAgentLogBatchImpl(store, [
        { taskId: "FN-3", text: "a", type: "text" },
        { taskId: "FN-3", text: "b", type: "text" },
      ]),
    ).resolves.toBeUndefined();

    expect(dbTouched()).toBe(false);
    expect(readAgentLogEntries(store.taskDir("FN-3")).map((e) => e.text)).toEqual(["a", "b"]);
  });

  // FN-5893 surface coverage: the crash vector is not the happy path but the
  // catch/retry-timer handlers that the fix's FNXC comments name explicitly. A
  // flush FAILURE must still never reach store.db — neither in the retry-flush
  // setTimeout (agent-logs.ts) nor in appendAgentLogImpl's timer-flush catch
  // (workflow-integrity.ts). We force the failure by making the per-task JSONL
  // append throw (its `tasks/` parent is a regular file → ENOTDIR).
  it("retry-flush timer survives a failing flush without dereferencing store.db", () => {
    vi.useFakeTimers();
    try {
      const dir = tmp();
      writeFileSync(join(dir, "tasks"), "not-a-dir");
      const { store, dbTouched } = makeBackendStore(dir);
      store.agentLogBuffer.push({
        taskId: "FN-9",
        timestamp: "2026-01-01T00:00:00.000Z",
        text: "boom",
        type: "text",
        detail: null,
        agent: null,
      });

      // The append throws, so the flush itself throws — but it must schedule a
      // retry timer and must not have touched store.db on the way out.
      expect(() => flushAgentLogBufferImpl(store)).toThrow();
      expect(store.agentLogFlushTimer).not.toBeNull();
      expect(dbTouched()).toBe(false);

      // Firing the retry timer must not surface an UNCAUGHT throw: its catch
      // logs via store.fusionDir, never store.db.path. (A regression that puts
      // store.db.path back here flips dbTouched to true or throws out of advance.)
      expect(() => vi.advanceTimersToNextTimer()).not.toThrow();
      expect(dbTouched()).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("appendAgentLogImpl timer-flush catch survives a failing flush without store.db", async () => {
    vi.useFakeTimers();
    try {
      const dir = tmp();
      writeFileSync(join(dir, "tasks"), "not-a-dir");
      const { store, dbTouched } = makeBackendStore(dir);

      // Buffers one entry and schedules the flush timer (no size-triggered flush).
      await appendAgentLogImpl(store, "FN-10", "boom", "text");
      expect(store.agentLogFlushTimer).not.toBeNull();
      expect(dbTouched()).toBe(false);

      // The timer-triggered flush fails; its catch logs via store.fusionDir.
      expect(() => vi.advanceTimersToNextTimer()).not.toThrow();
      expect(dbTouched()).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
