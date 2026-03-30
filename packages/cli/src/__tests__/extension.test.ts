import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import kbExtension from "../extension.js";
import { TaskStore } from "@kb/core";

// ── Mock ExtensionAPI that captures registrations ──────────────────

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, Function>();

  const api = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    on(event: string, handler: Function) {
      events.set(event, handler);
    },
    tools,
    commands,
    events,
  };

  return api as any;
}

function makeCtx(cwd: string) {
  return { cwd } as any;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("kb pi extension", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-ext-test-"));
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("registration", () => {
    it("registers all expected tools", () => {
      const expected = [
        "kb_task_create",
        "kb_task_list",
        "kb_task_show",
        "kb_task_attach",
        "kb_task_pause",
        "kb_task_unpause",
        "kb_task_duplicate",
        "kb_task_refine",
        "kb_task_import_github",
        "kb_task_import_github_issue",
        "kb_task_browse_github_issues",
        "kb_task_archive",
        "kb_task_unarchive",
      ];

      for (const name of expected) {
        expect(api.tools.has(name), `missing tool: ${name}`).toBe(true);
      }
      expect(api.tools.size).toBe(expected.length);
    });

    it("does not register engine-internal tools", () => {
      expect(api.tools.has("kb_task_move")).toBe(false);
      expect(api.tools.has("kb_task_update_step")).toBe(false);
      expect(api.tools.has("kb_task_log")).toBe(false);
      expect(api.tools.has("kb_task_merge")).toBe(false);
    });

    it("registers the /kb command", () => {
      expect(api.commands.has("kb")).toBe(true);
      expect(api.commands.get("kb")!.description).toContain("dashboard");
    });

    it("registers session_shutdown listener", () => {
      expect(api.events.has("session_shutdown")).toBe(true);
    });
  });

  describe("kb_task_create", () => {
    it("creates a task and returns its ID", async () => {
      const tool = api.tools.get("kb_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Fix the login button" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("KB-001");
      expect(result.content[0].text).toContain("Fix the login button");
      expect(result.content[0].text).toContain("triage");
      expect(result.details.taskId).toBe("KB-001");
      expect(result.details.column).toBe("triage");
    });

    it("creates a task with dependencies", async () => {
      const tool = api.tools.get("kb_task_create")!;
      await tool.execute(
        "call-1",
        { description: "First task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await tool.execute(
        "call-2",
        { description: "Second task", depends: ["KB-001"] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toBe("KB-002");
      expect(result.details.dependencies).toEqual(["KB-001"]);
      expect(result.content[0].text).toContain("Dependencies: KB-001");
    });
  });

  describe("kb_task_list", () => {
    it("returns empty message when no tasks", async () => {
      const tool = api.tools.get("kb_task_list")!;
      const result = await tool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toBe("No tasks yet.");
      expect(result.details.count).toBe(0);
    });

    it("lists tasks grouped by column", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Task A" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      await createTool.execute(
        "c2",
        { description: "Task B" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const listTool = api.tools.get("kb_task_list")!;
      const result = await listTool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Triage (2)");
      expect(result.content[0].text).toContain("KB-001");
      expect(result.content[0].text).toContain("KB-002");
      expect(result.details.count).toBe(2);
    });

    it("filters by column", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Task A" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const listTool = api.tools.get("kb_task_list")!;
      const triageResult = await listTool.execute(
        "call-1",
        { column: "triage" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(triageResult.content[0].text).toContain("Triage (1)");
      expect(triageResult.content[0].text).toContain("KB-001");

      const todoResult = await listTool.execute(
        "call-2",
        { column: "todo" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(todoResult.content[0].text).toBe("");
    });

    it("respects per-column limit", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      for (let i = 0; i < 5; i++) {
        await createTool.execute(
          `c${i}`,
          { description: `Task ${i}` },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );
      }

      const listTool = api.tools.get("kb_task_list")!;
      const result = await listTool.execute(
        "call-1",
        { limit: 2 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Triage (5)");
      expect(result.content[0].text).toContain("KB-001");
      expect(result.content[0].text).toContain("KB-002");
      expect(result.content[0].text).not.toContain("KB-003");
      expect(result.content[0].text).toContain("... and 3 more");
    });
  });

  describe("kb_task_show", () => {
    it("shows task details", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Implement caching layer" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("kb_task_show")!;
      const result = await showTool.execute(
        "call-1",
        { id: "KB-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("KB-001");
      expect(result.content[0].text).toContain("Implement caching layer");
      expect(result.content[0].text).toContain("Triage");
      expect(result.details.task).toBeDefined();
      expect(result.details.task.id).toBe("KB-001");
    });
  });

  describe("kb_task_attach", () => {
    it("attaches a file to a task", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const testFile = join(tmpDir, "test.txt");
      await writeFile(testFile, "hello world");

      const attachTool = api.tools.get("kb_task_attach")!;
      const result = await attachTool.execute(
        "call-1",
        { id: "KB-001", path: "test.txt" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Attached to KB-001");
      expect(result.content[0].text).toContain("test.txt");
      expect(result.details.attachment).toBeDefined();
      expect(result.details.attachment.originalName).toBe("test.txt");
    });

    it("rejects unsupported file types", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const testFile = join(tmpDir, "file.exe");
      await writeFile(testFile, "binary");

      const attachTool = api.tools.get("kb_task_attach")!;
      await expect(
        attachTool.execute(
          "call-1",
          { id: "KB-001", path: "file.exe" },
          undefined,
          undefined,
          makeCtx(tmpDir),
        ),
      ).rejects.toThrow("Unsupported file type");
    });
  });

  describe("kb_task_pause / unpause", () => {
    it("pauses and unpauses a task", async () => {
      const createTool = api.tools.get("kb_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const pauseTool = api.tools.get("kb_task_pause")!;
      const pauseResult = await pauseTool.execute(
        "call-1",
        { id: "KB-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(pauseResult.content[0].text).toContain("Paused KB-001");

      // Verify it's paused
      const showTool = api.tools.get("kb_task_show")!;
      const show = await showTool.execute(
        "call-2",
        { id: "KB-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.content[0].text).toContain("PAUSED");

      // Unpause
      const unpauseTool = api.tools.get("kb_task_unpause")!;
      const unpauseResult = await unpauseTool.execute(
        "call-3",
        { id: "KB-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(unpauseResult.content[0].text).toContain("Unpaused KB-001");
    });
  });
});
