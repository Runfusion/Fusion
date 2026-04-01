import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "./db-migrate.js";
import { Database } from "./db.js";
import { mkdir, writeFile, rm, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-migrate-test-"));
}

describe("detectLegacyData", () => {
  let tmpDir: string;
  let kbDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false for empty directory", () => {
    expect(detectLegacyData(kbDir)).toBe(false);
  });

  it("returns true when tasks/ exists", async () => {
    await mkdir(join(kbDir, "tasks"), { recursive: true });
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns true when config.json exists", async () => {
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "config.json"), '{"nextId":1}');
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns true when activity-log.jsonl exists", async () => {
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "activity-log.jsonl"), "");
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns true when archive.jsonl exists", async () => {
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "archive.jsonl"), "");
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns true when automations/ exists", async () => {
    await mkdir(join(kbDir, "automations"), { recursive: true });
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns true when agents/ exists", async () => {
    await mkdir(join(kbDir, "agents"), { recursive: true });
    expect(detectLegacyData(kbDir)).toBe(true);
  });

  it("returns false when db already exists", async () => {
    await mkdir(join(kbDir, "tasks"), { recursive: true });
    // Create a db file
    const db = new Database(kbDir);
    db.init();
    db.close();

    expect(detectLegacyData(kbDir)).toBe(false);
  });
});

describe("getMigrationStatus", () => {
  let tmpDir: string;
  let kbDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns all false for empty directory", () => {
    const status = getMigrationStatus(kbDir);
    expect(status).toEqual({
      hasLegacy: false,
      hasDatabase: false,
      needsMigration: false,
    });
  });

  it("returns needsMigration when legacy exists but no db", async () => {
    await mkdir(join(kbDir, "tasks"), { recursive: true });
    const status = getMigrationStatus(kbDir);
    expect(status.hasLegacy).toBe(true);
    expect(status.hasDatabase).toBe(false);
    expect(status.needsMigration).toBe(true);
  });

  it("returns no migration needed when both exist", async () => {
    await mkdir(join(kbDir, "tasks"), { recursive: true });
    const db = new Database(kbDir);
    db.init();
    db.close();

    const status = getMigrationStatus(kbDir);
    expect(status.hasLegacy).toBe(true);
    expect(status.hasDatabase).toBe(true);
    expect(status.needsMigration).toBe(false);
  });
});

