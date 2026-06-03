import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

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
import { TaskStore, AgentStore, MANUAL_RETRY_RESET_COUNTER_KEYS, RESEARCH_RUN_STATUSES } from "@fusion/core";
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

async function seedAgent(
  cwd: string,
  overrides: { ephemeral?: boolean; name?: string } = {},
): Promise<string> {
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion") });
  await agentStore.init();
  const agent = await agentStore.createAgent({
    name: overrides.name ?? "test-agent",
    role: "executor",
    metadata: overrides.ephemeral ? { agentKind: "task-worker" } : {},
  });
  return agent.id;
}

async function removeDirWithRetries(path: string) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }

      if (attempt === maxAttempts) {
        throw error;
      }

      await delay(25 * attempt);
    }
  }
}

async function enableResearch(cwd: string): Promise<TaskStore> {
  const store = new TaskStore(cwd);
  await store.init();
  await store.updateGlobalSettings({
    researchGlobalEnabled: true,
    researchGlobalDefaults: { searchProvider: "searxng" },
    researchGlobalSearxngUrl: "http://localhost:8888",
    experimentalFeatures: { researchView: true } as Record<string, boolean>,
  });
  await store.updateSettings({
    researchEnabled: true,
    researchSettings: { enabled: true, searchProvider: "searxng" },
    researchGlobalWebSearchProvider: "searxng",
    researchGlobalSearxngUrl: "http://localhost:8888",
  });
  return store;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("fn pi extension tool copy guardrails", () => {
  it("describes fn_task_delete as soft delete and avoids irrecoverability claims (FN-5141)", () => {
    const api = createMockAPI();
    kbExtension(api);

    const tool = api.tools.get("fn_task_delete") as
      | { description?: string; promptGuidelines?: string[] }
      | undefined;

    expect(tool).toBeDefined();
    expect(tool?.description ?? "").not.toMatch(/permanent|cannot be recovered|cannot be undone|deleted immediately/i);
    expect(tool?.description ?? "").toMatch(/soft.?delete/i);

    const guidelines = (tool?.promptGuidelines ?? []).join(" ");
    expect(guidelines).toMatch(/soft.?delete/i);
    expect(guidelines).not.toMatch(/permanent|cannot be recovered|cannot be undone|deleted immediately|irrecoverable/i);
  });
});

// Audited in FN-3189: this exhaustive suite is expensive (~62s) and stale
// against modern extension behavior/tooling (see FN-3204). The maintained
// release lane lives in extension-integration.test.ts and uses
// FUSION_TEST_EXTENSION_INTEGRATION. Keep this under a separate legacy gate for
// historical debugging only.
const SHOULD_RUN_LEGACY_EXTENSION_INTEGRATION =
  process.env.FUSION_TEST_LEGACY_EXTENSION_INTEGRATION === "1" ||
  process.env.FUSION_TEST_LEGACY_EXTENSION_INTEGRATION === "true";

describe.skipIf(!SHOULD_RUN_LEGACY_EXTENSION_INTEGRATION)("fn pi extension (legacy exhaustive suite)", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
    vi.mocked(runTaskPlan).mockReset();

    tmpDir = await mkdtemp(join(tmpdir(), "kb-ext-test-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await removeDirWithRetries(tmpDir);
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
        "fn_research_run",
        "fn_research_list",
        "fn_research_get",
        "fn_research_cancel",
        "fn_insight_list",
        "fn_insight_show",
        "fn_insight_run_list",
        "fn_insight_run_show",
        "fn_mission_create",
        "fn_mission_list",
        "fn_mission_show",
        "fn_mission_backfill_assertions",
        "fn_mission_delete",
        "fn_mission_update",
        "fn_milestone_add",
        "fn_slice_add",
        "fn_feature_add",
        "fn_feature_delete",
        "fn_slice_delete",
        "fn_milestone_delete",
        "fn_slice_activate",
        "fn_feature_link_task",
        "fn_feature_update",
        "fn_milestone_update",
        "fn_agent_stop",
        "fn_agent_start",
        "fn_agent_create",
        "fn_agent_delete",
        "fn_list_agents",
        "fn_delegate_task",
        "fn_agent_show",
        "fn_agent_org_chart",
        "fn_skills_search",
        "fn_skills_install",
      ] as const;

      expect(Array.from(api.tools.keys()).sort()).toEqual([...expected].sort());
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

      expect(runTaskPlan).toHaveBeenCalledWith("Plan a project task", true, undefined, undefined);
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

      expect(result.details.taskId).toMatch(/^[A-Z]+-\d+$/);
      expect(result.content[0].text).toContain(result.details.taskId);
      expect(result.content[0].text).toContain("Fix the login button");
      expect(result.content[0].text).toContain("triage");
      expect(result.details.column).toBe("triage");
      expect(result.details.priority).toBe("normal");
    });

    it("creates a task with explicit priority", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-priority",
        { description: "Urgent task", priority: "urgent" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.priority).toBe("urgent");
      expect(result.content[0].text).toContain("Priority: urgent");

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s-priority", { id: result.details.taskId }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.priority).toBe("urgent");
    });

    it("creates a task with dependencies", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const first = await tool.execute(
        "call-1",
        { description: "First task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await tool.execute(
        "call-2",
        { description: "Second task", depends: [first.details.taskId] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toMatch(/^[A-Z]+-\d+$/);
      expect(result.details.dependencies).toEqual([first.details.taskId]);
      expect(result.content[0].text).toContain(`Dependencies: ${first.details.taskId}`);
    });

    it("creates a task with assigned agent ID", async () => {
      const agentId = await seedAgent(tmpDir);
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task with assignee", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.taskId).toBe("FN-001");
      expect(result.details.assignedAgentId).toBe(agentId);
      expect(result.content[0].text).toContain(`Assigned to: ${agentId}`);

      // Verify persistence via show
      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBe(agentId);
    });

    it("rejects unknown agent IDs", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task with bogus assignee", agentId: "agent-does-not-exist" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Agent agent-does-not-exist not found");
    });

    it("rejects ephemeral/runtime-managed agents", async () => {
      const ephemeralId = await seedAgent(tmpDir, { ephemeral: true, name: "task-worker" });
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task with worker assignee", agentId: ephemeralId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ephemeral/runtime agent");
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

      expect(result.details.taskId).toMatch(/^[A-Z]+-\d+$/);
      expect(result.details.assignedAgentId).toBeUndefined();
      expect(result.content[0].text).not.toContain("Assigned to:");
    });

    it("FN-3799: treats empty-string agentId as unassigned on create", async () => {
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-1",
        { description: "Task without assignee", agentId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.assignedAgentId).toBeUndefined();
      expect(result.content[0].text).not.toContain("Agent  not found");
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

    it("updates task priority", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", priority: "urgent" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.details.updatedFields).toEqual(["priority"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.priority).toBe("urgent");
    });

    it("updates priority combined with other fields", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", title: "Retitled", priority: "high" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.updatedFields).toEqual(["title", "priority"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.title).toBe("Retitled");
      expect(show.details.task.priority).toBe("high");
    });

    it("rejects invalid priority value", () => {
      const updateTool = api.tools.get("fn_task_update") as any;
      const prioritySchema = updateTool.parameters.properties.priority;
      const literalValues = prioritySchema.anyOf.map((entry: { const: string }) => entry.const);
      expect(literalValues).toEqual(["low", "normal", "high", "urgent"]);
      expect(literalValues).not.toContain("critical");
    });

    it("updates task assigned agent ID", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const agentId = await seedAgent(tmpDir);
      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: created.details.taskId, agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain(`Updated ${created.details.taskId}`);
      expect(result.content[0].text).toContain("agentId");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: created.details.taskId }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBe(agentId);
    });

    it("FN-3799: clears task assigned agent ID with empty string", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("clears task assigned agent ID with whitespace", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: "   " },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("clears task assigned agent ID with literal null string", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: "null" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated FN-001");
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("clears node override with empty string", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const setNode = await updateTool.execute(
        "u1",
        { id: "FN-001", nodeId: "node-123" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(setNode.isError).not.toBe(true);

      const clearNode = await updateTool.execute(
        "u2",
        { id: "FN-001", nodeId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(clearNode.content[0].text).toContain("Updated FN-001");
      expect(clearNode.details.updatedFields).toEqual(["nodeId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("s1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.nodeId).toBeNull();
    });

    it("rejects unknown agent IDs on update", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", agentId: "agent-does-not-exist" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Agent agent-does-not-exist not found");
    });

    it("clears task assigned agent ID with null", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "Original", agentId },
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

    it("includes concise provenance in list rows", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      await store.createTask({
        description: "Created by dashboard",
        source: { sourceType: "dashboard_ui" },
      });
      await store.createTask({
        description: "Created by agent",
        source: {
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-123",
          sourceMetadata: { agentName: "Reviewer Bot" },
        },
      });

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute("call-2", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("FN-001  Created by dashboard [via: Dashboard]");
      expect(result.content[0].text).toContain("FN-002  Created by agent [via: Agent (Reviewer Bot)]");
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
      await createTool.execute("c1", { description: "Implement caching layer" }, undefined, undefined, makeCtx(tmpDir));

      const showTool = api.tools.get("fn_task_show")!;
      const result = await showTool.execute("call-1", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("FN-001");
      expect(result.content[0].text).toContain("Implement caching layer");
      expect(result.content[0].text).toContain("Planning");
      expect(result.content[0].text).toContain("Created via: API");
      expect(result.details.task).toBeDefined();
      expect(result.details.task.id).toBe("FN-001");
    });

    it("shows agent and dashboard provenance", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      await store.createTask({
        description: "Agent created",
        source: {
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-999",
          sourceMetadata: { agentName: "Scout" },
        },
      });
      await store.createTask({ description: "UI created", source: { sourceType: "dashboard_ui" } });

      const showTool = api.tools.get("fn_task_show")!;
      const agentResult = await showTool.execute("call-2", { id: "FN-001" }, undefined, undefined, makeCtx(tmpDir));
      const dashboardResult = await showTool.execute("call-3", { id: "FN-002" }, undefined, undefined, makeCtx(tmpDir));

      expect(agentResult.content[0].text).toContain("Created via: Agent (Scout)");
      expect(dashboardResult.content[0].text).toContain("Created via: Dashboard");
    });

    it("shows duplicate lineage with archived annotation", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const archivedSource = await store.createTask({ description: "Archived source" });
      await store.moveTask(archivedSource.id, "done");
      await store.archiveTask(archivedSource.id);
      await store.createTask({
        description: "Dup task",
        source: { sourceType: "chat_session", sourceMetadata: { duplicateOfTaskIds: [archivedSource.id, "FN-404"] } },
      });

      const showTool = api.tools.get("fn_task_show")!;
      const result = await showTool.execute("call-4", { id: "FN-002" }, undefined, undefined, makeCtx(tmpDir));
      expect(result.content[0].text).toContain(`Duplicate of: ${archivedSource.id} (archived), FN-404`);
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
        { title: "Test Mission", description: "Test description", autoAdvance: true, baseBranch: "develop" },
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

      const store = new TaskStore(tmpDir);
      await store.init();
      const mission = store.getMissionStore().getMission(result.details.missionId);
      expect(mission?.baseBranch).toBe("develop");
    });
  });

  describe("fn_mission_list", () => {
    it("returns formatted list of missions", async () => {
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

    it("includes mission interview drafts by default and exposes them in details", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();
      store.getDatabase().prepare(
        `INSERT INTO ai_sessions (id, type, status, title, inputPayload, conversationHistory, currentQuestion, result, thinkingOutput, error, projectId, createdAt, updatedAt, lockedByTab, lockedAt)
         VALUES (?, 'mission_interview', 'awaiting_input', ?, '{}', '[]', NULL, NULL, '', NULL, NULL, ?, ?, NULL, NULL)`,
      ).run("draft-1", "Draft Mission", "2026-05-12T00:00:00.000Z", "2026-05-12T00:00:00.000Z");
      store.getDatabase().prepare(
        `INSERT INTO ai_sessions (id, type, status, title, inputPayload, conversationHistory, currentQuestion, result, thinkingOutput, error, projectId, createdAt, updatedAt, lockedByTab, lockedAt)
         VALUES (?, 'mission_interview', 'complete', ?, '{}', '[]', NULL, '{}', '', NULL, NULL, ?, ?, NULL, NULL)`,
      ).run("draft-2", "Ready Mission", "2026-05-12T00:01:00.000Z", "2026-05-12T00:01:00.000Z");

      const listTool = api.tools.get("fn_mission_list")!;
      const result = await listTool.execute("call-1", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("Drafts (2)");
      expect(result.content[0].text).toContain("draft-1: Draft Mission (draft · interview awaiting_input)");
      expect(result.content[0].text).toContain("draft-2: Ready Mission (draft · interview plan ready)");
      expect(result.details.drafts).toEqual([
        {
          id: "draft-2",
          title: "Ready Mission",
          status: "complete",
          updatedAt: "2026-05-12T00:01:00.000Z",
        },
        {
          id: "draft-1",
          title: "Draft Mission",
          status: "awaiting_input",
          updatedAt: "2026-05-12T00:00:00.000Z",
        },
      ]);
    });

    it("suppresses mission interview drafts when includeDrafts is false", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();
      store.getDatabase().prepare(
        `INSERT INTO ai_sessions (id, type, status, title, inputPayload, conversationHistory, currentQuestion, result, thinkingOutput, error, projectId, createdAt, updatedAt, lockedByTab, lockedAt)
         VALUES (?, 'mission_interview', 'error', ?, '{}', '[]', NULL, NULL, '', NULL, NULL, ?, ?, NULL, NULL)`,
      ).run("draft-2", "Hidden Draft", "2026-05-12T00:00:00.000Z", "2026-05-12T00:00:00.000Z");

      const listTool = api.tools.get("fn_mission_list")!;
      const result = await listTool.execute("call-1", { includeDrafts: false }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).not.toContain("Drafts");
      expect(result.details.drafts).toEqual([]);
    });
  });

  describe("fn_mission_show", () => {
    it("returns mission with hierarchy and linked goals", async () => {
      const createTool = api.tools.get("fn_mission_create")!;
      const goalTool = api.tools.get("fn_goal_create")!;
      const linkTool = api.tools.get("fn_mission_link_goal")!;
      const created = await createTool.execute(
        "c1",
        { title: "Test Mission" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const goal = await goalTool.execute(
        "g1",
        { title: "Connect mission work to goals" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      await linkTool.execute(
        "link-1",
        { missionId: created.details.missionId, goalId: goal.details.goalId },
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
      expect(result.content[0].text).toContain("Linked Goals:");
      expect(result.content[0].text).toContain(`- ${goal.details.goalId}: Connect mission work to goals`);
      expect(result.details.mission.linkedGoals).toEqual([
        expect.objectContaining({ id: goal.details.goalId, title: "Connect mission work to goals" }),
      ]);
    });

    it("renders acceptanceCriteria / verification for milestones, slices, and features", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));

      const store = new TaskStore(tmpDir);
      await store.init();
      const missionStore = store.getMissionStore();
      const milestone = missionStore.addMilestone(mission.details.missionId, {
        title: "Milestone",
        acceptanceCriteria: "MILESTONE_AC_MARKER",
      });
      const slice = missionStore.addSlice(milestone.id, {
        title: "Slice",
        verification: "SLICE_VERIFY_MARKER",
      });
      await featureTool.execute(
        "f1",
        {
          sliceId: slice.id,
          title: "Feature",
          acceptanceCriteria: "FEATURE_AC_MARKER",
        },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("fn_mission_show")!;
      const result = await showTool.execute("call-1", { id: mission.details.missionId }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("    AC: MILESTONE_AC_MARKER");
      expect(result.content[0].text).toContain("      Verification: SLICE_VERIFY_MARKER");
      expect(result.content[0].text).toContain("        AC: FEATURE_AC_MARKER");
    });

    it("truncates long acceptanceCriteria text while keeping full details.mission values", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));

      const longValue = "LONG_AC_".repeat(40);
      const store = new TaskStore(tmpDir);
      await store.init();
      const missionStore = store.getMissionStore();
      missionStore.addMilestone(mission.details.missionId, {
        title: "Milestone",
        acceptanceCriteria: longValue,
      });

      const showTool = api.tools.get("fn_mission_show")!;
      const result = await showTool.execute("call-1", { id: mission.details.missionId }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("… (truncated,");
      expect(result.details.mission.milestones[0].acceptanceCriteria).toBe(longValue);
    });

    it("renders an empty linked goals state when no goals are linked", async () => {
      const createTool = api.tools.get("fn_mission_create")!;
      const created = await createTool.execute(
        "c1",
        { title: "Mission Without Goals" },
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

      expect(result.content[0].text).toContain("Linked Goals:");
      expect(result.content[0].text).toContain("No linked goals.");
      expect(result.details.mission.linkedGoals).toEqual([]);
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

  describe("fn_mission_backfill_assertions", () => {
    it("supports dry-run and apply execution", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const backfillTool = api.tools.get("fn_mission_backfill_assertions")!;
      const mission = await missionTool.execute("m1", { title: "Backfill Mission" }, undefined, undefined, makeCtx(tmpDir));

      const store = new TaskStore(tmpDir);
      await store.init();
      const missionStore = store.getMissionStore();
      const milestone = missionStore.addMilestone(mission.details.missionId, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const feature = missionStore.addFeature(slice.id, {
        title: "Feature needing assertion",
        acceptanceCriteria: "must be true",
      });
      expect(missionStore.listAssertionsForFeature(feature.id)).toHaveLength(0);

      const dryRun = await backfillTool.execute(
        "bf-1",
        { missionId: mission.details.missionId, dryRun: true },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(dryRun.details.repaired.length).toBe(1);
      expect(missionStore.listAssertionsForFeature(feature.id)).toHaveLength(0);

      const apply = await backfillTool.execute(
        "bf-2",
        { missionId: mission.details.missionId, dryRun: false },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(apply.details.repaired.length).toBe(1);
      expect(missionStore.listAssertionsForFeature(feature.id)).toHaveLength(1);
      expect(apply.content[0].text).toContain("Backfill apply complete");
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

      const store = new TaskStore(tmpDir);
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

      const store = new TaskStore(tmpDir);
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

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getFeature(result.details.featureId);

      expect(result.content[0].text).toContain("Added");
      expect(persisted?.title).toBe("Feature");
      expect(persisted?.acceptanceCriteria).toBe("Must pass");
    });
  });

  describe("fn_feature_delete", () => {
    it("deletes feature, guards linked task, and handles missing feature", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const createTaskTool = api.tools.get("fn_task_create")!;
      const linkTool = api.tools.get("fn_feature_link_task")!;
      const deleteTool = api.tools.get("fn_feature_delete")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute("ms1", { missionId: mission.details.missionId, title: "Milestone" }, undefined, undefined, makeCtx(tmpDir));
      const slice = await sliceTool.execute("sl1", { milestoneId: milestone.details.milestoneId, title: "Slice" }, undefined, undefined, makeCtx(tmpDir));
      const feature = await featureTool.execute("f1", { sliceId: slice.details.sliceId, title: "Feature" }, undefined, undefined, makeCtx(tmpDir));
      const task = await createTaskTool.execute("t1", { description: "Task for feature" }, undefined, undefined, makeCtx(tmpDir));
      await linkTool.execute("l1", { featureId: feature.details.featureId, taskId: task.details.taskId }, undefined, undefined, makeCtx(tmpDir));

      const guarded = await deleteTool.execute("d1", { featureId: feature.details.featureId }, undefined, undefined, makeCtx(tmpDir));
      expect(guarded.isError).toBe(true);
      expect(guarded.content[0].text).toContain("linked to task");

      const forced = await deleteTool.execute("d2", { featureId: feature.details.featureId, force: true }, undefined, undefined, makeCtx(tmpDir));
      expect(forced.isError).not.toBe(true);
      expect(forced.content[0].text).toContain("Deleted");

      const missing = await deleteTool.execute("d3", { featureId: feature.details.featureId }, undefined, undefined, makeCtx(tmpDir));
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("not found");
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

      const store = new TaskStore(tmpDir);
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

    it("returns clear error when task is archived/non-active", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const linkTool = api.tools.get("fn_feature_link_task")!;

      const store = new TaskStore(tmpDir);
      await store.init();
      const archivedTask = await store.createTask({ description: "Archived task" });
      await store.moveTask(archivedTask.id, "done");
      await store.archiveTask(archivedTask.id);

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
        "l0b",
        { featureId: feature.details.featureId, taskId: archivedTask.id },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("task is not on the active board");
      expect(result.content[0].text).toContain(`Cannot link feature ${feature.details.featureId} to task ${archivedTask.id}`);
      expect(result.details.error).toContain("Only active tasks can be linked to features");
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

      const store = new TaskStore(tmpDir);
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

  describe("fn_feature_update", () => {
    it("patches title, description, and acceptanceCriteria", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const updateTool = api.tools.get("fn_feature_update")!;

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
        { sliceId: slice.details.sliceId, title: "Feature", description: "Original", acceptanceCriteria: "AC old" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await updateTool.execute(
        "fu1",
        {
          id: feature.details.featureId,
          title: "Updated Feature",
          description: "Updated description",
          acceptanceCriteria: "AC new",
        },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getFeature(feature.details.featureId);

      expect(result.content[0].text).toContain("Updated");
      expect(persisted?.title).toBe("Updated Feature");
      expect(persisted?.description).toBe("Updated description");
      expect(persisted?.acceptanceCriteria).toBe("AC new");
    });

    it("partial patch preserves untouched fields", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const updateTool = api.tools.get("fn_feature_update")!;

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
        { sliceId: slice.details.sliceId, title: "Feature", description: "Original", acceptanceCriteria: "AC old" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await updateTool.execute(
        "fu2",
        { id: feature.details.featureId, acceptanceCriteria: "AC patched" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getFeature(feature.details.featureId);

      expect(persisted?.title).toBe("Feature");
      expect(persisted?.description).toBe("Original");
      expect(persisted?.acceptanceCriteria).toBe("AC patched");
    });

    it("preserves slice ordering", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const updateTool = api.tools.get("fn_feature_update")!;

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

      const first = await featureTool.execute(
        "f1",
        { sliceId: slice.details.sliceId, title: "F1" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const second = await featureTool.execute(
        "f2",
        { sliceId: slice.details.sliceId, title: "F2" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const third = await featureTool.execute(
        "f3",
        { sliceId: slice.details.sliceId, title: "F3" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await updateTool.execute(
        "fu3",
        { id: second.details.featureId, title: "F2 Updated" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const features = store.getMissionStore().listFeatures(slice.details.sliceId);

      expect(features.map((featureItem) => featureItem.id)).toEqual([
        first.details.featureId,
        second.details.featureId,
        third.details.featureId,
      ]);
    });

    it("preserves linked task association", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const createTaskTool = api.tools.get("fn_task_create")!;
      const linkTool = api.tools.get("fn_feature_link_task")!;
      const updateTool = api.tools.get("fn_feature_update")!;

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

      await linkTool.execute(
        "l1",
        { featureId: feature.details.featureId, taskId: taskResult.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await updateTool.execute(
        "fu4",
        { id: feature.details.featureId, title: "Updated Feature" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getFeature(feature.details.featureId);

      expect(persisted?.taskId).toBe(taskResult.details.taskId);
      expect(persisted?.status).toBe("triaged");
    });

    it("returns error when feature not found", async () => {
      const updateTool = api.tools.get("fn_feature_update")!;

      const result = await updateTool.execute(
        "fu5",
        { id: "F-999", title: "Updated" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Feature F-999 not found");
    });

    it("returns error when no fields supplied", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const sliceTool = api.tools.get("fn_slice_add")!;
      const featureTool = api.tools.get("fn_feature_add")!;
      const updateTool = api.tools.get("fn_feature_update")!;

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

      const result = await updateTool.execute(
        "fu6",
        { id: feature.details.featureId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No fields to update");
    });
  });

  describe("fn_mission_update", () => {
    it("updates mission description and persists", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const updateTool = api.tools.get("fn_mission_update")!;

      const mission = await missionTool.execute(
        "m1",
        { title: "Mission", description: "Original description" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await updateTool.execute(
        "mu1",
        { id: mission.details.missionId, description: "  Updated description  " },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated");
      expect(result.details.missionId).toBe(mission.details.missionId);
      expect(result.details.description).toBe("Updated description");

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getMission(mission.details.missionId);
      expect(persisted?.description).toBe("Updated description");
    });

    it("returns error when mission not found", async () => {
      const updateTool = api.tools.get("fn_mission_update")!;
      const result = await updateTool.execute(
        "mu2",
        { id: "M-999", title: "Updated" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Mission M-999 not found");
    });

    it("returns error when no fields supplied", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const updateTool = api.tools.get("fn_mission_update")!;

      const mission = await missionTool.execute(
        "m1",
        { title: "Mission", description: "Original description" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await updateTool.execute(
        "mu3",
        { id: mission.details.missionId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No fields to update");
    });
  });

  describe("fn_milestone_update", () => {
    it("patches title, description, and acceptanceCriteria", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const updateTool = api.tools.get("fn_milestone_update")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone", description: "Original" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await updateTool.execute(
        "mu1",
        { id: milestone.details.milestoneId, title: "Updated Milestone", description: "Updated description", acceptanceCriteria: "AC new" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Updated");
      expect(result.details.title).toBe("Updated Milestone");
      expect(result.details.description).toBe("Updated description");
      expect(result.details.acceptanceCriteria).toBe("AC new");
    });

    it("partial patch updates only acceptanceCriteria", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const updateTool = api.tools.get("fn_milestone_update")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone", description: "Original" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await updateTool.execute(
        "mu2",
        { id: milestone.details.milestoneId, acceptanceCriteria: "Only AC" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getMilestone(milestone.details.milestoneId);

      expect(persisted?.title).toBe("Milestone");
      expect(persisted?.description).toBe("Original");
      expect(persisted?.acceptanceCriteria).toBe("Only AC");
    });

    it("returns error when milestone not found", async () => {
      const updateTool = api.tools.get("fn_milestone_update")!;
      const result = await updateTool.execute(
        "mu3",
        { id: "MS-999", title: "Updated" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Milestone MS-999 not found");
    });

    it("returns error when no fields supplied", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const updateTool = api.tools.get("fn_milestone_update")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const result = await updateTool.execute(
        "mu4",
        { id: milestone.details.milestoneId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No fields to update");
    });

    it("trims incoming field values", async () => {
      const missionTool = api.tools.get("fn_mission_create")!;
      const milestoneTool = api.tools.get("fn_milestone_add")!;
      const updateTool = api.tools.get("fn_milestone_update")!;

      const mission = await missionTool.execute("m1", { title: "Mission" }, undefined, undefined, makeCtx(tmpDir));
      const milestone = await milestoneTool.execute(
        "ms1",
        { missionId: mission.details.missionId, title: "Milestone" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await updateTool.execute(
        "mu5",
        { id: milestone.details.milestoneId, title: "  Trimmed  ", description: "  Desc  ", acceptanceCriteria: "  AC  " },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const store = new TaskStore(tmpDir);
      await store.init();
      const persisted = store.getMissionStore().getMilestone(milestone.details.milestoneId);

      expect(persisted?.title).toBe("Trimmed");
      expect(persisted?.description).toBe("Desc");
      expect(persisted?.acceptanceCriteria).toBe("AC");
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
      expect(vi.mocked(runGhJsonAsync)).toHaveBeenCalledWith(
        ["api", "repos/acme/demo/issues?state=open&per_page=5"],
        { signal: undefined },
      );

      const store = new TaskStore(tmpDir);
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
      expect(issueOneTask?.source?.sourceMetadata).toEqual({
        issueUrl: "https://github.com/acme/demo/issues/1",
        issueNumber: 1,
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
      expect(vi.mocked(runGhJsonAsync)).toHaveBeenCalledWith(
        ["api", "repos/acme/demo/issues?state=open&per_page=10"],
        { signal: undefined },
      );
    });
  });
});

describe("fn pi extension (runnable structured-output regression slice)", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeEach(async () => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
    vi.mocked(runTaskPlan).mockReset();

    tmpDir = await mkdtemp(join(tmpdir(), "kb-ext-fast-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await removeDirWithRetries(tmpDir);
  });

  it("returns machine-consumable task metadata without assuming FN-* prefixes", async () => {
    const createTool = api.tools.get("fn_task_create")!;
    const parent = await createTool.execute("create-1", { description: "parent" }, undefined, undefined, makeCtx(tmpDir));

    const result = await createTool.execute(
      "create-2",
      { description: "child", depends: [parent.details.taskId] },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.details.taskId).toMatch(/^[A-Z]+-\d+$/);
    expect(result.details.dependencies).toEqual([parent.details.taskId]);
    expect(result.content[0].text).toContain(result.details.taskId);
  });

  it("returns structured details for invalid task assignment", async () => {
    const createTool = api.tools.get("fn_task_create")!;
    const result = await createTool.execute(
      "create-bad-agent",
      { description: "bad assignment", agentId: "agent-does-not-exist" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.details.error).toContain("not found");
    expect(result.content[0].text).toContain("not found");
  });

  it("returns structured details when assignment targets ephemeral agents", async () => {
    const ephemeralId = await seedAgent(tmpDir, { ephemeral: true, name: "temp-worker" });
    const createTool = api.tools.get("fn_task_create")!;

    const result = await createTool.execute(
      "create-ephemeral",
      { description: "ephemeral assignment", agentId: ephemeralId },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.details.error).toContain("ephemeral/runtime agent");
    expect(result.content[0].text).toContain(ephemeralId);
  });

  it("returns explicit collision error when fn_task_create hits an existing task id", async () => {
    const createSpy = vi.spyOn(TaskStore.prototype, "createTask").mockRejectedValueOnce(new Error("Task ID already exists: FN-001"));
    const createTool = api.tools.get("fn_task_create")!;

    const result = await createTool.execute(
      "create-collision",
      { description: "collision task" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Task ID already exists: FN-001");
    expect(result.details.error).toContain("Task ID already exists: FN-001");
    createSpy.mockRestore();
  });

  it("fn_task_create allows durable engineer assignment for implementation tasks", async () => {
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
    await agentStore.init();
    const engineer = await agentStore.createAgent({ name: "engineer-create", role: "engineer" });

    const createTool = api.tools.get("fn_task_create")!;
    const result = await createTool.execute(
      "create-role-check-engineer",
      { description: "create with engineer", agentId: engineer.id },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain(`Assigned to: ${engineer.id}`);
  });

  it("fn_task_create rejects reviewer assignment for implementation tasks", async () => {
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
    await agentStore.init();
    const reviewer = await agentStore.createAgent({ name: "reviewer-create", role: "reviewer" });

    const createTool = api.tools.get("fn_task_create")!;
    const result = await createTool.execute(
      "create-role-check",
      { description: "create with reviewer", agentId: reviewer.id },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires an \"executor\"-role agent");
  });

  it("fn_task_update rejects reviewer assignment for implementation tasks", async () => {
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
    await agentStore.init();
    const reviewer = await agentStore.createAgent({ name: "reviewer", role: "reviewer" });

    const store = new TaskStore(tmpDir);
    await store.init();
    const task = await store.createTask({ description: "needs owner", column: "todo" });

    const updateTool = api.tools.get("fn_task_update")!;
    const result = await updateTool.execute(
      "update-role-check",
      { id: task.id, agentId: reviewer.id },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires an \"executor\"-role agent");
  });

  describe("FN-3799 assignment normalization", () => {
    it("FN-3799: treats empty-string agentId as unassigned on create", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      const result = await createTool.execute(
        "create-empty-agent",
        { description: "Task without assignee", agentId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.assignedAgentId).toBeUndefined();
      expect(result.content[0].text).not.toContain("Assigned to:");
      expect(result.content[0].text).not.toContain("Agent  not found");
    });

    it("clears task assigned agent ID with empty string", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute(
        "create-assigned",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "update-clear-empty",
        { id: created.details.taskId, agentId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain(`Updated ${created.details.taskId}`);
      expect(result.details.updatedFields).toEqual(["agentId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute(
        "show-cleared-empty",
        { id: created.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("clears task assigned agent ID with whitespace", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute(
        "create-assigned-whitespace",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      await updateTool.execute(
        "update-clear-whitespace",
        { id: created.details.taskId, agentId: "   " },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute(
        "show-cleared-whitespace",
        { id: created.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("clears task assigned agent ID with literal null string", async () => {
      const agentId = await seedAgent(tmpDir);
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute(
        "create-assigned-null-string",
        { description: "Original", agentId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      await updateTool.execute(
        "update-clear-null-string",
        { id: created.details.taskId, agentId: "null" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute(
        "show-cleared-null-string",
        { id: created.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.details.task.assignedAgentId).toBeUndefined();
    });

    it("returns readable unknown-agent errors with the invalid id", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute(
        "create-for-error",
        { description: "Original" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "update-unknown-agent",
        { id: created.details.taskId, agentId: "agent-does-not-exist" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Agent agent-does-not-exist not found");
    });

    it("clears node override with empty string", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      const created = await createTool.execute(
        "create-node-task",
        { description: "Original" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const updateTool = api.tools.get("fn_task_update")!;
      const setNode = await updateTool.execute(
        "set-node",
        { id: created.details.taskId, nodeId: "node-123" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(setNode.isError).not.toBe(true);

      const clearNode = await updateTool.execute(
        "clear-node",
        { id: created.details.taskId, nodeId: "" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(clearNode.content[0].text).toContain(`Updated ${created.details.taskId}`);
      expect(clearNode.details.updatedFields).toEqual(["nodeId"]);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute(
        "show-cleared-node",
        { id: created.details.taskId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expect(show.details.task.nodeId).toBeUndefined();
    });
  });

  describe("fn_task_retry", () => {
    const nonZeroRetryCounters = Object.fromEntries(
      MANUAL_RETRY_RESET_COUNTER_KEYS.map((key, index) => [key, index + 1]),
    );

    const expectRetryCountersReset = (task: Awaited<ReturnType<TaskStore["getTask"]>>) => {
      expect(task).toBeTruthy();
      if (!task) return;
      for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
        expect(task[key] ?? 0).toBe(0);
      }
      expect(task.nextRecoveryAt ?? null).toBeNull();
      expect(task.retrySummary?.total ?? 0).toBe(0);
    };

    it("moves execution-failed in-review task (incomplete steps) to todo preserving progress", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const task = await store.createTask({
        title: "execution-failed task",
        description: "test",
        column: "todo",
      });
      await store.updateTask(task.id, {
        steps: [
          { name: "Step 0", status: "done" },
          { name: "Step 1", status: "in-progress" },
          { name: "Step 2", status: "pending" },
        ],
      });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "failed",
        error: "429 rate limited",
        mergeRetries: 9,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-exec", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.steps[1].status).toBe("in-progress");
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(9);
    });

    it("moves zero-step execution-failed in-review task to todo and clears failure state", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const task = await store.createTask({
        title: "zero-step execution-failed task",
        description: "test",
        column: "todo",
      });
      await writeFile(join(tmpDir, ".fusion", "tasks", task.id, "PROMPT.md"), "# zero-step execution-failed task\n\nNo steps yet.\n");
      await store.updateTask(task.id, { steps: [] });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { status: "failed", error: "executor crashed", mergeRetries: 0, steps: [] });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-zero-step-exec", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.steps).toEqual([]);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("keeps merge-failed in-review task (all steps done) in in-review and resets merge state", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const task = await store.createTask({
        title: "merge-failed task",
        description: "test",
        column: "todo",
      });
      await store.updateTask(task.id, {
        steps: [
          { name: "Step 0", status: "done" },
          { name: "Step 1", status: "done" },
        ],
      });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "failed",
        error: "merge conflict",
        mergeRetries: 3,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("in-review");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("in-review");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("keeps zero-step merge-failed in-review task with prior merge attempts in-review and resets merge state", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const task = await store.createTask({
        title: "zero-step merge-failed task",
        description: "test",
        column: "todo",
      });
      await writeFile(join(tmpDir, ".fusion", "tasks", task.id, "PROMPT.md"), "# zero-step merge-failed task\n\nNo steps yet.\n");
      await store.updateTask(task.id, { steps: [] });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "failed",
        error: "merge conflict",
        mergeRetries: 2,
        steps: [],
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-zero-step-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("in-review");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("in-review");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.steps).toEqual([]);
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("moves non-review failed task to todo and resets all retry counters", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();

      const task = await store.createTask({
        title: "failed in-progress task",
        description: "test",
        column: "todo",
      });
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, {
        status: "failed",
        error: "verification failed",
        mergeRetries: 8,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-generic", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });
  });

  describe("fn_list_agents", () => {
    it("returns agent list", async () => {
      await seedAgent(tmpDir, { name: "alpha-agent" });
      await seedAgent(tmpDir, { name: "beta-agent" });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-1", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("alpha-agent");
      expect(result.content[0].text).toContain("beta-agent");
      expect(result.details.count).toBeGreaterThanOrEqual(2);
    });

    it("filters by role", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      await agentStore.createAgent({ name: "exec-agent", role: "executor", metadata: {} });
      await agentStore.createAgent({ name: "review-agent", role: "reviewer", metadata: {} });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-2", { role: "executor" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("exec-agent");
      expect(result.content[0].text).not.toContain("review-agent");
    });

    it("filters by state", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const active = await agentStore.createAgent({ name: "active-agent", role: "executor", metadata: {} });
      await agentStore.updateAgentState(active.id, "active");

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-3", { state: "active" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("active-agent");
      expect(result.details.agents.every((a: any) => a.state === "active")).toBe(true);
    });

    it("excludes ephemeral agents by default", async () => {
      const ephemeralId = await seedAgent(tmpDir, { ephemeral: true, name: "eph-agent" });
      await seedAgent(tmpDir, { name: "real-agent" });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-4", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).not.toContain("eph-agent");
      expect(result.content[0].text).toContain("real-agent");
      expect(result.details.agents.every((a: any) => a.id !== ephemeralId)).toBe(true);
    });

    it("returns empty list message when no agents", async () => {
      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-5", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("No agents found");
      expect(result.details.count).toBe(0);
    });
  });

  describe("research tools", () => {
    it.each([
      "fn_research_run",
      "fn_research_list",
      "fn_research_get",
      "fn_research_cancel",
      "fn_research_retry",
    ])("%s uses disambiguated cited-research wording", (toolName) => {
      const tool = api.tools.get(toolName)!;
      expect(tool.description).toMatch(/cited-research pipeline/i);
      if (/experiment loop/i.test(tool.description)) {
        expect(tool.description).toMatch(/not\s+.*experiment loop/i);
      }
    });

    it("fn_research_run treats builtin as configured when no provider is explicitly set", async () => {
      const store = new TaskStore(tmpDir);
      await store.init();
      await store.updateGlobalSettings({
        researchGlobalEnabled: true,
        experimentalFeatures: { researchView: true } as Record<string, boolean>,
      });
      await store.updateSettings({
        researchEnabled: true,
        researchSettings: { enabled: true },
      });

      const tool = api.tools.get("fn_research_run")!;
      const result = await tool.execute(
        "research-run-builtin",
        { query: "builtin default" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.setup).toBeNull();
      expect(result.details.status).toBe("queued");
    });

    it("fn_research_list status parameter matches RESEARCH_RUN_STATUSES", () => {
      const tool = api.tools.get("fn_research_list") as any;
      const statusSchema = tool.parameters.properties.status;
      const enumValues = statusSchema.enum ?? statusSchema.anyOf?.[0]?.enum;
      expect(enumValues).toEqual([...RESEARCH_RUN_STATUSES]);
    });

    it("fn_research_run preserves fire-and-forget behavior when wait_for_completion is false", async () => {
      await enableResearch(tmpDir);
      const tool = api.tools.get("fn_research_run")!;

      const result = await tool.execute(
        "research-run-ff",
        { query: "test query", wait_for_completion: false },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Start the project engine to process pending runs");
      expect(result.details.status).toBe("queued");
    });

    it("fn_research_run waits and returns terminal run details when wait_for_completion is true", async () => {
      const store = await enableResearch(tmpDir);
      const tool = api.tools.get("fn_research_run")!;
      const researchStore = store.getResearchStore();

      const settleRunToCompleted = () => {
        const queuedRun = researchStore.listRuns({ limit: 1 })[0];
        if (!queuedRun) {
          return false;
        }
        if (queuedRun.status === "completed") {
          return true;
        }
        if (queuedRun.status === "queued") {
          researchStore.updateRun(queuedRun.id, { status: "running" });
        }
        researchStore.updateRun(queuedRun.id, {
          status: "completed",
          results: { summary: "done", findings: [{ heading: "h1", content: "f1", sources: [] }], citations: [] },
        });
        return true;
      };

      if (!settleRunToCompleted()) {
        const interval = setInterval(() => {
          if (settleRunToCompleted()) {
            clearInterval(interval);
          }
        }, 25);
        setTimeout(() => clearInterval(interval), 500);
      }

      const result = await tool.execute(
        "research-run-wait",
        { query: "terminal query", wait_for_completion: true, max_wait_ms: 4000 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.summary).toBe("done");
      expect(result.content[0].text).toContain("is completed");
    });
  });

  describe("fn_delegate_task", () => {
    it("delegates task to agent", async () => {
      const agentId = await seedAgent(tmpDir, { name: "delegate-target" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-1",
        { agent_id: agentId, description: "Do important work" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("delegate-target");
      expect(result.content[0].text).toContain(agentId);
      expect(result.details.agentId).toBe(agentId);
      expect(result.details.agentName).toBe("delegate-target");
      expect(result.details.taskId).toBeTruthy();

      // Verify task was actually created
      const store = new TaskStore(tmpDir);
      await store.init();
      const task = await store.getTask(result.details.taskId);
      expect(task).toBeTruthy();
      expect(task!.assignedAgentId).toBe(agentId);
      expect(task!.column).toBe("todo");
    });

    it("rejects unknown agent", async () => {
      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-2",
        { agent_id: "agent-no-such", description: "Will fail" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("rejects ephemeral agent", async () => {
      const ephemeralId = await seedAgent(tmpDir, { ephemeral: true, name: "eph-delegate" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-3",
        { agent_id: ephemeralId, description: "Will fail" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ephemeral/runtime agent");
    });

    it("allows durable engineer delegate target without override", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const engineer = await agentStore.createAgent({ name: "delegate-engineer", role: "engineer" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-role-eng",
        { agent_id: engineer.id, description: "Engineer routing" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.agentId).toBe(engineer.id);
    });

    it("rejects reviewer delegate target without override", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const reviewer = await agentStore.createAgent({ name: "delegate-reviewer", role: "reviewer" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-role-1",
        { agent_id: reviewer.id, description: "Will fail role policy" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("requires an \"executor\"-role agent");
    });

    it("allows non-executor delegate target with override", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const reviewer = await agentStore.createAgent({ name: "delegate-reviewer-override", role: "reviewer" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-role-2",
        { agent_id: reviewer.id, description: "Intentional override", override: true },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.agentId).toBe(reviewer.id);

      const store = new TaskStore(tmpDir);
      await store.init();
      const task = await store.getTask(result.details.taskId);
      expect(task.sourceMetadata).toMatchObject({ executorRoleOverride: true });

      const selected = await store.selectNextTaskForAgent(reviewer.id, { id: reviewer.id, role: reviewer.role });
      expect(selected?.task.id).toBe(task.id);
    });

    it("wires dependencies correctly", async () => {
      const agentId = await seedAgent(tmpDir, { name: "dep-agent" });

      // Create a real task to use as a dependency
      const store = new TaskStore(tmpDir);
      await store.init();
      const depTask = await store.createTask({ description: "Prerequisite", column: "todo" });

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-4",
        { agent_id: agentId, description: "Dependent work", dependencies: [depTask.id] },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain(depTask.id);

      const task = await store.getTask(result.details.taskId);
      expect(task!.dependencies).toEqual([depTask.id]);
    });
  });

  describe("fn_agent_show", () => {
    it("shows agent by ID", async () => {
      const agentId = await seedAgent(tmpDir, { name: "show-agent" });

      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-1", { id: agentId }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("show-agent");
      expect(result.content[0].text).toContain(agentId);
      expect(result.details.agent.id).toBe(agentId);
    });

    it("shows agent by name", async () => {
      await seedAgent(tmpDir, { name: "resolve-by-name" });

      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-2", { id: "resolve-by-name" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("resolve-by-name");
      expect(result.details.agent.name).toBe("resolve-by-name");
    });

    it("returns error for unknown agent", async () => {
      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-3", { id: "no-such-agent" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("shows reports-to and direct reports", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const manager = await agentStore.createAgent({ name: "the-manager", role: "executor", metadata: {} });
      const report = await agentStore.createAgent({
        name: "the-report",
        role: "executor",
        reportsTo: manager.id,
        metadata: {},
      });

      const tool = api.tools.get("fn_agent_show")!;

      // Check manager sees direct reports
      const mgrResult = await tool.execute("as-4a", { id: manager.id }, undefined, undefined, makeCtx(tmpDir));
      expect(mgrResult.content[0].text).toContain("the-report");
      expect(mgrResult.details.directReports.length).toBeGreaterThan(0);

      // Check report sees reports-to
      const rptResult = await tool.execute("as-4b", { id: report.id }, undefined, undefined, makeCtx(tmpDir));
      expect(rptResult.content[0].text).toContain("the-manager");
    });
  });

  describe("fn_agent_org_chart", () => {
    it("returns full tree", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      await agentStore.createAgent({ name: "ceo", role: "executor", metadata: {} });
      await agentStore.createAgent({ name: "worker", role: "executor", metadata: {} });

      const tool = api.tools.get("fn_agent_org_chart")!;
      const result = await tool.execute("oc-1", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("ceo");
      expect(result.content[0].text).toContain("worker");
      expect(result.details.count).toBeGreaterThanOrEqual(2);
    });

    it("returns subtree by root agent", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const manager = await agentStore.createAgent({ name: "org-manager", role: "executor", metadata: {} });
      await agentStore.createAgent({ name: "org-report", role: "executor", reportsTo: manager.id, metadata: {} });

      const tool = api.tools.get("fn_agent_org_chart")!;
      const result = await tool.execute("oc-2", { root_agent_id: manager.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("org-manager");
      expect(result.content[0].text).toContain("org-report");
    });

    it("returns empty message when no agents", async () => {
      const tool = api.tools.get("fn_agent_org_chart")!;
      const result = await tool.execute("oc-3", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("No agents found");
      expect(result.details.count).toBe(0);
    });

    it("returns single agent for lone agent", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const lone = await agentStore.createAgent({ name: "lone-agent", role: "executor", metadata: {} });

      const tool = api.tools.get("fn_agent_org_chart")!;
      const result = await tool.execute("oc-4", { root_agent_id: lone.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("lone-agent");
    });
  });
});
