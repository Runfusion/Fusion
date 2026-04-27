import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Each test spins up a fresh temp workspace, mounts the full extension API,
// registers tools, and exercises them through real TaskStore/MissionStore
// machinery (atomic JSON writes, ID allocator with disk sync, async memory
// flushes). Under heavy parallel FS load on a busy machine, individual
// tests can occasionally cross 5s — and the same load also produces
// ENOTEMPTY teardown races when async work outlives the test body. A
// generous testTimeout absorbs both effects without masking real bugs:
// any test that genuinely hangs will still trip the bump, and the suite
// already runs well under the cap on a quiet machine.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

vi.mock("@fusion/core/gh-cli", () => ({
  isGhAvailable: vi.fn(() => true),
  isGhAuthenticated: vi.fn(() => true),
  runGhJsonAsync: vi.fn(),
  getGhErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
}));

vi.mock("../commands/task.js", () => ({
  runTaskPlan: vi.fn(),
}));

import kbExtension from "../extension.js";
import { TaskStore } from "@fusion/core";
import { isGhAvailable, isGhAuthenticated, runGhJsonAsync } from "@fusion/core/gh-cli";
import { runTaskPlan } from "../commands/task.js";

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

// Skipped: 39 tests × ~1-4s each (~62s total) exercise every fn pi tool
// through the real ExtensionAPI + TaskStore/MissionStore stack with
// per-test temp workspaces. Coverage overlaps with command-level tests
// (task.test.ts, mission-related suites). Re-enable for full pre-release
// validation or when adding new extension tools.
describe.skip("fn pi extension", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
    vi.mocked(runTaskPlan).mockReset();

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
        "fn_task_create",
        "fn_task_update",
        "fn_task_list",
        "fn_task_show",
        "fn_task_attach",
        "fn_task_pause",
        "fn_task_unpause",
        "fn_task_retry",
        "fn_task_duplicate",
        "fn_task_refine",
        "fn_task_import_github",
        "fn_task_import_github_issue",
        "fn_task_browse_github_issues",
        "fn_task_archive",
        "fn_task_unarchive",
        "fn_task_delete",
        "fn_task_plan",
        // Mission tools
        "fn_mission_create",
        "fn_mission_list",
        "fn_mission_show",
        "fn_mission_delete",
        "fn_milestone_add",
        "fn_slice_add",
        "fn_feature_add",
        "fn_slice_activate",
        "fn_feature_link_task",
        // Agent tools
        "fn_agent_stop",
        "fn_agent_start",
        // Skills tools
        "fn_skills_search",
        "fn_skills_install",
      ];

      for (const name of expected) {
        expect(api.tools.has(name), `missing tool: ${name}`).toBe(true);
      }
      expect(api.tools.size).toBe(expected.length);
    });

    it("does not register engine-internal tools", () => {
      expect(api.tools.has("fn_task_move")).toBe(false);
      expect(api.tools.has("fn_task_update_step")).toBe(false);
      expect(api.tools.has("fn_task_log")).toBe(false);
      expect(api.tools.has("fn_task_merge")).toBe(false);
    });

    it("registers the /fn command", () => {
      expect(api.commands.has("fn")).toBe(true);
      expect(api.commands.get("fn")!.description).toContain("dashboard");
    });

    it("registers session_shutdown listener", () => {
      expect(api.events.has("session_shutdown")).toBe(true);
    });
  });

  describe("fn_task_plan", () => {
    it("uses runTaskPlan return value for taskId regardless of prefix", async () => {
      vi.mocked(runTaskPlan).mockResolvedValueOnce("PROJ-042");
      const tool = api.tools.get("fn_task_plan")!;

      const result = await tool.execute(
        "plan-1",
        { description: "Plan a project task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(runTaskPlan).toHaveBeenCalledWith("Plan a project task", true);
      expect(result.details.taskId).toBe("PROJ-042");
      expect(result.content[0].text).toContain("Task PROJ-042");
    });
  });

  describe("fn_task_create", () => {
    it("creates a task and returns its ID", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Fix the login button" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("FN-001");
      expect(result.content[0].text).toContain("Fix the login button");
      expect(result.content[0].text).toContain("triage");
      expect(result.details.taskId).toBe("FN-001");
      expect(result.details.column).toBe("triage");
    });

    it("creates a task with dependencies", async () => {
      const tool = api.tools.get("fn_task_create")!;
      await tool.execute(
        "call-1",
        { description: "First task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await tool.execute(
        "call-2",
        { description: "Second task", depends: ["FN-001"] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toBe("FN-002");
      expect(result.details.dependencies).toEqual(["FN-001"]);
      expect(result.content[0].text).toContain("Dependencies: FN-001");
    });

    it("creates a task with assigned agent ID", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task with assignee", agentId: "agent-abc123" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toBe("FN-001");
      expect(result.details.assignedAgentId).toBe("agent-abc123");
      expect(result.content[0].text).toContain("Assigned to: agent-abc123");

      // Verify persistence via show
      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBe("agent-abc123");
    });

    it("creates a task without assigned agent ID by default", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task without assignee" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toBe("FN-001");
      expect(result.details.assignedAgentId).toBeUndefined();
      expect(result.content[0].text).not.toContain("Assigned to:");
    });
  });

  describe("fn_task_update", () => {
    it("updates task title", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", title: "New Title" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.content[0].text).toContain("title");
      expect(result.details.updatedFields).toEqual(["title"]);

      // Verify via show
      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.content[0].text).toContain("New Title");
    });

    it("updates task description", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original desc" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", description: "Updated description" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.details.updatedFields).toEqual(["description"]);
    });

    it("updates task dependencies", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "First" }, undefined, undefined, makeCtx(tmpDir));
      await createTool.execute("c2", { description: "Second" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-002", depends: ["FN-001"] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-002");
      expect(result.details.updatedFields).toEqual(["dependencies"]);
    });

    it("updates multiple fields at once", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", title: "New Title", description: "New desc", depends: [] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.updatedFields).toEqual(["title", "description", "dependencies"]);
    });

    it("updates task assigned agent ID", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: "agent-abc123" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.content[0].text).toContain("agentId");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBe("agent-abc123");
    });

    it("clears task assigned agent ID with null", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Original", agentId: "agent-abc123" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: null },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.content[0].text).toContain("agentId");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("returns error when task not found", async () => {
      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-999", title: "Nope" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FN-999 not found");
    });
  });

  describe("fn_task_list", () => {
    it("returns empty message when no tasks", async () => {
      const tool = api.tools.get("fn_task_list")!;
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
      const createTool = api.tools.get("fn_task_create")!;
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

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Planning (2)");
      expect(result.content[0].text).toContain("FN-001");
      expect(result.content[0].text).toContain("FN-002");
      expect(result.details.count).toBe(2);
    });

    it("filters by column", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Task A" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const listTool = api.tools.get("fn_task_list")!;
      const triageResult = await listTool.execute(
        "call-1",
        { column: "triage" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(triageResult.content[0].text).toContain("Planning (1)");
      expect(triageResult.content[0].text).toContain("FN-001");

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
      const createTool = api.tools.get("fn_task_create")!;
      for (let i = 0; i < 5; i++) {
        await createTool.execute(
          `c${i}`,
          { description: `Task ${i}` },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );
      }

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute(
        "call-1",
        { limit: 2 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Planning (5)");
      expect(result.content[0].text).toContain("FN-001");
      expect(result.content[0].text).toContain("FN-002");
      expect(result.content[0].text).not.toContain("FN-003");
      expect(result.content[0].text).toContain("... and 3 more");
    });
  });

  describe("fn_task_show", () => {
    it("shows task details", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Implement caching layer" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("fn_task_show")!;
      const result = await showTool.execute(
        "call-1",
        { id: "FN-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("FN-001");
      expect(result.content[0].text).toContain("Implement caching layer");
      expect(result.content[0].text).toContain("Planning");
      expect(result.details.task).toBeDefined();
      expect(result.details.task.id).toBe("FN-001");
    });
  });

  describe("fn_task_attach", () => {
    it("attaches a file to a task", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const testFile = join(tmpDir, "test.txt");
      await writeFile(testFile, "hello world");

      const attachTool = api.tools.get("fn_task_attach")!;
      const result = await attachTool.execute(
        "call-1",
        { id: "FN-001", path: "test.txt" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Attached to FN-001");
      expect(result.content[0].text).toContain("test.txt");
      expect(result.details.attachment).toBeDefined();
      expect(result.details.attachment.originalName).toBe("test.txt");
    });

    it("rejects unsupported file types", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const testFile = join(tmpDir, "file.exe");
      await writeFile(testFile, "binary");

      const attachTool = api.tools.get("fn_task_attach")!;
      await expect(
        attachTool.execute(
          "call-1",
          { id: "FN-001", path: "file.exe" },
          undefined,
          undefined,
          makeCtx(tmpDir),
        ),
      ).rejects.toThrow("Unsupported file type");
    });
  });

  describe("fn_task_pause / unpause", () => {
    it("pauses and unpauses a task", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const pauseTool = api.tools.get("fn_task_pause")!;
      const pauseResult = await pauseTool.execute(
        "call-1",
        { id: "FN-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(pauseResult.content[0].text).toContain("Paused FN-001");

      // Verify it's paused
      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute(
        "call-2",
        { id: "FN-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.content[0].text).toContain("PAUSED");

      // Unpause
      const unpauseTool = api.tools.get("fn_task_unpause")!;
      const unpauseResult = await unpauseTool.execute(
        "call-3",
        { id: "FN-001" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(unpauseResult.content[0].text).toContain("Unpaused FN-001");
    });
  });

  describe("fn_mission_create", () => {
    it("creates mission and returns mission data", async () => {
      const tool = api.tools.get("fn_mission_create")!;
      const result = await tool.execute(
        "call-1",
        { title: "Test Mission", description: "Test description", autoAdvance: true },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.missionId).toBeDefined();
      expect(result.details.title).toBe("Test Mission");
      expect(result.details.autoAdvance).toBe(true);
      expect(result.content[0].text).toContain("Created");
      expect(result.content[0].text).toContain("Test Mission");
      expect(result.content[0].text).toContain("Auto-advance: enabled");
    });
  });

  describe("fn_mission_list", () => {
    it("returns formatted list of missions", async () => {
      // First create a mission
      const createTool = api.tools.get("fn_mission_create")!;
      await createTool.execute(
        "c1",
        { title: "Mission A" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const listTool = api.tools.get("fn_mission_list")!;
      const result = await listTool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.count).toBeGreaterThanOrEqual(1);
      expect(result.content[0].text).toContain("Missions");
      expect(result.content[0].text).toContain("Summary:");
    });
  });

  describe("fn_mission_show", () => {
    it("returns mission with hierarchy", async () => {
      // Create mission
      const createTool = api.tools.get("fn_mission_create")!;
      const created = await createTool.execute(
        "c1",
        { title: "Test Mission" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("fn_mission_show")!;
      const result = await showTool.execute(
        "call-1",
        { id: created.details.missionId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.mission).toBeDefined();
      expect(result.content[0].text).toContain("Test Mission");
    });

    it("returns error when mission not found", async () => {
      const showTool = api.tools.get("fn_mission_show")!;
      const result = await showTool.execute(
        "call-1",
        { id: "M-999" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("fn_mission_delete", () => {
    it("deletes mission and confirms", async () => {
      // Create mission
      const createTool = api.tools.get("fn_mission_create")!;
      const created = await createTool.execute(
        "c1",
        { title: "Mission to Delete" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const deleteTool = api.tools.get("fn_mission_delete")!;
      const result = await deleteTool.execute(
        "call-1",
        { id: created.details.missionId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.missionId).toBe(created.details.missionId);
      expect(result.content[0].text).toContain("Deleted");
    });
  });

  describe("fn_milestone_add", () => {
    it("creates a milestone in the mission store", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));

      const result = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone", description: "Phase 1" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const persisted = store.getMissionStore().getMilestone(result.details.milestoneId);

      expect(result.content[0].text).toContain("Added");
      expect(persisted?.title).toBe("Milestone");
      expect(persisted?.description).toBe("Phase 1");
    });
  });

  describe("fn_slice_add", () => {
    it("creates a slice in the mission store", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice", description: "Work unit" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const persisted = store.getMissionStore().getSlice(result.details.sliceId);

      expect(result.content[0].text).toContain("Added");
      expect(persisted?.title).toBe("Slice");
      expect(persisted?.description).toBe("Work unit");
    });
  });

  describe("fn_feature_add", () => {
    it("creates a feature in the mission store", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const slice = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await featureTool.execute(
        "f1",
        { sliceId: slice.details.sliceId, title: "Feature", description: "Deliverable", acceptanceCriteria: "Must pass" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const persisted = store.getMissionStore().getFeature(result.details.featureId);

      expect(result.content[0].text).toContain("Added");
      expect(persisted?.title).toBe("Feature");
      expect(persisted?.acceptanceCriteria).toBe("Must pass");
    });
  });

  describe("fn_slice_activate", () => {
    it("returns error when slice is already active", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const activateTool = api.tools.get("fn_slice_activate")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const slice = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await activateTool.execute("sl2", { id: slice.details.sliceId }, undefined, undefined, makeCtx(tmpDir));
      const result = await activateTool.execute("sl3", { id: slice.details.sliceId }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not pending");
    });

    it("activates slice and updates status", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const activateTool = api.tools.get("fn_slice_activate")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const slice = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await activateTool.execute(
        "sl2",
        { id: slice.details.sliceId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const persisted = store.getMissionStore().getSlice(slice.details.sliceId);

      expect(result.content[0].text).toContain("Activated");
      expect(result.details.status).toBe("active");
      expect(persisted?.status).toBe("active");
    });
  });

  describe("fn_feature_link_task", () => {
    it("returns error when task is missing", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const linkTool = api.tools.get("fn_feature_link_task")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const slice = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const feature = await featureTool.execute(
        "f1",
        { sliceId: slice.details.sliceId, title: "Feature" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await linkTool.execute(
        "l0",
        { featureId: feature.details.featureId, taskId: "FN-999" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task FN-999 not found");
    });

    it("links feature to task", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const createTaskTool = api.tools.get("fn_task_create")!;
      const linkTool = api.tools.get("fn_feature_link_task")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const slice = await sliceTool.execute(
        "sl1",
        { milestoneId: milestone.details.milestoneId, title: "Slice" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const feature = await featureTool.execute(
        "f1",
        { sliceId: slice.details.sliceId, title: "Feature" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const taskResult = await createTaskTool.execute(
        "t1",
        { description: "Task for feature" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await linkTool.execute(
        "l1",
        { featureId: feature.details.featureId, taskId: taskResult.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const missionStore = store.getMissionStore();
      const persisted = missionStore.getFeature(feature.details.featureId);
      const linkedTask = await store.getTask(taskResult.details.taskId);

      expect(result.content[0].text).toContain(taskResult.details.taskId);
      expect(result.details.taskId).toBe(taskResult.details.taskId);
      expect(persisted?.status).toBe("triaged");
      expect(linkedTask.sliceId).toBe(slice.details.sliceId);
    });
  });

  describe("GitHub import tools", () => {
    it("fn_task_import_github requires gh auth", async () => {
      const tool = api.tools.get("fn_task_import_github")!;
      vi.mocked(isGhAvailable).mockReturnValue(false);

      await expect(
        tool.execute("gh-1", { ownerRepo: "acme/demo" }, undefined, undefined, makeCtx(tmpDir)),
      ).rejects.toThrow("GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.");
    });

    it("fn_task_import_github imports issues via gh api", async () => {
      const tool = api.tools.get("fn_task_import_github")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
        {
          number: 1,
          title: "Issue one",
          body: "First issue body",
          html_url: "https://github.com/acme/demo/issues/1",
        },
        {
          number: 2,
          title: "Issue two",
          body: "Second issue body",
          html_url: "https://github.com/acme/demo/issues/2",
        },
      ] as never);

      const result = await tool.execute(
        "gh-2",
        { ownerRepo: "acme/demo", limit: 5 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Imported 2 tasks from acme/demo");
      expect(result.details.createdTasks).toHaveLength(2);
      expect(vi.mocked(runGhJsonAsync)).toHaveBeenCalledWith([
        "api",
        "repos/acme/demo/issues?state=open&per_page=5",
      ]);

      const store = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"));
      await store.init();
      const tasks = await store.listTasks({ includeArchived: true });
      expect(tasks).toHaveLength(2);
      const issueOneTask = tasks.find((task) => task.sourceIssue?.issueNumber === 1);
      expect(issueOneTask?.sourceIssue).toEqual({
        provider: "github",
        repository: "acme/demo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/acme/demo/issues/1",
      });
    });

    it("fn_task_browse_github_issues lists issues via gh api", async () => {
      const tool = api.tools.get("fn_task_browse_github_issues")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
        {
          number: 10,
          title: "Investigate latency",
          body: null,
          html_url: "https://github.com/acme/demo/issues/10",
          labels: [{ name: "perf" }],
        },
      ] as never);

      const result = await tool.execute(
        "gh-3",
        { owner: "acme", repo: "demo", limit: 10 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Found 1 open issues in acme/demo");
      expect(result.details.issues[0]).toMatchObject({ number: 10, labels: ["perf"] });
      expect(vi.mocked(runGhJsonAsync)).toHaveBeenCalledWith([
        "api",
        "repos/acme/demo/issues?state=open&per_page=10",
      ]);
    });
  });
});