describe("migrateFromLegacy", () => {
  let tmpDir: string;
  let kbDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    kbDir = join(tmpDir, ".fusion");
    await mkdir(kbDir, { recursive: true });
    db = new Database(kbDir);
    db.init();
    // Suppress migration console output in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("config migration", () => {
    it("migrates config.json to config table", async () => {
      await writeFile(
        join(kbDir, "config.json"),
        JSON.stringify({
          nextId: 42,
          nextWorkflowStepId: 3,
          settings: { maxConcurrent: 4, autoMerge: false },
          workflowSteps: [{ id: "WS-001", name: "Test", description: "Test step", prompt: "test", enabled: true, createdAt: "2025-01-01", updatedAt: "2025-01-01" }],
        }),
      );

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row.nextId).toBe(42);
      expect(row.nextWorkflowStepId).toBe(3);
      expect(JSON.parse(row.settings).maxConcurrent).toBe(4);
      expect(JSON.parse(row.workflowSteps)).toHaveLength(1);
    });
  });

  describe("task migration", () => {
    it("migrates task.json files to tasks table", async () => {
      const tasksDir = join(kbDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      await mkdir(taskDir, { recursive: true });

      const task = {
        id: "FN-001",
        title: "Test task",
        description: "A test task",
        column: "todo",
        dependencies: ["FN-000"],
        steps: [{ name: "Step 1", status: "done" }],
        currentStep: 1,
        log: [{ timestamp: "2025-01-01", action: "Created" }],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        size: "M",
        reviewLevel: 2,
        prInfo: { url: "https://github.com/test/pr/1", number: 1, status: "open", title: "PR", headBranch: "feature", baseBranch: "main", commentCount: 0 },
      };

      await writeFile(join(taskDir, "task.json"), JSON.stringify(task));
      await writeFile(join(taskDir, "PROMPT.md"), "# KB-001\n\nTest task");

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get() as any;
      expect(row).toBeDefined();
      expect(row.title).toBe("Test task");
      expect(row.column).toBe("todo");
      expect(row.size).toBe("M");
      expect(row.reviewLevel).toBe(2);
      expect(JSON.parse(row.dependencies)).toEqual(["FN-000"]);
      expect(JSON.parse(row.steps)).toHaveLength(1);
      expect(JSON.parse(row.prInfo).number).toBe(1);
    });

    it("skips invalid task.json files", async () => {
      const tasksDir = join(kbDir, "tasks");
      const validDir = join(tasksDir, "FN-001");
      const invalidDir = join(tasksDir, "FN-002");
      await mkdir(validDir, { recursive: true });
      await mkdir(invalidDir, { recursive: true });

      await writeFile(
        join(validDir, "task.json"),
        JSON.stringify({
          id: "FN-001",
          description: "Valid",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      );
      await writeFile(join(invalidDir, "task.json"), "not valid json{{");

      await migrateFromLegacy(kbDir, db);

      const valid = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get();
      const invalid = db.prepare("SELECT * FROM tasks WHERE id = 'FN-002'").get();
      expect(valid).toBeDefined();
      expect(invalid).toBeUndefined();
    });

    it("preserves blob files (PROMPT.md, agent.log, attachments)", async () => {
      const tasksDir = join(kbDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      const attachDir = join(taskDir, "attachments");
      await mkdir(attachDir, { recursive: true });

      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({
          id: "FN-001",
          description: "Test",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      );
      await writeFile(join(taskDir, "PROMPT.md"), "# KB-001\n\nTest");
      await writeFile(join(taskDir, "agent.log"), '{"timestamp":"2025","text":"hello","type":"text"}\n');
      await writeFile(join(attachDir, "test.txt"), "attachment content");

      await migrateFromLegacy(kbDir, db);

      // Blob files should still exist
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(true);
      expect(existsSync(join(taskDir, "agent.log"))).toBe(true);
      expect(existsSync(join(attachDir, "test.txt"))).toBe(true);

      // task.json should be backed up
      expect(existsSync(join(taskDir, "task.json.bak"))).toBe(true);
      expect(existsSync(join(taskDir, "task.json"))).toBe(false);
    });
  });

  describe("activity log migration", () => {
    it("migrates activity-log.jsonl to activityLog table", async () => {
      const entries = [
        { id: "1", timestamp: "2025-01-01T00:00:00.000Z", type: "task:created", taskId: "FN-001", taskTitle: "Test", details: "Created KB-001" },
        { id: "2", timestamp: "2025-01-02T00:00:00.000Z", type: "task:moved", taskId: "FN-001", details: "Moved to todo", metadata: { from: "triage", to: "todo" } },
      ];
      await writeFile(
        join(kbDir, "activity-log.jsonl"),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      await migrateFromLegacy(kbDir, db);

      const rows = db.prepare("SELECT * FROM activityLog ORDER BY timestamp").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].taskId).toBe("FN-001");
      expect(rows[1].type).toBe("task:moved");
      expect(JSON.parse(rows[1].metadata).from).toBe("triage");
    });

    it("skips malformed activity log lines", async () => {
      await writeFile(
        join(kbDir, "activity-log.jsonl"),
        '{"id":"1","timestamp":"2025","type":"task:created","details":"ok"}\nnot json\n{"id":"2","timestamp":"2025","type":"task:moved","details":"ok"}\n',
      );

      await migrateFromLegacy(kbDir, db);

      const rows = db.prepare("SELECT * FROM activityLog").all();
      expect(rows).toHaveLength(2);
    });
  });

  describe("archive migration", () => {
    it("migrates archive.jsonl to archivedTasks table", async () => {
      const entry = {
        id: "FN-001",
        title: "Archived task",
        description: "Was done",
        column: "archived",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
        archivedAt: "2025-01-15T00:00:00.000Z",
      };
      await writeFile(join(kbDir, "archive.jsonl"), JSON.stringify(entry) + "\n");

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT * FROM archivedTasks WHERE id = 'FN-001'").get() as any;
      expect(row).toBeDefined();
      expect(row.archivedAt).toBe("2025-01-15T00:00:00.000Z");
      expect(JSON.parse(row.data).title).toBe("Archived task");
    });
  });

  describe("automations migration", () => {
    it("migrates automation JSON files to automations table", async () => {
      const automationsDir = join(kbDir, "automations");
      await mkdir(automationsDir, { recursive: true });

      const schedule = {
        id: "test-uuid",
        name: "Daily backup",
        description: "Runs daily",
        scheduleType: "daily",
        cronExpression: "0 0 * * *",
        command: "echo backup",
        enabled: true,
        runCount: 5,
        runHistory: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      await writeFile(join(automationsDir, "test-uuid.json"), JSON.stringify(schedule));

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT * FROM automations WHERE id = 'test-uuid'").get() as any;
      expect(row).toBeDefined();
      expect(row.name).toBe("Daily backup");
      expect(row.runCount).toBe(5);
      expect(row.enabled).toBe(1);
    });
  });

  describe("agents migration", () => {
    it("migrates agent JSON files and heartbeats", async () => {
      const agentsDir = join(kbDir, "agents");
      await mkdir(agentsDir, { recursive: true });

      const agent = {
        id: "agent-001",
        name: "Executor 1",
        role: "executor",
        state: "idle",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        metadata: { version: 1 },
      };
      await writeFile(join(agentsDir, "agent-001.json"), JSON.stringify(agent));

      // Write heartbeats
      const heartbeats = [
        { agentId: "agent-001", timestamp: "2025-01-01T00:00:00.000Z", status: "ok", runId: "run-1" },
        { agentId: "agent-001", timestamp: "2025-01-01T00:01:00.000Z", status: "ok", runId: "run-1" },
      ];
      await writeFile(
        join(agentsDir, "agent-001-heartbeats.jsonl"),
        heartbeats.map((h) => JSON.stringify(h)).join("\n") + "\n",
      );

      await migrateFromLegacy(kbDir, db);

      const agentRow = db.prepare("SELECT * FROM agents WHERE id = 'agent-001'").get() as any;
      expect(agentRow).toBeDefined();
      expect(agentRow.name).toBe("Executor 1");
      expect(agentRow.role).toBe("executor");
      expect(JSON.parse(agentRow.metadata).version).toBe(1);

      const heartbeatRows = db.prepare("SELECT * FROM agentHeartbeats WHERE agentId = 'agent-001'").all();
      expect(heartbeatRows).toHaveLength(2);
    });
  });

  describe("backups", () => {
    it("backs up config.json, activity-log.jsonl, archive.jsonl", async () => {
      await writeFile(join(kbDir, "config.json"), '{"nextId":1}');
      await writeFile(join(kbDir, "activity-log.jsonl"), "");
      await writeFile(join(kbDir, "archive.jsonl"), "");

      await migrateFromLegacy(kbDir, db);

      expect(existsSync(join(kbDir, "config.json.bak"))).toBe(true);
      expect(existsSync(join(kbDir, "activity-log.jsonl.bak"))).toBe(true);
      expect(existsSync(join(kbDir, "archive.jsonl.bak"))).toBe(true);

      // Originals should be gone
      expect(existsSync(join(kbDir, "config.json"))).toBe(false);
      expect(existsSync(join(kbDir, "activity-log.jsonl"))).toBe(false);
      expect(existsSync(join(kbDir, "archive.jsonl"))).toBe(false);
    });

    it("backs up automations/ and agents/ directories", async () => {
      await mkdir(join(kbDir, "automations"), { recursive: true });
      await mkdir(join(kbDir, "agents"), { recursive: true });

      await migrateFromLegacy(kbDir, db);

      expect(existsSync(join(kbDir, "automations.bak"))).toBe(true);
      expect(existsSync(join(kbDir, "agents.bak"))).toBe(true);
      expect(existsSync(join(kbDir, "automations"))).toBe(false);
      expect(existsSync(join(kbDir, "agents"))).toBe(false);
    });

    it("backs up individual task.json files, preserving blob files", async () => {
      const tasksDir = join(kbDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      await mkdir(taskDir, { recursive: true });

      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({
          id: "FN-001",
          description: "Test",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        }),
      );
      await writeFile(join(taskDir, "PROMPT.md"), "# Test");

      await migrateFromLegacy(kbDir, db);

      // tasks/ directory should still exist
      expect(existsSync(tasksDir)).toBe(true);
      // PROMPT.md should still be there
      expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(true);
      // task.json should be backed up
      expect(existsSync(join(taskDir, "task.json.bak"))).toBe(true);
      expect(existsSync(join(taskDir, "task.json"))).toBe(false);
    });
  });

  describe("idempotency", () => {
    it("does not fail when no legacy data exists", async () => {
      // Fresh kbDir with no legacy files
      await expect(migrateFromLegacy(kbDir, db)).resolves.not.toThrow();
    });
  });

  describe("comment migration", () => {
    it("deduplicates overlapping steeringComments and comments during legacy import", async () => {
      const tasksDir = join(kbDir, "tasks");
      const taskDir = join(tasksDir, "FN-002");
      await mkdir(taskDir, { recursive: true });

      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({
          id: "FN-002",
          description: "Comment overlap",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          steeringComments: [
            { id: "c1", text: "Use TypeScript", createdAt: "2025-01-01T00:00:00.000Z", author: "user" },
          ],
          comments: [
            { id: "c1", text: "Use TypeScript", createdAt: "2025-01-01T00:00:00.000Z", author: "user", updatedAt: "2025-01-02T00:00:00.000Z" },
            { id: "c2", text: "General note", createdAt: "2025-01-03T00:00:00.000Z", author: "alice" },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      );

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT steeringComments, comments FROM tasks WHERE id = 'FN-002'").get() as any;
      expect(JSON.parse(row.steeringComments)).toEqual([
        { id: "c1", text: "Use TypeScript", createdAt: "2025-01-01T00:00:00.000Z", author: "user" },
      ]);
      expect(JSON.parse(row.comments)).toEqual([
        { id: "c1", text: "Use TypeScript", createdAt: "2025-01-01T00:00:00.000Z", author: "user", updatedAt: "2025-01-02T00:00:00.000Z" },
        { id: "c2", text: "General note", createdAt: "2025-01-03T00:00:00.000Z", author: "alice" },
      ]);
    });
  });

  describe("data integrity", () => {
    it("preserves all task fields through migration", async () => {
      const tasksDir = join(kbDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      await mkdir(taskDir, { recursive: true });

      const fullTask = {
        id: "FN-001",
        title: "Full task",
        description: "All fields populated",
        column: "in-progress",
        status: "running",
        size: "L",
        reviewLevel: 3,
        currentStep: 2,
        worktree: "/tmp/wt",
        blockedBy: "FN-000",
        paused: true,
        baseBranch: "main",
        modelPresetId: "complex",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
        mergeRetries: 2,
        error: "Something",
        summary: "Fixed it",
        thinkingLevel: "high",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        columnMovedAt: "2025-01-02T00:00:00.000Z",
        dependencies: ["FN-000"],
        steps: [{ name: "Step 1", status: "done" }, { name: "Step 2", status: "in-progress" }],
        log: [{ timestamp: "2025-01-01", action: "Created" }],
        attachments: [{ filename: "test.png", originalName: "test.png", mimeType: "image/png", size: 1024, createdAt: "2025-01-01" }],
        steeringComments: [{ id: "c1", text: "Fix this", createdAt: "2025-01-01", author: "user" }],
        workflowStepResults: [{ workflowStepId: "WS-001", workflowStepName: "QA", status: "passed" }],
        prInfo: { url: "https://github.com/test/pr/1", number: 1, status: "open", title: "PR", headBranch: "feature", baseBranch: "main", commentCount: 3 },
        issueInfo: { url: "https://github.com/test/issues/1", number: 10, state: "open", title: "Issue" },
        breakIntoSubtasks: true,
        enabledWorkflowSteps: ["WS-001", "WS-002"],
      };

      await writeFile(join(taskDir, "task.json"), JSON.stringify(fullTask));

      await migrateFromLegacy(kbDir, db);

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get() as any;
      expect(row.id).toBe("FN-001");
      expect(row.title).toBe("Full task");
      expect(row.column).toBe("in-progress");
      expect(row.status).toBe("running");
      expect(row.size).toBe("L");
      expect(row.reviewLevel).toBe(3);
      expect(row.currentStep).toBe(2);
      expect(row.worktree).toBe("/tmp/wt");
      expect(row.blockedBy).toBe("FN-000");
      expect(row.paused).toBe(1);
      expect(row.baseBranch).toBe("main");
      expect(row.modelPresetId).toBe("complex");
      expect(row.modelProvider).toBe("anthropic");
      expect(row.modelId).toBe("claude-sonnet-4-5");
      expect(row.validatorModelProvider).toBe("openai");
      expect(row.validatorModelId).toBe("gpt-4o");
      expect(row.mergeRetries).toBe(2);
      expect(row.error).toBe("Something");
      expect(row.summary).toBe("Fixed it");
      expect(row.thinkingLevel).toBe("high");
      expect(row.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(row.updatedAt).toBe("2025-01-02T00:00:00.000Z");
      expect(row.columnMovedAt).toBe("2025-01-02T00:00:00.000Z");
      expect(JSON.parse(row.dependencies)).toEqual(["FN-000"]);
      expect(JSON.parse(row.steps)).toHaveLength(2);
      expect(JSON.parse(row.log)).toHaveLength(1);
      expect(JSON.parse(row.attachments)).toHaveLength(1);
      expect(JSON.parse(row.steeringComments)).toHaveLength(1);
      expect(JSON.parse(row.comments)).toEqual([
        { id: "c1", text: "Fix this", createdAt: "2025-01-01", author: "user" },
      ]);
      expect(JSON.parse(row.workflowStepResults)).toHaveLength(1);
      expect(JSON.parse(row.prInfo).number).toBe(1);
      expect(JSON.parse(row.issueInfo).number).toBe(10);
      expect(row.breakIntoSubtasks).toBe(1);
      expect(JSON.parse(row.enabledWorkflowSteps)).toEqual(["WS-001", "WS-002"]);
    });
  });
});
