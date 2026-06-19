/*
FNXC:Database 2026-06-16-09:40:
Command Center / SDLC work (PR #1683) added usage_events, knowledge_pages, deployments, and incidents tables behind schema migrations 118-120. These legacy-data migration tests guard the separate legacy-import path so the in-DB schema migrations and the legacy importer stay independent.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectLegacyData, migrateFromLegacy, getMigrationStatus } from "../db-migrate.js";
import { Database, SCHEMA_VERSION } from "../db.js";
import { mkdir, writeFile, rm, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-migrate-test-"));
}

describe("detectLegacyData", () => {
  let tmpDir: string;
  let fusionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false for empty directory", () => {
    expect(detectLegacyData(fusionDir)).toBe(false);
  });

  it("returns true when tasks/ exists", async () => {
    await mkdir(join(fusionDir, "tasks"), { recursive: true });
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns true when config.json exists", async () => {
    await mkdir(fusionDir, { recursive: true });
    await writeFile(join(fusionDir, "config.json"), '{"nextId":1}');
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns true when activity-log.jsonl exists", async () => {
    await mkdir(fusionDir, { recursive: true });
    await writeFile(join(fusionDir, "activity-log.jsonl"), "");
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns true when archive.jsonl exists", async () => {
    await mkdir(fusionDir, { recursive: true });
    await writeFile(join(fusionDir, "archive.jsonl"), "");
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns true when automations/ exists", async () => {
    await mkdir(join(fusionDir, "automations"), { recursive: true });
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns true when agents/ exists", async () => {
    await mkdir(join(fusionDir, "agents"), { recursive: true });
    expect(detectLegacyData(fusionDir)).toBe(true);
  });

  it("returns false when db already exists", async () => {
    await mkdir(join(fusionDir, "tasks"), { recursive: true });
    // Create a db file
    const db = new Database(fusionDir);
    db.init();
    db.close();

    expect(detectLegacyData(fusionDir)).toBe(false);
  });
});

describe("getMigrationStatus", () => {
  let tmpDir: string;
  let fusionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns all false for empty directory", () => {
    const status = getMigrationStatus(fusionDir);
    expect(status).toEqual({
      hasLegacy: false,
      hasDatabase: false,
      needsMigration: false,
    });
  });

  it("returns needsMigration when legacy exists but no db", async () => {
    await mkdir(join(fusionDir, "tasks"), { recursive: true });
    const status = getMigrationStatus(fusionDir);
    expect(status.hasLegacy).toBe(true);
    expect(status.hasDatabase).toBe(false);
    expect(status.needsMigration).toBe(true);
  });

  it("returns no migration needed when both exist", async () => {
    await mkdir(join(fusionDir, "tasks"), { recursive: true });
    const db = new Database(fusionDir);
    db.init();
    db.close();

    const status = getMigrationStatus(fusionDir);
    expect(status.hasLegacy).toBe(true);
    expect(status.hasDatabase).toBe(true);
    expect(status.needsMigration).toBe(false);
  });
});

describe("migrateFromLegacy", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    await mkdir(fusionDir, { recursive: true });
    db = new Database(fusionDir);
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
        join(fusionDir, "config.json"),
        JSON.stringify({
          nextId: 42,
          nextWorkflowStepId: 3,
          settings: { maxConcurrent: 4, autoMerge: false },
          workflowSteps: [{ id: "WS-001", name: "Test", description: "Test step", prompt: "test", enabled: true, createdAt: "2025-01-01", updatedAt: "2025-01-01" }],
        }),
      );

      await migrateFromLegacy(fusionDir, db);

      const row = db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
      expect(row.nextId).toBe(42);
      expect(row.nextWorkflowStepId).toBe(3);
      expect(JSON.parse(row.settings).maxConcurrent).toBe(4);
      expect(JSON.parse(row.workflowSteps)).toHaveLength(1);

      const workflowRows = db.prepare("SELECT * FROM workflow_steps ORDER BY id ASC").all() as any[];
      expect(workflowRows).toHaveLength(1);
      expect(workflowRows[0]).toMatchObject({
        id: "WS-001",
        name: "Test",
        description: "Test step",
        mode: "prompt",
        phase: "pre-merge",
        prompt: "test",
        enabled: 1,
      });
    });
  });

  describe("task migration", () => {
    it("migrates task.json files to tasks table", async () => {
      const tasksDir = join(fusionDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      await mkdir(taskDir, { recursive: true });

      const task = {
        id: "FN-001",
        title: "Test task",
        description: "A test task",
        priority: "urgent",
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

      await migrateFromLegacy(fusionDir, db);

      const row = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get() as any;
      expect(row).toBeDefined();
      expect(row.title).toBe("Test task");
      expect(row.column).toBe("todo");
      expect(row.priority).toBe("urgent");
      expect(row.size).toBe("M");
      expect(row.reviewLevel).toBe(2);
      expect(JSON.parse(row.dependencies)).toEqual(["FN-000"]);
      expect(JSON.parse(row.steps)).toHaveLength(1);
      expect(JSON.parse(row.prInfo).number).toBe(1);
    });

    it("defaults migrated tasks to normal priority when legacy task.json omits priority", async () => {
      const tasksDir = join(fusionDir, "tasks");
      const taskDir = join(tasksDir, "FN-001");
      await mkdir(taskDir, { recursive: true });

      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({
          id: "FN-001",
          description: "Legacy priorityless task",
          column: "triage",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      );

      await migrateFromLegacy(fusionDir, db);

      const row = db.prepare("SELECT priority FROM tasks WHERE id = 'FN-001'").get() as { priority: string };
      expect(row.priority).toBe("normal");
    });

    it("skips invalid task.json files", async () => {
      const tasksDir = join(fusionDir, "tasks");
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

      await migrateFromLegacy(fusionDir, db);

      const valid = db.prepare("SELECT * FROM tasks WHERE id = 'FN-001'").get();
      const invalid = db.prepare("SELECT * FROM tasks WHERE id = 'FN-002'").get();
      expect(valid).toBeDefined();
      expect(invalid).toBeUndefined();
    });

    it("preserves blob files (PROMPT.md, agent.log, attachments)", async () => {
      const tasksDir = join(fusionDir, "tasks");
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

      await migrateFromLegacy(fusionDir, db);

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
        join(fusionDir, "activity-log.jsonl"),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      await migrateFromLegacy(fusionDir, db);

      const rows = db.prepare("SELECT * FROM activityLog ORDER BY timestamp").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].taskId).toBe("FN-001");
      expect(rows[1].type).toBe("task:moved");
      expect(JSON.parse(rows[1].metadata).from).toBe("triage");
    });

    it("skips malformed activity log lines", async () => {
      await writeFile(
        join(fusionDir, "activity-log.jsonl"),
        '{"id":"1","timestamp":"2025","type":"task:created","details":"ok"}\nnot json\n{"id":"2","timestamp":"2025","type":"task:moved","details":"ok"}\n',
      );

      await migrateFromLegacy(fusionDir, db);

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
      await writeFile(join(fusionDir, "archive.jsonl"), JSON.stringify(entry) + "\n");

      await migrateFromLegacy(fusionDir, db);

      const row = db.prepare("SELECT * FROM archivedTasks WHERE id = 'FN-001'").get() as any;
      expect(row).toBeDefined();
      expect(row.archivedAt).toBe("2025-01-15T00:00:00.000Z");
      expect(JSON.parse(row.data).title).toBe("Archived task");
    });
  });

  describe("automations migration", () => {
    it("migrates automation JSON files to automations table", async () => {
      const automationsDir = join(fusionDir, "automations");
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

      await migrateFromLegacy(fusionDir, db);

      const row = db.prepare("SELECT * FROM automations WHERE id = 'test-uuid'").get() as any;
      expect(row).toBeDefined();
      expect(row.name).toBe("Daily backup");
      expect(row.runCount).toBe(5);
      expect(row.enabled).toBe(1);
    });
  });

  describe("agents migration", () => {
    it("migrates agent JSON files and heartbeats", async () => {
      const agentsDir = join(fusionDir, "agents");
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

      await migrateFromLegacy(fusionDir, db);

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
      await writeFile(join(fusionDir, "config.json"), '{"nextId":1}');
      await writeFile(join(fusionDir, "activity-log.jsonl"), "");
      await writeFile(join(fusionDir, "archive.jsonl"), "");

      await migrateFromLegacy(fusionDir, db);

      expect(existsSync(join(fusionDir, "config.json.bak"))).toBe(true);
      expect(existsSync(join(fusionDir, "activity-log.jsonl.bak"))).toBe(true);
      expect(existsSync(join(fusionDir, "archive.jsonl.bak"))).toBe(true);

      // Originals should be gone
      expect(existsSync(join(fusionDir, "config.json"))).toBe(false);
      expect(existsSync(join(fusionDir, "activity-log.jsonl"))).toBe(false);
      expect(existsSync(join(fusionDir, "archive.jsonl"))).toBe(false);
    });

    it("backs up automations/ and agents/ directories", async () => {
      await mkdir(join(fusionDir, "automations"), { recursive: true });
      await mkdir(join(fusionDir, "agents"), { recursive: true });

      await migrateFromLegacy(fusionDir, db);

      expect(existsSync(join(fusionDir, "automations.bak"))).toBe(true);
      expect(existsSync(join(fusionDir, "agents.bak"))).toBe(true);
      expect(existsSync(join(fusionDir, "automations"))).toBe(false);
      expect(existsSync(join(fusionDir, "agents"))).toBe(false);
    });

    it("backs up individual task.json files, preserving blob files", async () => {
      const tasksDir = join(fusionDir, "tasks");
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

      await migrateFromLegacy(fusionDir, db);

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
      // Fresh fusionDir with no legacy files
      await expect(migrateFromLegacy(fusionDir, db)).resolves.not.toThrow();
    });
  });

  describe("comment migration", () => {
    it("deduplicates overlapping steeringComments and comments during legacy import", async () => {
      const tasksDir = join(fusionDir, "tasks");
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

      await migrateFromLegacy(fusionDir, db);

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
      const tasksDir = join(fusionDir, "tasks");
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
        sourceIssue: {
          provider: "github",
          repository: "runfusion/fusion",
          externalIssueId: "I_kgDOExample",
          issueNumber: 10,
          url: "https://github.com/test/issues/1",
          closedAt: "2026-06-18T12:00:00.000Z",
        },
        breakIntoSubtasks: true,
        enabledWorkflowSteps: ["WS-001", "WS-002"],
      };

      await writeFile(join(taskDir, "task.json"), JSON.stringify(fullTask));

      await migrateFromLegacy(fusionDir, db);

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
      expect(row.sourceIssueProvider).toBe("github");
      expect(row.sourceIssueRepository).toBe("runfusion/fusion");
      expect(row.sourceIssueExternalIssueId).toBe("I_kgDOExample");
      expect(row.sourceIssueNumber).toBe(10);
      expect(row.sourceIssueUrl).toBe("https://github.com/test/issues/1");
      expect(row.sourceIssueClosedAt).toBe("2026-06-18T12:00:00.000Z");
      expect(row.breakIntoSubtasks).toBe(1);
      expect(JSON.parse(row.enabledWorkflowSteps)).toEqual(["WS-001", "WS-002"]);
    });
  });
});

describe("schema migration", () => {
  let tmpDir: string;
  let fusionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds tasks.githubTracking when migrating from schema version 70", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        issueInfo TEXT
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '70')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`INSERT INTO tasks (id, description, "column", createdAt, updatedAt, issueInfo) VALUES ('FN-legacy', 'legacy', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '{\"number\":1}')`);

    db.init();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("githubTracking");

    const row = db.prepare("SELECT id, issueInfo FROM tasks WHERE id = 'FN-legacy'").get() as { id: string; issueInfo: string };
    expect(row.id).toBe("FN-legacy");
    expect(JSON.parse(row.issueInfo).number).toBe(1);

    db.close();
  });

  it("adds deletedAt column + index when migrating from schema version 86", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '86')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec("INSERT INTO tasks (id, description, \"column\", createdAt, updatedAt) VALUES ('FN-legacy', 'legacy', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");

    db.init();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("deletedAt");

    const indexes = db.prepare("PRAGMA index_list(tasks)").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "idx_tasks_deletedAt")).toBe(true);

    const row = db.prepare("SELECT deletedAt FROM tasks WHERE id = 'FN-legacy'").get() as { deletedAt: string | null };
    expect(row.deletedAt).toBeNull();
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds sourceIssueClosedAt when migrating from schema version 121 without data loss", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        sourceIssueProvider TEXT,
        sourceIssueRepository TEXT,
        sourceIssueExternalIssueId TEXT,
        sourceIssueNumber INTEGER,
        sourceIssueUrl TEXT,
        tokenUsageModelProvider TEXT,
        tokenUsageModelId TEXT
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '121')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      INSERT INTO tasks (
        id, description, "column", createdAt, updatedAt,
        sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId,
        sourceIssueNumber, sourceIssueUrl
      ) VALUES (
        'FN-source', 'legacy source issue', 'done', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z',
        'github', 'runfusion/fusion', 'I_kgDOExample', 10, 'https://github.com/runfusion/fusion/issues/10'
      )
    `);

    db.init();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("sourceIssueClosedAt");

    const row = db.prepare(`
      SELECT sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId,
             sourceIssueNumber, sourceIssueUrl, sourceIssueClosedAt
      FROM tasks WHERE id = 'FN-source'
    `).get() as {
      sourceIssueProvider: string;
      sourceIssueRepository: string;
      sourceIssueExternalIssueId: string;
      sourceIssueNumber: number;
      sourceIssueUrl: string;
      sourceIssueClosedAt: string | null;
    };
    expect(row).toEqual({
      sourceIssueProvider: "github",
      sourceIssueRepository: "runfusion/fusion",
      sourceIssueExternalIssueId: "I_kgDOExample",
      sourceIssueNumber: 10,
      sourceIssueUrl: "https://github.com/runfusion/fusion/issues/10",
      sourceIssueClosedAt: null,
    });
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds tokenUsagePerModel when migrating from schema version 124 without data loss", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        tokenUsageInputTokens INTEGER,
        tokenUsageOutputTokens INTEGER,
        tokenUsageCachedTokens INTEGER,
        tokenUsageCacheWriteTokens INTEGER,
        tokenUsageTotalTokens INTEGER,
        tokenUsageFirstUsedAt TEXT,
        tokenUsageLastUsedAt TEXT,
        tokenUsageModelProvider TEXT,
        tokenUsageModelId TEXT
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '124')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      INSERT INTO tasks (
        id, description, "column", createdAt, updatedAt,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageFirstUsedAt,
        tokenUsageLastUsedAt, tokenUsageModelProvider, tokenUsageModelId
      ) VALUES (
        'FN-token', 'legacy token usage', 'done', '2026-03-01T00:00:00.000Z', '2026-03-01T00:03:00.000Z',
        95, 45, 0, 0, 140, '2026-03-01T00:00:00.000Z', '2026-03-01T00:03:00.000Z', 'openai', 'gpt-5'
      )
    `);

    db.init();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("tokenUsagePerModel");

    const row = db.prepare(`
      SELECT tokenUsageInputTokens, tokenUsageTotalTokens, tokenUsageModelProvider, tokenUsageModelId, tokenUsagePerModel
      FROM tasks WHERE id = 'FN-token'
    `).get() as {
      tokenUsageInputTokens: number;
      tokenUsageTotalTokens: number;
      tokenUsageModelProvider: string;
      tokenUsageModelId: string;
      tokenUsagePerModel: string | null;
    };
    expect(row).toEqual({
      tokenUsageInputTokens: 95,
      tokenUsageTotalTokens: 140,
      tokenUsageModelProvider: "openai",
      tokenUsageModelId: "gpt-5",
      tokenUsagePerModel: null,
    });
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds workflow_steps.gateMode and backfills legacy rows by mode", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'prompt',
        phase TEXT NOT NULL DEFAULT 'pre-merge',
        prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '75')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec("INSERT INTO workflow_steps (id, name, description, mode, phase, prompt, enabled, createdAt, updatedAt) VALUES ('WS-001', 'Prompt', 'Prompt step', 'prompt', 'pre-merge', 'p', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");
    db.exec("INSERT INTO workflow_steps (id, name, description, mode, phase, prompt, enabled, createdAt, updatedAt) VALUES ('WS-002', 'Script', 'Script step', 'script', 'pre-merge', '', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");

    db.init();

    const rows = db.prepare("SELECT id, mode, gateMode FROM workflow_steps ORDER BY id ASC").all() as Array<{ id: string; mode: string; gateMode: string }>;
    expect(rows).toEqual([
      { id: "WS-001", mode: "prompt", gateMode: "advisory" },
      { id: "WS-002", mode: "script", gateMode: "advisory" },
    ]);
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds retry-burned task counters when migrating from schema version 77", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        currentStep INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '77')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      INSERT INTO tasks (
        id, description, "column", currentStep, createdAt, updatedAt
      ) VALUES (
        'FN-0001', 'legacy row', 'todo', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
      )
    `);

    db.init();

    const columns = db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((col) => col.name));
    expect(names.has("branchConflictRecoveryCount")).toBe(true);
    expect(names.has("reviewerContextRetryCount")).toBe(true);
    expect(names.has("reviewerFallbackRetryCount")).toBe(true);

    const counts = db
      .prepare("SELECT branchConflictRecoveryCount, reviewerContextRetryCount, reviewerFallbackRetryCount FROM tasks WHERE id = ?")
      .get("FN-0001") as {
        branchConflictRecoveryCount: number;
        reviewerContextRetryCount: number;
        reviewerFallbackRetryCount: number;
      };
    expect(counts).toEqual({
      branchConflictRecoveryCount: 0,
      reviewerContextRetryCount: 0,
      reviewerFallbackRetryCount: 0,
    });
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds milestones.acceptanceCriteria when migrating from schema version 79", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        missionId TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        interviewState TEXT NOT NULL,
        dependencies TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '79')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");

    db.init();

    const columns = db.prepare("PRAGMA table_info(milestones)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("acceptanceCriteria");
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds branch_groups table and autoMerge columns when migrating from schema version 93", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '93')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        interviewState TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.init();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("branch_groups");

    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(taskColumns.map((column) => column.name)).toContain("autoMerge");

    const missionColumns = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    expect(missionColumns.map((column) => column.name)).toContain("autoMerge");

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("v76 backfill preserves explicit gateMode and defaults the rest to advisory (FN-4497)", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'prompt',
        phase TEXT NOT NULL DEFAULT 'pre-merge',
        prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '75')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec("INSERT INTO workflow_steps (id, name, description, mode, phase, prompt, enabled, createdAt, updatedAt) VALUES ('WS-001', 'Prompt', 'Prompt step', 'prompt', 'pre-merge', 'p', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");
    db.exec("INSERT INTO workflow_steps (id, name, description, mode, phase, prompt, enabled, createdAt, updatedAt) VALUES ('WS-002', 'Script', 'Script step', 'script', 'pre-merge', '', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");
    db.exec("INSERT INTO workflow_steps (id, name, description, mode, phase, prompt, enabled, createdAt, updatedAt) VALUES ('WS-003', 'Disabled Prompt', 'Disabled step', 'prompt', 'pre-merge', 'p', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')");

    db.init();

    const rows = db.prepare("SELECT id, mode, enabled, gateMode FROM workflow_steps ORDER BY id ASC").all() as Array<{ id: string; mode: string; enabled: number; gateMode: string }>;
    expect(rows).toEqual([
      { id: "WS-001", mode: "prompt", enabled: 1, gateMode: "advisory" },
      { id: "WS-002", mode: "script", enabled: 1, gateMode: "advisory" },
      { id: "WS-003", mode: "prompt", enabled: 0, gateMode: "advisory" },
    ]);
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds mission_goals table and index when migrating from schema version 100", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '100')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        interviewState TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.init();

    const columns = db.prepare("PRAGMA table_info(mission_goals)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["missionId", "goalId", "createdAt"]);

    const indexes = db.prepare("PRAGMA index_list(mission_goals)").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "idxMissionGoalsGoalId")).toBe(true);
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("adds workflow_run_step_instances table + tasks.customFields when migrating from schema version 107", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '107')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.init();

    // The new per-step-instance run-state table exists with its index.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workflow_run_step_instances");

    const stepInstanceColumns = db
      .prepare("PRAGMA table_info(workflow_run_step_instances)")
      .all() as Array<{ name: string }>;
    expect(stepInstanceColumns.map((column) => column.name)).toEqual([
      "taskId",
      "runId",
      "foreachNodeId",
      "stepIndex",
      "pinnedStepCount",
      "currentNodeId",
      "status",
      "baselineSha",
      "checkpointId",
      "reworkCount",
      "branchName",
      "integratedAt",
      "updatedAt",
    ]);

    const stepInstanceIndexes = db
      .prepare("PRAGMA index_list(workflow_run_step_instances)")
      .all() as Array<{ name: string }>;
    expect(
      stepInstanceIndexes.some((index) => index.name === "idx_workflow_run_step_instances_task_run"),
    ).toBe(true);

    // tasks.customFields column is added with a default-'{}' definition.
    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const customFieldsColumn = taskColumns.find((column) => column.name === "customFields");
    expect(customFieldsColumn).toBeDefined();
    expect(customFieldsColumn?.dflt_value).toBe("'{}'");

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("adds workflow_settings table when migrating from schema version 108", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '108')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.init();

    // The new per-(workflowId, projectId) setting-value table exists.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workflow_settings");

    const columns = db.prepare("PRAGMA table_info(workflow_settings)").all() as Array<{
      name: string;
      pk: number;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual(["workflowId", "projectId", "values", "updatedAt"]);
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name).sort()).toEqual(["projectId", "workflowId"]);
    const valuesColumn = columns.find((column) => column.name === "values");
    expect(valuesColumn?.dflt_value).toBe("'{}'");

    const indexes = db.prepare("PRAGMA index_list(workflow_settings)").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "idx_workflow_settings_project")).toBe(true);

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("adds cli_sessions table + indexes when migrating from schema version 108", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '108')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    db.init();

    // The new per-(workflowId, projectId) setting-value table exists.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("workflow_settings");

    const columns = db.prepare("PRAGMA table_info(workflow_settings)").all() as Array<{
      name: string;
      pk: number;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "workflowId",
      "projectId",
      "values",
      "updatedAt",
    ]);
    // Composite primary key over (workflowId, projectId).
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name).sort()).toEqual([
      "projectId",
      "workflowId",
    ]);
    // `values` defaults to an empty JSON object.
    const valuesColumn = columns.find((column) => column.name === "values");
    expect(valuesColumn?.dflt_value).toBe("'{}'");

    // The per-projectId lookup index is created alongside the table so migrated
    // DBs match the fresh schema.
    const indexes = db.prepare("PRAGMA index_list(workflow_settings)").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === "idx_workflow_settings_project")).toBe(true);

    // The durable CLI-session record table exists.
    const cliTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(cliTables.map((row) => row.name)).toContain("cli_sessions");

    const cliSessionColumns = db
      .prepare("PRAGMA table_info(cli_sessions)")
      .all() as Array<{ name: string }>;
    expect(cliSessionColumns.map((column) => column.name)).toEqual([
      "id",
      "taskId",
      "chatSessionId",
      "purpose",
      "projectId",
      "adapterId",
      "agentState",
      "terminationReason",
      "nativeSessionId",
      "resumeAttempts",
      "autonomyPosture",
      "worktreePath",
      "createdAt",
      "updatedAt",
    ]);

    const cliSessionIndexes = db
      .prepare("PRAGMA index_list(cli_sessions)")
      .all() as Array<{ name: string }>;
    const indexNames = cliSessionIndexes.map((index) => index.name);
    expect(indexNames).toContain("idx_cli_sessions_taskId");
    expect(indexNames).toContain("idx_cli_sessions_chatSessionId");
    expect(indexNames).toContain("idx_cli_sessions_project_state");

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("adds cliExecutorAdapterId to chat_sessions when migrating from schema version 109", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '109')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        projectId TEXT,
        modelProvider TEXT,
        modelId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        cliSessionFile TEXT,
        inFlightGeneration TEXT
      )
    `);

    db.init();

    const columns = db
      .prepare("PRAGMA table_info(chat_sessions)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("cliExecutorAdapterId");

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("creates cli_sessions on a fresh database (fresh-create path)", () => {
    const db = new Database(fusionDir);
    db.init();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("cli_sessions");
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("adds workflows.kind + workflow_steps.migrated_fragment_id when migrating from schema version 108", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '108')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        ir TEXT NOT NULL,
        layout TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'prompt',
        phase TEXT NOT NULL DEFAULT 'pre-merge',
        prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec(
      `INSERT INTO workflows (id, name, ir, createdAt, updatedAt) VALUES ('WF-legacy', 'Legacy', '{"version":"v1","name":"x","nodes":[],"edges":[]}', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    db.exec(
      "INSERT INTO workflow_steps (id, name, description, createdAt, updatedAt) VALUES ('WS-legacy', 'Legacy', 'desc', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
    );

    db.init();

    const workflowColumns = db.prepare("PRAGMA table_info(workflows)").all() as Array<{
      name: string;
    }>;
    expect(workflowColumns.map((c) => c.name)).toContain("kind");
    // Existing rows default to 'workflow'.
    const wfRow = db.prepare("SELECT kind FROM workflows WHERE id = 'WF-legacy'").get() as { kind: string };
    expect(wfRow.kind).toBe("workflow");

    const stepColumns = db.prepare("PRAGMA table_info(workflow_steps)").all() as Array<{ name: string }>;
    expect(stepColumns.map((c) => c.name)).toContain("migrated_fragment_id");
    const stepRow = db
      .prepare("SELECT migrated_fragment_id FROM workflow_steps WHERE id = 'WS-legacy'")
      .get() as { migrated_fragment_id: string | null };
    expect(stepRow.migrated_fragment_id).toBeNull();

    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("migration 109 is idempotent on re-init", () => {
    const db = new Database(fusionDir);
    db.init();
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();

    // Re-open the same on-disk DB: already at 109, the 109 block must be a no-op.
    const reopened = new Database(fusionDir);
    reopened.init();
    expect(reopened.getSchemaVersion()).toBe(SCHEMA_VERSION);
    const workflowColumns = reopened.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>;
    expect(workflowColumns.filter((c) => c.name === "kind")).toHaveLength(1);
    const stepColumns = reopened.prepare("PRAGMA table_info(workflow_steps)").all() as Array<{ name: string }>;
    expect(stepColumns.filter((c) => c.name === "migrated_fragment_id")).toHaveLength(1);
    reopened.close();
  });
});
