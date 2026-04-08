import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database, createDatabase, toJson, toJsonNullable, fromJson, normalizeTaskComments } from "./db.js";
import { DEFAULT_PROJECT_SETTINGS } from "./types.js";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-db-test-"));
}

describe("Database", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
    db = new Database(kbDir);
    db.init(); // Explicit init required — createDatabase() does not auto-init
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("creates the database file", () => {
      expect(existsSync(join(kbDir, "fusion.db"))).toBe(true);
    });

    it("creates the .fusion directory if missing", () => {
      expect(existsSync(kbDir)).toBe(true);
    });

    it("sets WAL journal mode", () => {
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
    });

    it("enables foreign keys", () => {
      const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
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
    });

    it("creates all expected indexes", () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name).sort();

      expect(indexNames).toContain("idxActivityLogTimestamp");
      expect(indexNames).toContain("idxActivityLogType");
      expect(indexNames).toContain("idxActivityLogTaskId");
      expect(indexNames).toContain("idxArchivedTasksId");
      expect(indexNames).toContain("idxAgentHeartbeatsAgentId");
      expect(indexNames).toContain("idxAgentHeartbeatsRunId");
      expect(indexNames).toContain("idxAiSessionsStatus");
      expect(indexNames).toContain("idxAiSessionsType");
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
    });

    it("seeds schema version", () => {
      expect(db.getSchemaVersion()).toBe(18);
    });

    it("seeds lastModified", () => {
      const ts = db.getLastModified();
      expect(ts).toBeGreaterThan(0);
      expect(ts).toBeLessThanOrEqual(Date.now());
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
      expect(db.getSchemaVersion()).toBe(18);
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
      const db2 = new Database(kbDir);
      db2.init();

      expect(db2.getLastModified()).toBe(ts);
      db2.close();

      // Re-assign so afterEach doesn't fail
      db = new Database(kbDir);
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
      db = new Database(kbDir);
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("migrates a v1 database by adding missing columns", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");

    // Create a v1 database manually (without comments and mergeDetails columns)
    const db = new Database(kbDir);
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

    // Verify version bumped to 5 (includes v1→v2, v2→v3, v3→v4, and v4→v5 migrations)
    expect(db.getSchemaVersion()).toBe(18);

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
    const kbDir = join(tmpDir, ".fusion");
    const db = new Database(kbDir);
    db.init();

    expect(db.getSchemaVersion()).toBe(18);

    // Re-init should not fail
    db.init();
    expect(db.getSchemaVersion()).toBe(18);

    db.close();
  });

  it("applies migration 14+15 by creating agentRatings and ai_sessions indexes", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");

    const db = new Database(kbDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '13')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    db.init();

    expect(db.getSchemaVersion()).toBe(18);

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
    const kbDir = join(tmpDir, ".fusion");

    const db = new Database(kbDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '16')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    db.init();

    expect(db.getSchemaVersion()).toBe(18);

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
    const kbDir = join(tmpDir, ".fusion");

    // Create a v2 database manually (without missionId and sliceId columns)
    const db = new Database(kbDir);
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

    // Verify version bumped to 5
    expect(db.getSchemaVersion()).toBe(18);

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
    const kbDir = join(tmpDir, ".fusion");

    const db = new Database(kbDir);
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
    const kbDir = join(tmpDir, ".fusion");

    const db = new Database(kbDir);
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
});

describe("createDatabase factory", () => {
  let tmpDir: string;

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a database instance without auto-init", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");
    const db = createDatabase(kbDir);

    // DB file exists (created on open) but schema not initialized
    expect(existsSync(join(kbDir, "fusion.db"))).toBe(true);
    // Schema is NOT yet created — querying __meta would fail
    expect(() => db.getSchemaVersion()).toThrow();

    db.close();
  });

  it("works after explicit init()", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");
    const db = createDatabase(kbDir);
    db.init();

    expect(db.getSchemaVersion()).toBe(18);
    expect(db.getLastModified()).toBeGreaterThan(0);

    db.close();
  });

  it("getPath returns the database file path", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");
    const db = createDatabase(kbDir);

    expect(db.getPath()).toBe(join(kbDir, "fusion.db"));

    db.close();
  });

  it("is idempotent when init() called multiple times", () => {
    tmpDir = makeTmpDir();
    const kbDir = join(tmpDir, ".fusion");

    // First call
    const db1 = createDatabase(kbDir);
    db1.init();
    db1.prepare("UPDATE config SET nextId = 99 WHERE id = 1").run();
    db1.close();

    // Second call — init should not overwrite data
    const db2 = createDatabase(kbDir);
    db2.init();
    const row = db2.prepare("SELECT nextId FROM config WHERE id = 1").get() as any;
    expect(row.nextId).toBe(99);
    db2.close();
  });
});
