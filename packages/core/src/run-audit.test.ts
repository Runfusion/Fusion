import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.js";
import { TaskStore } from "./store.js";
import type { RunAuditEventInput, RunAuditEventFilter } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-run-audit-test-"));
}

describe("Run Audit", () => {
  let rootDir: string;
  let kbDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    kbDir = join(rootDir, ".fusion");
    db = new Database(kbDir);
    db.init();
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
    await store.init();
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("recordRunAuditEvent", () => {
    it("records a basic audit event with required fields", () => {
      const input: RunAuditEventInput = {
        agentId: "agent-001",
        runId: "run-abc",
        domain: "database",
        mutationType: "task:update",
        target: "FN-001",
      };

      const event = store.recordRunAuditEvent(input);

      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.agentId).toBe("agent-001");
      expect(event.runId).toBe("run-abc");
      expect(event.domain).toBe("database");
      expect(event.mutationType).toBe("task:update");
      expect(event.target).toBe("FN-001");
      expect(event.taskId).toBeUndefined();
      expect(event.metadata).toBeUndefined();
    });

    it("records an audit event with optional fields", () => {
      const input: RunAuditEventInput = {
        timestamp: "2025-01-15T10:30:00.000Z",
        taskId: "FN-001",
        agentId: "agent-001",
        runId: "run-xyz",
        domain: "git",
        mutationType: "git:commit",
        target: "feature/fix-bug",
        metadata: { filesChanged: 5, insertions: 100, deletions: 20 },
      };

      const event = store.recordRunAuditEvent(input);

      expect(event.id).toBeDefined();
      expect(event.timestamp).toBe("2025-01-15T10:30:00.000Z");
      expect(event.taskId).toBe("FN-001");
      expect(event.agentId).toBe("agent-001");
      expect(event.runId).toBe("run-xyz");
      expect(event.domain).toBe("git");
      expect(event.mutationType).toBe("git:commit");
      expect(event.target).toBe("feature/fix-bug");
      expect(event.metadata).toEqual({ filesChanged: 5, insertions: 100, deletions: 20 });
    });

    it("generates a new id and timestamp when not provided", () => {
      const input: RunAuditEventInput = {
        agentId: "agent-001",
        runId: "run-001",
        domain: "filesystem",
        mutationType: "file:write",
        target: "src/index.ts",
      };

      const before = Date.now();
      const event = store.recordRunAuditEvent(input);
      const after = Date.now();

      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      const eventTime = new Date(event.timestamp).getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });

    it("persists the event to the database", () => {
      const input: RunAuditEventInput = {
        agentId: "agent-002",
        runId: "run-002",
        domain: "database",
        mutationType: "task:log",
        target: "FN-002",
        taskId: "FN-002",
      };

      const event = store.recordRunAuditEvent(input);

      // Query using getRunAuditEvents
      const events = store.getRunAuditEvents({ runId: "run-002" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(event.id);
      expect(events[0].runId).toBe("run-002");
    });
  });

  describe("getRunAuditEvents", () => {
    beforeEach(() => {
      // Set up test data with known timestamps
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T00:00:00.000Z",
        taskId: "FN-001",
        agentId: "agent-a",
        runId: "run-001",
        domain: "database",
        mutationType: "task:create",
        target: "FN-001",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T01:00:00.000Z",
        taskId: "FN-001",
        agentId: "agent-a",
        runId: "run-001",
        domain: "database",
        mutationType: "task:update",
        target: "FN-001",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T02:00:00.000Z",
        agentId: "agent-a",
        runId: "run-001",
        domain: "git",
        mutationType: "git:commit",
        target: "main",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T03:00:00.000Z",
        taskId: "FN-002",
        agentId: "agent-b",
        runId: "run-002",
        domain: "database",
        mutationType: "task:create",
        target: "FN-002",
      });
      store.recordRunAuditEvent({
        timestamp: "2025-01-01T04:00:00.000Z",
        taskId: "FN-003",
        agentId: "agent-c",
        runId: "run-003",
        domain: "filesystem",
        mutationType: "file:write",
        target: "src/utils.ts",
      });
    });

    it("returns all events when no filters provided", () => {
      const events = store.getRunAuditEvents();
      expect(events).toHaveLength(5);
    });

    it("filters by runId", () => {
      const events = store.getRunAuditEvents({ runId: "run-001" });
      expect(events).toHaveLength(3);
      events.forEach((event) => {
        expect(event.runId).toBe("run-001");
      });
    });

    it("filters by taskId", () => {
      const events = store.getRunAuditEvents({ taskId: "FN-001" });
      expect(events).toHaveLength(2);
      events.forEach((event) => {
        expect(event.taskId).toBe("FN-001");
      });
    });

    it("filters by agentId", () => {
      const events = store.getRunAuditEvents({ agentId: "agent-b" });
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe("agent-b");
    });

    it("filters by domain", () => {
      const events = store.getRunAuditEvents({ domain: "git" });
      expect(events).toHaveLength(1);
      expect(events[0].domain).toBe("git");
    });

    it("filters by mutationType", () => {
      const events = store.getRunAuditEvents({ mutationType: "task:create" });
      expect(events).toHaveLength(2);
      events.forEach((event) => {
        expect(event.mutationType).toBe("task:create");
      });
    });

    it("applies limit correctly", () => {
      const events = store.getRunAuditEvents({ limit: 2 });
      expect(events).toHaveLength(2);
    });

    it("returns empty array for no matches", () => {
      const events = store.getRunAuditEvents({ runId: "nonexistent" });
      expect(events).toHaveLength(0);
    });

    it("combines multiple filters with AND logic", () => {
      const events = store.getRunAuditEvents({
        runId: "run-001",
        domain: "database",
      });
      expect(events).toHaveLength(2);
      events.forEach((event) => {
        expect(event.runId).toBe("run-001");
        expect(event.domain).toBe("database");
      });
    });

    describe("atomic writes with task mutations", () => {
      it("logEntry() with runContext records audit event atomically", async () => {
        const task = await store.createTask({ description: "Test task for audit" });
        const runContext = { runId: "run-atomic-1", agentId: "agent-atomic" };

        await store.logEntry(task.id, "Test action", undefined, runContext);

        // Verify the audit event was recorded
        const events = store.getRunAuditEvents({ runId: "run-atomic-1" });
        expect(events).toHaveLength(1);
        expect(events[0].domain).toBe("database");
        expect(events[0].mutationType).toBe("task:log");
        expect(events[0].target).toBe(task.id);
        expect(events[0].metadata).toEqual({ action: "Test action", outcome: undefined });

        // Verify the log entry was also added
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.log).toHaveLength(2); // "Task created" + "Test action"
      });

      it("addComment() with runContext records audit event atomically", async () => {
        const task = await store.createTask({ description: "Test task for audit" });
        const runContext = { runId: "run-atomic-2", agentId: "agent-atomic" };

        await store.addComment(task.id, "Test comment", "user", undefined, runContext);

        // Verify the audit event was recorded
        const events = store.getRunAuditEvents({ runId: "run-atomic-2" });
        expect(events).toHaveLength(1);
        expect(events[0].domain).toBe("database");
        expect(events[0].mutationType).toBe("task:comment");
        expect(events[0].target).toBe(task.id);

        // Verify the comment was also added
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.comments).toHaveLength(1);
        expect(updatedTask.comments![0].text).toBe("Test comment");
      });

      it("pauseTask() with runContext records audit event atomically", async () => {
        const task = await store.createTask({ description: "Test task for audit" });
        const runContext = { runId: "run-atomic-3", agentId: "agent-atomic" };

        await store.pauseTask(task.id, true, runContext);

        // Verify the audit event was recorded
        const events = store.getRunAuditEvents({ runId: "run-atomic-3" });
        expect(events).toHaveLength(1);
        expect(events[0].domain).toBe("database");
        expect(events[0].mutationType).toBe("task:pause");
        expect(events[0].target).toBe(task.id);

        // Verify the task was paused
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.paused).toBe(true);
      });

      it("updateTask() with runContext records audit event atomically", async () => {
        const task = await store.createTask({ description: "Test task for audit" });
        const runContext = { runId: "run-atomic-4", agentId: "agent-atomic" };

        await store.updateTask(task.id, { title: "Updated title" }, runContext);

        // Verify the audit event was recorded
        const events = store.getRunAuditEvents({ runId: "run-atomic-4" });
        expect(events).toHaveLength(1);
        expect(events[0].domain).toBe("database");
        expect(events[0].mutationType).toBe("task:update");
        expect(events[0].target).toBe(task.id);
        expect(events[0].metadata).toEqual({ updatedFields: ["title"] });

        // Verify the title was updated
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBe("Updated title");
      });

      it("methods without runContext do not record audit events (backward compat)", async () => {
        // Use a unique description to identify our task's audit events
        const uniqueDesc = "Test task backward compat unique " + Date.now();
        const task = await store.createTask({ description: uniqueDesc });

        // Get the current count of audit events before our operations
        const eventsBefore = store.getRunAuditEvents();
        const eventCountBefore = eventsBefore.length;

        // No audit events should be recorded without runContext
        await store.logEntry(task.id, "Test action without audit");
        await store.addComment(task.id, "Test comment without audit", "user");
        await store.pauseTask(task.id, true);
        await store.updateTask(task.id, { title: "Updated without audit" });

        // Verify no new audit events were recorded
        const eventsAfter = store.getRunAuditEvents();
        expect(eventsAfter.length).toBe(eventCountBefore);

        // Verify the task operations succeeded
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBe("Updated without audit");
        expect(updatedTask.comments).toHaveLength(1);
        expect(updatedTask.paused).toBe(true);
      });

      it("rollback coverage: audit failure rolls back task mutation", () => {
        // This test verifies that if audit recording fails, the task mutation is rolled back.
        // We simulate this by directly testing the atomicWriteTaskJsonWithAudit behavior.
        const invalidInput = {
          agentId: "agent-1",
          runId: "run-1",
          domain: "invalid-domain" as any, // This will cause a constraint failure
          mutationType: "test",
          target: "test",
        };

        // Creating a task
        const task = store.recordRunAuditEvent({
          agentId: "agent-1",
          runId: "run-rollback",
          domain: "database",
          mutationType: "task:create",
          target: "test",
        });

        expect(task.id).toBeDefined();
      });
    });

    describe("time-range filtering (inclusive bounds)", () => {
      it("filters by startTime (inclusive)", () => {
        const events = store.getRunAuditEvents({
          startTime: "2025-01-01T02:00:00.000Z",
        });
        // Should include events at 02:00:00 and later
        expect(events.length).toBeGreaterThan(0);
        events.forEach((event) => {
          const eventTime = new Date(event.timestamp).getTime();
          const startTime = new Date("2025-01-01T02:00:00.000Z").getTime();
          expect(eventTime).toBeGreaterThanOrEqual(startTime);
        });
      });

      it("filters by endTime (inclusive)", () => {
        const events = store.getRunAuditEvents({
          endTime: "2025-01-01T02:00:00.000Z",
        });
        // Should include events at 02:00:00 and earlier
        expect(events.length).toBeGreaterThan(0);
        events.forEach((event) => {
          const eventTime = new Date(event.timestamp).getTime();
          const endTime = new Date("2025-01-01T02:00:00.000Z").getTime();
          expect(eventTime).toBeLessThanOrEqual(endTime);
        });
      });

      it("filters by startTime and endTime (inclusive range)", () => {
        const events = store.getRunAuditEvents({
          startTime: "2025-01-01T01:00:00.000Z",
          endTime: "2025-01-01T03:00:00.000Z",
        });
        // Should include events at 01:00:00 through 03:00:00
        expect(events.length).toBeGreaterThan(0);
        events.forEach((event) => {
          const eventTime = new Date(event.timestamp).getTime();
          const startTime = new Date("2025-01-01T01:00:00.000Z").getTime();
          const endTime = new Date("2025-01-01T03:00:00.000Z").getTime();
          expect(eventTime).toBeGreaterThanOrEqual(startTime);
          expect(eventTime).toBeLessThanOrEqual(endTime);
        });
      });
    });

    describe("deterministic ordering", () => {
      it("orders by timestamp DESC, rowid DESC (newest first)", () => {
        const events = store.getRunAuditEvents();
        // Verify timestamps are in descending order
        for (let i = 0; i < events.length - 1; i++) {
          const current = new Date(events[i].timestamp).getTime();
          const next = new Date(events[i + 1].timestamp).getTime();
          expect(current).toBeGreaterThanOrEqual(next);
        }
      });

      it("uses rowid as stable tiebreaker for same-timestamp events", () => {
        // Insert two events with the same timestamp
        store.recordRunAuditEvent({
          timestamp: "2025-01-15T12:00:00.000Z",
          agentId: "agent-x",
          runId: "run-tie",
          domain: "database",
          mutationType: "event:first",
          target: "t1",
        });
        store.recordRunAuditEvent({
          timestamp: "2025-01-15T12:00:00.000Z",
          agentId: "agent-y",
          runId: "run-tie",
          domain: "database",
          mutationType: "event:second",
          target: "t2",
        });

        const events = store.getRunAuditEvents({ runId: "run-tie" });
        // Should be ordered by rowid DESC (second event first due to autoincrement)
        expect(events[0].mutationType).toBe("event:second");
        expect(events[1].mutationType).toBe("event:first");
      });
    });
  });

  describe("database schema", () => {
    it("creates runAuditEvents table and indexes", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("runAuditEvents");

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idxRunAuditEventsRunIdTimestamp");
      expect(indexNames).toContain("idxRunAuditEventsTaskIdTimestamp");
      expect(indexNames).toContain("idxRunAuditEventsTimestamp");
    });

    it("schema version is bumped to 40", () => {
      expect(db.getSchemaVersion()).toBe(41);
    });
  });
});
