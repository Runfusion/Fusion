import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

/*
FNXC:CliTests 2026-06-14-01:22:
FN-6430 rescues the extension suite by fixing shared HOME isolation and closing research stores in the active slice, not by preserving the older file-wide timeout bump.
Keep this file on the default 5s Vitest timeout so future slow seams are narrowed or quarantined instead of hidden.
*/

vi.mock("@fusion/core/gh-cli", () => ({
  isGhAvailable: vi.fn(() => true),
  isGhAuthenticated: vi.fn(() => true),
  runGhJsonAsync: vi.fn(),
  getGhErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
}));

vi.mock("../commands/task.js", () => ({
  runTaskPlan: vi.fn(),
}));

import { __setCachedStoreForTesting, closeCachedStores, resolveTaskListFormatter } from "../extension.js";
import { TaskStore, AgentStore, MANUAL_RETRY_RESET_COUNTER_KEYS, MAX_TASK_LIST_TEXT_CHARS, formatTaskListText, COLUMN_LABELS, drizzleSql } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { isGhAvailable, isGhAuthenticated, runGhJsonAsync } from "@fusion/core/gh-cli";
import { runTaskPlan } from "../commands/task.js";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  type MockApi,
  type ToolExecuteContext,
  type ToolResult,
  type ToolResultContent,
} from "./pg-extension-harness.js";

/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to a shared
 * PostgreSQL extension harness. Store construction goes through `h.store()`,
 * tool calls use `cwd: h.rootDir()`, and state is read via async store methods.
 */
const pgTest = pgDescribe;
const h = createPgExtensionHarness("fn-extension");


function makeCtx(cwd: string): ToolExecuteContext {
  return { cwd };
}

describe("fn pi extension session lifecycle", () => {
  afterEach(async () => {
    await closeCachedStores();
  });

  it("keeps session_shutdown pending until factory-owned cache teardown finishes", async () => {
    /*
    FNXC:PostgresCliLifecycle 2026-07-14-22:38:
    Pi awaits the promise returned by session_shutdown. Keep that promise pending until the cached startup-factory owner finishes so PostgreSQL resources cannot outlive the extension session.
    */
    let releaseShutdown!: () => void;
    const backendShutdown = vi.fn(() => new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    }));
    __setCachedStoreForTesting("/owned-extension-store", {} as TaskStore, backendShutdown);

    const events = new Map<string, () => Promise<void>>();
    const api = createMockApi();
    api.on = ((event: string, handler: () => Promise<void>) => {
      events.set(event, handler);
    }) as MockApi["on"];
    registerExtension(api);

    const shutdownPromise = events.get("session_shutdown")?.();
    expect(shutdownPromise).toBeDefined();
    let settled = false;
    void shutdownPromise?.then(() => { settled = true; });
    await vi.waitFor(() => expect(backendShutdown).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseShutdown();
    await expect(shutdownPromise).resolves.toBeUndefined();
  });
});
interface ToolMeta {
  description?: string;
  promptGuidelines?: string[];
}
interface ToolParameterSchema {
  enum?: unknown[];
  anyOf?: { const?: string; enum?: unknown[] }[];
}
interface ToolWithParameters {
  parameters?: { properties?: Record<string, ToolParameterSchema> };
}

async function seedAgent(
  cwd: string,
  overrides: { ephemeral?: boolean; name?: string } = {},
): Promise<string> {
  // FNXC:PostgresCutover: seed via the PG asyncLayer so AgentStore runs in
  // backend mode (the SQLite Database class body has been removed).
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
  await agentStore.init();
  const agent = await agentStore.createAgent({
    name: overrides.name ?? "test-agent",
    role: "executor",
    metadata: overrides.ephemeral ? { agentKind: "task-worker" } : {},
  });
  return agent.id;
}

function linearWorkflowIr(name: string): WorkflowIr {
  return {
    version: "v2",
    name,
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: "lint",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Lint",
          defaultOn: true,
          template: { nodes: [{ id: "lint-step", kind: "gate", config: { name: "Lint", scriptName: "lint" } }], edges: [] },
        },
      },
      {
        id: "spec",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Spec",
          defaultOn: true,
          template: { nodes: [{ id: "spec-step", kind: "prompt", config: { name: "Spec", prompt: "check" } }], edges: [] },
        },
      },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "spec", condition: "success" },
      { from: "spec", to: "end", condition: "success" },
    ],
  };
}

async function seedWorkflow(_cwd: string, name = "QA workflow"): Promise<string> {
  const store = h.store();
  const workflow = await store.createWorkflowDefinition({ name, ir: linearWorkflowIr(name) });
  return workflow.id;
}

async function readTaskWorkflowState(_cwd: string, taskId: string) {
  const store = h.store();
  const task = await store.getTask(taskId);
  const selection = await store.getTaskWorkflowSelectionAsync(taskId);
  return { task, selection };
}

// ── Tests ──────────────────────────────────────────────────────────

pgTest("fn pi extension tool copy guardrails", () => {
  it("describes fn_task_delete as soft delete and avoids irrecoverability claims (FN-5141)", () => {
    const api = createMockApi();
    registerExtension(api);

    const tool = requireTool(api, "fn_task_delete") as unknown as ToolMeta;

    expect(tool.description ?? "").not.toMatch(/permanent|cannot be recovered|cannot be undone|deleted immediately/i);
    expect(tool.description ?? "").toMatch(/soft.?delete/i);

    const guidelines = (tool.promptGuidelines ?? []).join(" ");
    expect(guidelines).toMatch(/soft.?delete/i);
    expect(guidelines).not.toMatch(/permanent|cannot be recovered|cannot be undone|deleted immediately|irrecoverable/i);
  });

  it("describes fn_agent_stop as allowing error-state agents to be paused (FN-6018)", () => {
    const api = createMockApi();
    registerExtension(api);

    const tool = requireTool(api, "fn_agent_stop") as unknown as ToolMeta;

    const guidelines = (tool.promptGuidelines ?? []).join(" ");
    expect(guidelines).toMatch(/running, active, or in error/i);
    expect(guidelines).toMatch(/idle.*already-paused/i);
    expect(guidelines).not.toMatch(/idle, 'error', or already-paused/i);
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

const legacyDescribe = SHOULD_RUN_LEGACY_EXTENSION_INTEGRATION ? pgTest : describe.skip;

legacyDescribe("fn pi extension (legacy exhaustive suite)", () => {
  let tmpDir: string;
  // The legacy registration its also read commands/events; the harness MockApi
  // only tracks tools, so cast once at this boundary for those reads. The whole
  // suite stays gated off by default (legacyDescribe === describe.skip).
  type LegacyApi = MockApi & {
    commands: Map<string, { description: string }>;
    events: Map<string, unknown>;
  };
  let api: LegacyApi;

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  beforeEach(async () => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
    vi.mocked(runTaskPlan).mockReset();

    tmpDir = h.rootDir();
    api = createMockApi() as unknown as LegacyApi;
    registerExtension(api);
    // FNXC:PostgresCutover: pin the "FN" task prefix (PG allocator defaults to "KB").
    await h.store().updateSettings({ taskPrefix: "FN" });
  });

  describe("registration", () => {
    it("registers all expected tools", () => {
      const expected = [
        "fn_workflow_list",
        "fn_workflow_get",
        "fn_workflow_validate",
        "fn_workflow_create",
        "fn_workflow_update",
        "fn_workflow_delete",
        "fn_workflow_settings",
        "fn_trait_list",
        "fn_workflow_select",
        "fn_task_create",
        "fn_task_update",
        "fn_task_list",
        "fn_task_show",
        "fn_task_attach",
        "fn_task_pause",
        "fn_task_unpause",
        "fn_task_retry",
        "fn_task_bypass_review",
        "fn_task_duplicate",
        "fn_task_refine",
        "fn_task_import_github",
        "fn_task_import_github_issue",
        "fn_task_browse_github_issues",
        "fn_task_browse_gitlab_project_issues",
        "fn_task_import_gitlab_project_issues",
        "fn_task_browse_gitlab_group_issues",
        "fn_task_import_gitlab_group_issues",
        "fn_task_browse_gitlab_merge_requests",
        "fn_task_import_gitlab_merge_requests",
        "fn_task_archive",
        "fn_task_unarchive",
        "fn_task_delete",
        "fn_task_plan",
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

    it("creates a task with workflow_id selected and materialized", async () => {
      const workflowId = await seedWorkflow(tmpDir, "Explicit create workflow");
      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-workflow",
        { description: "Workflow task", workflow_id: workflowId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain(`(workflow: ${workflowId})`);
      const { task, selection } = await readTaskWorkflowState(tmpDir, result.details.taskId);
      expect(selection?.workflowId).toBe(workflowId);
      expect(task.enabledWorkflowSteps).toHaveLength(2);
    });

    it("creates a task without workflow_id using the project default workflow", async () => {
      const workflowId = await seedWorkflow(tmpDir, "Default create workflow");
      const store = h.store();
      try {
        await store.setDefaultWorkflowId(workflowId);
      } finally {
      }

      const tool = api.tools.get("fn_task_create")!;
      const result = await tool.execute(
        "call-default-workflow",
        { description: "Default workflow task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const { task, selection } = await readTaskWorkflowState(tmpDir, result.details.taskId);
      expect(selection?.workflowId).toBe(workflowId);
      expect(task.enabledWorkflowSteps).toHaveLength(2);
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

    it("updates task workflow_id through workflow reconciliation", async () => {
      const workflowId = await seedWorkflow(tmpDir, "Update workflow");
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const selectSpy = vi.spyOn(TaskStore.prototype, "selectTaskWorkflowAndReconcile");
      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", workflow_id: workflowId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.updatedFields).toEqual(["workflowId"]);
      expect(selectSpy).toHaveBeenCalledWith("FN-001", workflowId);
      selectSpy.mockRestore();
      const { task, selection } = await readTaskWorkflowState(tmpDir, "FN-001");
      expect(selection?.workflowId).toBe(workflowId);
      expect(task.enabledWorkflowSteps).toHaveLength(2);
    });

    it("clears task workflow_id with null", async () => {
      const workflowId = await seedWorkflow(tmpDir, "Clear workflow");
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original", workflow_id: workflowId }, undefined, undefined, makeCtx(tmpDir));

      const clearSpy = vi.spyOn(TaskStore.prototype, "clearTaskWorkflowSelection");
      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", workflow_id: null },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.updatedFields).toEqual(["workflowId"]);
      expect(clearSpy).toHaveBeenCalledWith("FN-001");
      clearSpy.mockRestore();
      const { task, selection } = await readTaskWorkflowState(tmpDir, "FN-001");
      expect(selection).toBeUndefined();
      expect(task.enabledWorkflowSteps ?? []).toEqual([]);
    });

    it("returns an error for unknown workflow_id updates", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", workflow_id: "WF-404" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("WF-404");
    });

    it("treats empty-string workflow_id as not provided", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute("c1", { description: "Original" }, undefined, undefined, makeCtx(tmpDir));

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "u1",
        { id: "FN-001", title: "Retitled", workflow_id: "   " },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.updatedFields).toEqual(["title"]);
      const { selection } = await readTaskWorkflowState(tmpDir, "FN-001");
      expect(selection).toBeUndefined();
    });

    it("rejects invalid priority value", () => {
      const updateTool = requireTool(api, "fn_task_update") as unknown as ToolWithParameters;
      const prioritySchema = updateTool.parameters?.properties?.priority;
      const literalValues = (prioritySchema?.anyOf ?? []).map((entry) => entry.const);
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
      const store = h.store();

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
      const store = h.store();

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
      const store = h.store();

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

    it("attaches a file from an in-boundary nested subdirectory", async () => {
      const createTool = api.tools.get("fn_task_create")!;
      await createTool.execute(
        "c1",
        { description: "A task" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      await mkdir(join(tmpDir, "nested", "dir"), { recursive: true });
      const testFile = join(tmpDir, "nested", "dir", "inner.txt");
      await writeFile(testFile, "inner content");

      const attachTool = api.tools.get("fn_task_attach")!;
      const result = await attachTool.execute(
        "call-1",
        { id: "FN-001", path: "nested/dir/inner.txt" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.content[0].text).toContain("Attached to FN-001");
      expect(result.details.attachment.originalName).toBe("inner.txt");
    });

    /*
     * FNXC:CliTaskAttach 2026-07-05-00:00:
     * Regression coverage for FN-7619 — fn_task_attach must reject any path
     * (relative traversal, absolute, or @-prefixed traversal) that resolves
     * outside the task worktree boundary (ctx.cwd), and must never create an
     * attachment when it does.
     */
    describe("worktree boundary guard (FN-7619)", () => {
      let outsideDir: string;
      let outsideFile: string;

      beforeEach(async () => {
        outsideDir = await mkdtemp(join(tmpdir(), "kb-ext-test-outside-"));
        outsideFile = join(outsideDir, "secret.txt");
        await writeFile(outsideFile, "top secret contents");
      });

      afterEach(async () => {
        await rm(outsideDir, { recursive: true, force: true });
      });

      it("rejects a relative traversal path escaping the worktree", async () => {
        const createTool = api.tools.get("fn_task_create")!;
        await createTool.execute(
          "c1",
          { description: "A task" },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );

        const relPath = join(relative(tmpDir, outsideDir), "secret.txt");

        const attachTool = api.tools.get("fn_task_attach")!;
        await expect(
          attachTool.execute(
            "call-1",
            { id: "FN-001", path: relPath },
            undefined,
            undefined,
            makeCtx(tmpDir),
          ),
        ).rejects.toThrow(/boundary|outside/i);

        const store = new TaskStore(tmpDir);
        const task = await store.getTask("FN-001");
        expect(task?.attachments ?? []).toHaveLength(0);
      });

      it("rejects an absolute path outside the worktree", async () => {
        const createTool = api.tools.get("fn_task_create")!;
        await createTool.execute(
          "c1",
          { description: "A task" },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );

        const attachTool = api.tools.get("fn_task_attach")!;
        await expect(
          attachTool.execute(
            "call-1",
            { id: "FN-001", path: outsideFile },
            undefined,
            undefined,
            makeCtx(tmpDir),
          ),
        ).rejects.toThrow(/boundary|outside/i);

        const store = new TaskStore(tmpDir);
        const task = await store.getTask("FN-001");
        expect(task?.attachments ?? []).toHaveLength(0);
      });

      it("rejects an @-prefixed traversal path escaping the worktree", async () => {
        const createTool = api.tools.get("fn_task_create")!;
        await createTool.execute(
          "c1",
          { description: "A task" },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );

        const relPath = join(relative(tmpDir, outsideDir), "secret.txt");

        const attachTool = api.tools.get("fn_task_attach")!;
        await expect(
          attachTool.execute(
            "call-1",
            { id: "FN-001", path: `@${relPath}` },
            undefined,
            undefined,
            makeCtx(tmpDir),
          ),
        ).rejects.toThrow(/boundary|outside/i);

        const store = new TaskStore(tmpDir);
        const task = await store.getTask("FN-001");
        expect(task?.attachments ?? []).toHaveLength(0);
      });
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
    it("FN-7188 describes pause as user-requested manual control, not failure handling", () => {
      const pauseTool = api.tools.get("fn_task_pause")!;

      expect(pauseTool.description).toContain("explicit user-requested manual control");
      expect(pauseTool.description).toContain("should not pause tasks to handle failures or blockers");
      expect(pauseTool.description).toContain("let the task surface as failed");
    });

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

      const store = h.store();
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
      const store = h.store();
      // FNXC:PostgresCutover: seed ai_sessions drafts via the PG async layer
      // (the sync getDatabase() SQLite path is removed).
      const db = store.getAsyncLayer()!.db;
      await db.execute(drizzleSql`INSERT INTO project.ai_sessions (id, type, status, title, input_payload, conversation_history, current_question, result, thinking_output, error, project_id, created_at, updated_at, locked_by_tab, locked_at)
        VALUES (${"draft-1"}, 'mission_interview', 'awaiting_input', ${"Draft Mission"}, ${"{}"}, ${"[]"}, NULL, NULL, ${""}, NULL, NULL, ${"2026-05-12T00:00:00.000Z"}, ${"2026-05-12T00:00:00.000Z"}, NULL, NULL)`);
      await db.execute(drizzleSql`INSERT INTO project.ai_sessions (id, type, status, title, input_payload, conversation_history, current_question, result, thinking_output, error, project_id, created_at, updated_at, locked_by_tab, locked_at)
        VALUES (${"draft-2"}, 'mission_interview', 'complete', ${"Ready Mission"}, ${"{}"}, ${"[]"}, NULL, ${"{}"}, ${""}, NULL, NULL, ${"2026-05-12T00:01:00.000Z"}, ${"2026-05-12T00:01:00.000Z"}, NULL, NULL)`);

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
      const store = h.store();
      // FNXC:PostgresCutover: seed ai_sessions drafts via the PG async layer.
      const db = store.getAsyncLayer()!.db;
      await db.execute(drizzleSql`INSERT INTO project.ai_sessions (id, type, status, title, input_payload, conversation_history, current_question, result, thinking_output, error, project_id, created_at, updated_at, locked_by_tab, locked_at)
        VALUES (${"draft-2"}, 'mission_interview', 'error', ${"Hidden Draft"}, ${"{}"}, ${"[]"}, NULL, NULL, ${""}, NULL, NULL, ${"2026-05-12T00:00:00.000Z"}, ${"2026-05-12T00:00:00.000Z"}, NULL, NULL)`);

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

      const store = h.store();
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
      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
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

      const store = h.store();
      const tasks = await store.listTasks({ includeArchived: true });
      expect(tasks).toHaveLength(2);
      const issueOneTask = tasks.find((task) => task.sourceIssue?.issueNumber === 1);
      expect(issueOneTask?.githubTracking?.enabled).toBeUndefined();
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

    it("fn_task_import_github marks imported issues as tracked when tracking defaults are on", async () => {
      const store = h.store();
      await store.updateSettings({ githubTrackingEnabledByDefault: true });

      const tool = api.tools.get("fn_task_import_github")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
        {
          number: 7,
          title: "Tracked issue",
          body: "Tracked issue body",
          html_url: "https://github.com/acme/demo/issues/7",
        },
      ] as never);

      await tool.execute("gh-tracked-bulk", { ownerRepo: "acme/demo" }, undefined, undefined, makeCtx(tmpDir));

      const verifyStore = h.store();
      const tasks = await verifyStore.listTasks({ includeArchived: true });
      const imported = tasks.find((task) => task.sourceIssue?.issueNumber === 7);
      expect(imported?.githubTracking?.enabled).toBe(true);
      expect(imported?.sourceIssue).toEqual(expect.objectContaining({
        provider: "github",
        repository: "acme/demo",
        issueNumber: 7,
      }));
    });

    it("fn_task_import_github marks imported issues as tracked when import linking is on and new-task defaults are off", async () => {
      const store = h.store();
      await store.updateSettings({
        githubTrackingEnabledByDefault: false,
        githubLinkImportedIssuesToTracking: true,
      });

      const tool = api.tools.get("fn_task_import_github")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
        {
          number: 9,
          title: "Import-linked issue",
          body: null,
          html_url: "https://github.com/acme/demo/issues/9",
        },
      ] as never);

      await tool.execute("gh-import-linked-bulk", { ownerRepo: "acme/demo" }, undefined, undefined, makeCtx(tmpDir));

      const verifyStore = h.store();
      const tasks = await verifyStore.listTasks({ includeArchived: true });
      const imported = tasks.find((task) => task.sourceIssue?.issueNumber === 9);
      expect(imported?.description).toContain("(no description)");
      expect(imported?.githubTracking?.enabled).toBe(true);
      expect(imported?.sourceIssue).toEqual(expect.objectContaining({
        provider: "github",
        repository: "acme/demo",
        issueNumber: 9,
      }));
    });

    it("fn_task_import_github_issue leaves imported issues unforced when tracking defaults are off", async () => {
      const tool = api.tools.get("fn_task_import_github_issue")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce({
        number: 6,
        title: "Single untracked issue",
        body: "Single issue body",
        html_url: "https://github.com/acme/demo/issues/6",
      } as never);

      const result = await tool.execute(
        "gh-untracked-single",
        { owner: "acme", repo: "demo", issueNumber: 6 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const verifyStore = h.store();
      const imported = await verifyStore.getTask(result.details.taskId);
      expect(imported?.githubTracking?.enabled).toBeUndefined();
      expect(imported?.sourceIssue).toEqual(expect.objectContaining({
        provider: "github",
        repository: "acme/demo",
        issueNumber: 6,
      }));
    });

    it("fn_task_import_github_issue marks imported issues as tracked when tracking defaults are on", async () => {
      const store = h.store();
      await store.updateSettings({ githubTrackingEnabledByDefault: true });

      const tool = api.tools.get("fn_task_import_github_issue")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce({
        number: 8,
        title: "Single tracked issue",
        body: "Single issue body",
        html_url: "https://github.com/acme/demo/issues/8",
      } as never);

      const result = await tool.execute(
        "gh-tracked-single",
        { owner: "acme", repo: "demo", issueNumber: 8 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const verifyStore = h.store();
      const imported = await verifyStore.getTask(result.details.taskId);
      expect(imported?.githubTracking?.enabled).toBe(true);
      expect(imported?.sourceIssue).toEqual(expect.objectContaining({
        provider: "github",
        repository: "acme/demo",
        issueNumber: 8,
      }));
    });

    it("fn_task_import_github_issue marks imported issues as tracked when import linking is on and new-task defaults are off", async () => {
      const store = h.store();
      await store.updateSettings({
        githubTrackingEnabledByDefault: false,
        githubLinkImportedIssuesToTracking: true,
      });

      const tool = api.tools.get("fn_task_import_github_issue")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce({
        number: 10,
        title: "Single import-linked issue",
        body: null,
        html_url: "https://github.com/acme/demo/issues/10",
      } as never);

      const result = await tool.execute(
        "gh-import-linked-single",
        { owner: "acme", repo: "demo", issueNumber: 10 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      const verifyStore = h.store();
      const imported = await verifyStore.getTask(result.details.taskId);
      expect(imported?.description).toContain("(no description)");
      expect(imported?.githubTracking?.enabled).toBe(true);
      expect(imported?.sourceIssue).toEqual(expect.objectContaining({
        provider: "github",
        repository: "acme/demo",
        issueNumber: 10,
      }));
    });

    it("fn_task_import_github skips issues already imported via sourceIssue even when description was edited", async () => {
      const store = h.store();
      await store.createTask({
        title: "Existing imported issue",
        description: "Edited description without source URL",
        sourceIssue: {
          provider: "github",
          repository: "acme/demo",
          externalIssueId: "1",
          issueNumber: 1,
          url: "https://github.com/acme/demo/issues/1",
        },
      });

      const tool = api.tools.get("fn_task_import_github")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
        {
          number: 1,
          title: "Issue one",
          body: "First issue body",
          html_url: "https://github.com/acme/demo/issues/1",
        },
      ] as never);

      const result = await tool.execute("gh-2b", { ownerRepo: "acme/demo" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("Imported 0 tasks from acme/demo");
      expect(result.details.createdTasks).toHaveLength(0);
    });

    it("fn_task_import_github_issue skips issues already imported via sourceIssue even when description was edited", async () => {
      const store = h.store();
      const existing = await store.createTask({
        title: "Existing imported issue",
        description: "Edited description without source URL",
        sourceIssue: {
          provider: "github",
          repository: "acme/demo",
          externalIssueId: "1",
          issueNumber: 1,
          url: "https://github.com/acme/demo/issues/1",
        },
      });

      const tool = api.tools.get("fn_task_import_github_issue")!;
      vi.mocked(runGhJsonAsync).mockResolvedValueOnce({
        number: 1,
        title: "Issue one",
        body: "First issue body",
        html_url: "https://github.com/acme/demo/issues/1",
      } as never);

      const result = await tool.execute(
        "gh-2c",
        { owner: "acme", repo: "demo", issueNumber: 1 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.details).toMatchObject({ skipped: true, existingTaskId: existing.id });
      expect(result.content[0].text).toContain(existing.id);
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

pgTest("fn pi extension (runnable structured-output regression slice)", () => {
  let tmpDir: string;
  let api: MockApi;

  function createStore(): TaskStore {
    return h.store();
  }

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  beforeEach(async () => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
    vi.mocked(runTaskPlan).mockReset();

    tmpDir = h.rootDir();
    api = createMockApi();
    registerExtension(api);
    // FNXC:PostgresCutover: the PG task allocator defaults to the "KB" prefix;
    // pin "FN" so the historical hardcoded FN-001… assertions still hold.
    await h.store().updateSettings({ taskPrefix: "FN" });
  });

  // FNXC:PostgresCutover 2026-07-04-00:00:
  // The FN-6734/FN-6839 "close cached TaskStore handles before SQLite/WAL
  // fixture removal" regression was SQLite-specific (no WAL handles exist under
  // the PostgreSQL backend), so it was dropped with the cutover. Store and
  // cache lifecycle is now owned by the shared PG harness hooks wired above.

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

  describe("fn_task_list", () => {
    const HOST_SAFE_TASK_LIST_TEXT_CEILING = 3_000;

    function expectSingleBoundedTextBlock(result: ToolResult) {
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBeTruthy();
      expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
      expect(result.content[0].text.length).toBeLessThanOrEqual(HOST_SAFE_TASK_LIST_TEXT_CEILING);
    }

    function realisticTaskTitle(column: string, index: number) {
      return `${column} realistic task ${String(index).padStart(3, "0")} keeps enough descriptive context for text agents without artificial padding`;
    }

    it("returns bounded text for omitted and provided column/limit params", async () => {
      const store = createStore();
      try {
        await store.createTask({ description: "Planning task one" });
        await store.createTask({ description: "Todo task one", column: "todo" });
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      for (const [callId, params] of [
        ["list-all-default", {}],
        ["list-todo-default", { column: "todo" }],
        ["list-todo-large-limit", { column: "todo", limit: 50 }],
      ] as const) {
        const result = await listTool.execute(callId, params, undefined, undefined, makeCtx(tmpDir));
        expectSingleBoundedTextBlock(result);
        expect(result.details.count).toBe(2);
      }
    });

    it("returns explicit text for empty active-column filters on a non-empty board", async () => {
      const store = createStore();
      try {
        await store.createTask({ description: "Finished task keeps the board non-empty", column: "done" });
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      for (const column of ["triage", "todo", "in-progress", "in-review"] as const) {
        const result = await listTool.execute(
          `empty-${column}`,
          { column },
          undefined,
          undefined,
          makeCtx(tmpDir),
        );
        const text = result.content[0].text;

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
        expect(text).toBeTruthy();
        expect(text.trim()).not.toBe("");
        expect(text).toContain(COLUMN_LABELS[column]);
        expect(text).toContain(column);
        expect(result.details.count).toBe(1);
      }
    });

    it("keeps small column-filtered listings complete without the clamp marker", async () => {
      const store = createStore();
      try {
        const first = await store.createTask({ description: "Small todo task one", column: "todo" });
        await store.createTask({ description: "Small todo task two", column: "todo", dependencies: [first.id] });
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute(
        "list-small-todo",
        { column: "todo", limit: 50 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const text = result.content[0].text;

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
      expect(text).toBeTruthy();
      expect(text.trim()).not.toBe("");
      expect(text).toContain("Todo (2):");
      expect(text).toContain("FN-001");
      expect(text).toContain("FN-002");
      expect(text).toContain("[deps: FN-001]");
      expect(text).not.toContain("No tasks in Todo (todo).");
      expect(text).not.toContain("truncated to fit; narrow with column/limit");
      expect(result.details.count).toBe(2);
    });

    it("bounds realistic column-filtered listings below the host-safe text budget", async () => {
      const store = createStore();
      try {
        const todoFirst = await store.createTask({
          title: realisticTaskTitle("todo", 1),
          description: "Realistic todo task 001",
          column: "todo",
        });
        for (let i = 2; i <= 12; i += 1) {
          await store.createTask({
            title: `${realisticTaskTitle("todo", i)} ${"x".repeat(1_000)}`,
            description: `Realistic todo task ${String(i).padStart(3, "0")}`,
            column: "todo",
            dependencies: [todoFirst.id],
          });
        }
        for (let i = 1; i <= 8; i += 1) {
          await store.createTask({
            title: `${realisticTaskTitle("triage", i)} ${"x".repeat(1_000)}`,
            description: `Realistic triage task ${String(i).padStart(3, "0")}`,
          });
        }
        for (let i = 1; i <= 6; i += 1) {
          await store.createTask({
            title: `${realisticTaskTitle("done", i)} ${"x".repeat(1_000)}`,
            description: `Realistic done task ${String(i).padStart(3, "0")}`,
            column: "done",
          });
        }
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      const broadResult = await listTool.execute(
        "list-realistic-broad",
        { limit: 20 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      expectSingleBoundedTextBlock(broadResult);
      expect(broadResult.content.some((block: { type: string }) => block.type === "image")).toBe(false);
      expect(broadResult.content[0].text).toContain("Planning (8):");
      expect(broadResult.details.count).toBe(26);

      for (const { callId, params, header, ids } of [
        {
          callId: "list-realistic-todo",
          params: { column: "todo", limit: 12 },
          header: "Todo (12):",
          ids: ["FN-001", "FN-002"],
        },
        {
          callId: "list-realistic-triage",
          params: { column: "triage", limit: 8 },
          header: "Planning (8):",
          ids: ["FN-013", "FN-014"],
        },
        {
          callId: "list-realistic-done",
          params: { column: "done", limit: 6 },
          header: "Done (6):",
          ids: ["FN-021", "FN-022"],
        },
      ] as const) {
        const result = await listTool.execute(callId, params, undefined, undefined, makeCtx(tmpDir));
        const text = result.content[0].text;

        expectSingleBoundedTextBlock(result);
        expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
        expect(text).toContain(header);
        for (const id of ids) {
          expect(text).toContain(id);
        }
        expect(text).toContain("truncated to fit; narrow with column/limit");
        expect(result.details.count).toBe(26);
      }
    });

    it("bounds broad listings as a single plain-text block", async () => {
      const store = createStore();
      try {
        for (let i = 1; i <= 15; i += 1) {
          await store.createTask({
            title: `Planning task ${String(i).padStart(3, "0")} ${"x".repeat(1_600)}`,
            description: `Large planning task ${String(i).padStart(3, "0")}`,
          });
        }
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute(
        "list-large-broad",
        { limit: 10 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const text = result.content[0].text;

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
      expect(text).toBeTruthy();
      expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
      expect(text).toContain("Planning (15):");
      expect(text).toContain("FN-001");
      expect(text).toContain("truncated to fit; narrow with column/limit");
      expect(result.details.count).toBe(15);
    });

    /*
    FNXC:CliTests 2026-07-04-13:50:
    FN-7530 split the sibling "executes with @fusion/core resolved through the built dist barrel" case (formerly directly below this test) into packages/cli/src/__tests__/extension-dist-barrel.test.ts. That test's own in-test dist-barrel recompilation (vi.resetModules + vi.importActual of the built @fusion/core dist barrel) is CPU-bound and timeout-prone under 4-shard CI contention (FN-6483/FN-6705/FN-6795/FN-6839/FN-7447 same signature); isolating it kept the ~68 stable tests in this file on the default lane while only the isolated file carries its own quarantine entry. This test covers the identical truncation invariant against the source-aliased @fusion/core.
    */
    it("bounds large column-filtered listings as a single plain-text block", async () => {
      const store = createStore();
      try {
        const first = await store.createTask({
          title: `Todo task 001 ${"x".repeat(300)}`,
          description: "Large todo task 001",
          column: "todo",
        });
        for (let i = 2; i <= 20; i += 1) {
          await store.createTask({
            title: `Todo task ${String(i).padStart(3, "0")} ${"x".repeat(300)}`,
            description: `Large todo task ${String(i).padStart(3, "0")}`,
            column: "todo",
            dependencies: [first.id],
          });
        }
      } finally {
      }

      const listTool = api.tools.get("fn_task_list")!;
      const result = await listTool.execute(
        "list-large-todo",
        { column: "todo", limit: 20 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const text = result.content[0].text;

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content.some((block: { type: string }) => block.type === "image")).toBe(false);
      expect(text).toBeTruthy();
      expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
      expect(text).toContain("Todo (20):");
      expect(text).toContain("FN-001");
      expect(text).toContain("FN-002");
      expect(text).toContain("[deps: FN-001]");
      expect(text).toContain("truncated to fit; narrow with column/limit");
      expect(result.details.count).toBe(20);
    });

    // FNXC:PostgresCutover 2026-07-04-00:00:
    // The FN-6535 "resolve @fusion/core through the built dist barrel"
    // regression was removed: it forced a runtime `await import` of the dist
    // extension whose startup-factory applies the PG schema baseline from
    // dist/postgres/migrations/0000_initial.sql (not shipped in this dist), so
    // it could not bootstrap a PG store. The stale-dist-exports guard is
    // covered by the maintained extension-integration lane.
    it("degrades to bounded text when formatter exports are unavailable", () => {
      const boardLinesWithoutParams = [
        "Planning (2):",
        `  FN-001  Planning task ${"x".repeat(6_000)}`,
        `  FN-002  Planning task ${"x".repeat(6_000)}`,
        "",
      ];
      const boardLinesWithColumnAndLimit = [
        "Todo (2):",
        `  FN-003  Todo task ${"x".repeat(6_000)}`,
        "  ... and 1 more",
        "",
      ];

      /*
      FNXC:TaskListOutput 2026-06-17-07:32:
      FN-6573 exercises the resolver seam called by the CLI surface because the extension harness imports @fusion/core before per-test mocks can safely replace the large cross-package namespace with a stale dist missing only task-list formatter exports.
      These line sets mirror fn_task_list with params omitted and with column/limit provided, reproducing the prior missing `formatTaskListText` crash condition and the worse both-helpers-missing condition as bounded text instead of a throw.
      */
      const staleNamespaces = [
        { formatTaskListText: undefined, clampTaskListText: formatTaskListText },
        { formatTaskListText: undefined, clampTaskListText: undefined },
      ];
      for (const coreNamespace of staleNamespaces) {
        const formatter = resolveTaskListFormatter(coreNamespace);
        for (const lines of [boardLinesWithoutParams, boardLinesWithColumnAndLimit]) {
          const text = formatter(lines, { clamp: coreNamespace.clampTaskListText }).trimEnd();
          expect(text).toBeTruthy();
          expect(text.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
        }
      }
    });
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
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
    await agentStore.init();
    const reviewer = await agentStore.createAgent({ name: "reviewer", role: "reviewer" });

    const store = createStore();
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

    // FNXC:StateMachine 2026-07-07-12:00: FN-7641 Signature 2 CLI regression — nodeId='end'
    // must finalize-on-proof or return an explicit isError, never a silent "Updated" no-op
    // (NEXT-322 / NEXT-375 / NEXT-340).
    it("finalizes an in-review task to done when setting nodeId='end' with merge proof", async () => {
      // FNXC:PostgresCutover 2026-07-07-15:00: seed through the shared PG harness store
      // (upstream seeded via a throwaway sqlite TaskStore, which is removed on this branch).
      const store = createStore();
      const task = await store.createTask({ description: "out-of-band merge repro" });
      await store.updateTask(task.id, { steps: [{ name: "Only step", status: "done" }] });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "finalize-node-end",
        { id: task.id, nodeId: "end" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("show-finalized", { id: task.id }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.column).toBe("done");
      expect(show.details.task.nodeId).toBe("end");
    });

    it("returns an explicit isError instead of a silent no-op when setting nodeId='end' without merge proof", async () => {
      // FNXC:PostgresCutover 2026-07-07-15:00: seed through the shared PG harness store
      // (upstream seeded via a throwaway sqlite TaskStore, which is removed on this branch).
      const store = createStore();
      const task = await store.createTask({ description: "no proof repro" });
      await store.updateTask(task.id, { steps: [{ name: "Only step", status: "done" }] });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const updateTool = api.tools.get("fn_task_update")!;
      const result = await updateTool.execute(
        "reject-node-end",
        { id: task.id, nodeId: "end" },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain("merge");

      const showTool = api.tools.get("fn_task_show")!;
      const show = await showTool.execute("show-rejected", { id: task.id }, undefined, undefined, makeCtx(tmpDir));
      expect(show.details.task.column).toBe("in-review");
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

    it("moves merge-active missing-worktree session failures to todo with phantom metadata cleared", async () => {
      const store = createStore();
      await store.init();

      const task = await store.createTask({
        title: "missing-worktree merge-active task",
        description: "test",
        column: "todo",
      });
      await store.updateTask(task.id, {
        steps: [
          { name: "Step 0", status: "done" },
          { name: "Step 1", status: "pending" },
        ],
      });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "merging",
        error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
        worktree: "/tmp/fusion-missing-worktree",
        branch: `fusion/${task.id}`,
        sessionFile: "/tmp/fusion-session.json",
        mergeRetries: 3,
        worktreeSessionRetryCount: 3,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-missing-worktree-merge-active", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.worktree).toBeFalsy();
      expect(updated?.branch).toBeFalsy();
      expect(updated?.sessionFile).toBeFalsy();
      expect(updated?.steps[0].status).toBe("done");
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("rejects unrelated merge-active tasks", async () => {
      const store = createStore();
      await store.init();

      const task = await store.createTask({ title: "ordinary merge-active task", description: "test", column: "todo" });
      await store.updateTask(task.id, { steps: [{ name: "Step 0", status: "done" }] });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { status: "merging", error: "ordinary merge still running", mergeRetries: 2 });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-unrelated-merge-active", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not in a retryable state");
    });

    it("clears the deadlock auto-pause for execution-failed in-review retries", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "deadlock-paused execution-failed task",
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
        error: "executor stalled after deadlock pause",
        paused: true,
        pausedReason: "in-review-stall-deadlock",
        mergeRetries: 0,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-deadlock-exec", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.paused).toBeUndefined();
      expect(updated?.pausedReason).toBeUndefined();
      expect(updated?.steps[1].status).toBe("in-progress");
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("moves execution-failed in-review task (incomplete steps) to todo preserving progress", async () => {
      const store = createStore();

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
      const store = createStore();

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

    it("clears the deadlock auto-pause for merge-failed in-review retries", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "deadlock-paused merge-failed task",
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
        error: "merge deadlock",
        paused: true,
        pausedReason: "in-review-stall-deadlock",
        mergeRetries: 3,
        nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        ...nonZeroRetryCounters,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-deadlock-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("in-review");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("in-review");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.paused).toBeUndefined();
      expect(updated?.pausedReason).toBeUndefined();
      expectRetryCountersReset(updated);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("does not clear manual pauses for merge-failed in-review retries", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "user-paused merge-failed task",
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
        error: "merge deadlock",
        paused: true,
        pausedReason: "manual",
        mergeRetries: 3,
      });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-user-paused-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("in-review");

      const updated = await store.getTask(task.id);
      expect(updated?.paused).toBe(true);
      expect(updated?.pausedReason).toBe("manual");
      expect(updated?.status).toBeFalsy();
      expect(updated?.mergeRetries).toBe(0);
    });

    it("keeps merge-failed in-review task (all steps done) in in-review and resets merge state", async () => {
      const store = createStore();

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
      const store = createStore();

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

    it("moves status-none in-review task with incomplete steps to todo preserving progress", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "status-none execution-stalled task",
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
      await store.updateTask(task.id, { status: null, error: "stalled without failed status", mergeRetries: 5 });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-status-none-exec", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.steps[1].status).toBe("in-progress");
      expect(updated?.mergeRetries).toBe(5);
    });

    it("moves status-none zero-step in-review task with no merge attempts to todo", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "status-none zero-step execution-stalled task",
        description: "test",
        column: "todo",
      });
      await writeFile(join(tmpDir, ".fusion", "tasks", task.id, "PROMPT.md"), "# status-none zero-step execution-stalled task\n\nNo steps yet.\n");
      await store.updateTask(task.id, { steps: [] });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { status: null, error: "stalled before planning steps", mergeRetries: 0, steps: [] });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-status-none-zero-step-exec", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("todo");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.steps).toEqual([]);
      expect(updated?.mergeRetries).toBe(0);
    });

    it("keeps status-none in-review task with prior merge attempts in-review and resets merge state", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "status-none merge-stalled task",
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
      await store.updateTask(task.id, { status: null, error: "merge retry exhausted without failed status", mergeRetries: 2 });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-status-none-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBeFalsy();
      expect(result.details.newColumn).toBe("in-review");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("in-review");
      expect(updated?.status).toBeFalsy();
      expect(updated?.error).toBeFalsy();
      expect(updated?.mergeRetries).toBe(0);
    });

    it("rejects status-none in-review task with completed steps and no merge attempts", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "status-none completed task with no merge attempts",
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
      await store.updateTask(task.id, { status: null, mergeRetries: 0 });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-status-none-no-merge", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not in a retryable state");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("in-review");
      expect(updated?.mergeRetries).toBe(0);
    });

    it("rejects non-review task with status none", async () => {
      const store = createStore();

      const task = await store.createTask({
        title: "status-none todo task",
        description: "test",
        column: "todo",
      });
      await store.updateTask(task.id, { status: null, steps: [{ name: "Step 0", status: "pending" }] });

      const retryTool = api.tools.get("fn_task_retry")!;
      const result = await retryTool.execute("retry-status-none-todo", { id: task.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not in a retryable state");

      const updated = await store.getTask(task.id);
      expect(updated?.column).toBe("todo");
      expect(updated?.status).toBeFalsy();
    });

    it("moves non-review failed task to todo and resets all retry counters", async () => {
      const store = createStore();

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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
      await agentStore.init();
      await agentStore.createAgent({ name: "exec-agent", role: "executor", metadata: {} });
      await agentStore.createAgent({ name: "review-agent", role: "reviewer", metadata: {} });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-2", { role: "executor" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("exec-agent");
      expect(result.content[0].text).not.toContain("review-agent");
    });

    it("filters by state", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
      await agentStore.init();
      const active = await agentStore.createAgent({ name: "active-agent", role: "executor", metadata: {} });
      await agentStore.updateAgentState(active.id, "active");

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-3", { state: "active" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("active-agent");
      expect(result.details.agents.every((a: { state: string; id: string }) => a.state === "active")).toBe(true);
    });

    it("excludes ephemeral agents by default", async () => {
      const ephemeralId = await seedAgent(tmpDir, { ephemeral: true, name: "eph-agent" });
      await seedAgent(tmpDir, { name: "real-agent" });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-4", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).not.toContain("eph-agent");
      expect(result.content[0].text).toContain("real-agent");
      expect(result.details.agents.every((a: { state: string; id: string }) => a.id !== ephemeralId)).toBe(true);
    });

    it("surfaces error and pause diagnostics only for error/paused agents", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const errorAgent = await agentStore.createAgent({ name: "error-agent", role: "executor", metadata: {} });
      const pausedAgent = await agentStore.createAgent({ name: "paused-agent", role: "executor", metadata: {} });
      const healthyAgent = await agentStore.createAgent({ name: "healthy-agent", role: "executor", metadata: {} });
      await agentStore.updateAgentState(errorAgent.id, "error");
      await agentStore.updateAgent(errorAgent.id, {
        lastError: "Error: 401 Invalid authentication credentials with additional context that should be visible",
        metadata: { heartbeatErrorRecovery: { consecutiveAttempts: 2, updatedAt: "2026-07-12T18:20:00.000Z" } },
      });
      await agentStore.updateAgentState(pausedAgent.id, "paused");
      await agentStore.updateAgent(pausedAgent.id, {
        pauseReason: "error-retry-exhausted",
        metadata: { durableErrorRecovery: { attempts: 5, exhausted: true } },
      });
      await agentStore.updateAgentState(healthyAgent.id, "active");
      await agentStore.updateAgent(healthyAgent.id, { lastError: "stale hidden error", pauseReason: "stale hidden pause" });

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-diagnostics", {}, undefined, undefined, makeCtx(tmpDir));

      const text = result.content[0].text;
      expect(text).toMatch(/Name: error-agent[\s\S]*Last Error: Error: 401 Invalid authentication credentials/);
      expect(text).toMatch(/Name: error-agent[\s\S]*Error Recovery: attempts 2/);
      expect(text).toMatch(/Name: paused-agent[\s\S]*Pause Reason: error-retry-exhausted/);
      expect(text).toMatch(/Name: paused-agent[\s\S]*Error Recovery: attempts 5, exhausted/);
      const healthyBlock = text.split("Name: healthy-agent")[1]?.split("\n\n")[0] ?? "";
      expect(healthyBlock).not.toContain("Last Error:");
      expect(healthyBlock).not.toContain("Pause Reason:");
    });

    it("shows current task column context for parked, active, terminal, and missing links", async () => {
      const store = createStore();
      const triageTask = await store.createTask({ description: "Planning link", column: "triage" });
      const activeTask = await store.createTask({ description: "Active link", column: "in-progress" });
      const doneTask = await store.createTask({ description: "Done link", column: "done" });
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
      await agentStore.init();
      const triageAgent = await agentStore.createAgent({ name: "triage-linked", role: "executor", metadata: {} });
      const activeAgent = await agentStore.createAgent({ name: "active-linked", role: "executor", metadata: {} });
      const doneAgent = await agentStore.createAgent({ name: "done-linked", role: "executor", metadata: {} });
      const missingAgent = await agentStore.createAgent({ name: "missing-linked", role: "executor", metadata: {} });
      await agentStore.syncExecutionTaskLink(triageAgent.id, triageTask.id);
      await agentStore.syncExecutionTaskLink(activeAgent.id, activeTask.id);
      await agentStore.syncExecutionTaskLink(doneAgent.id, doneTask.id);
      await agentStore.syncExecutionTaskLink(missingAgent.id, "FN-404404");

      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-current-task-context", {}, undefined, undefined, makeCtx(tmpDir));

      const text = result.content[0].text;
      expect(text).toContain(`Current Task: ${triageTask.id} (triage)`);
      expect(text).toContain(`Current Task: ${activeTask.id} (in-progress)`);
      expect(text).toContain(`Current Task: ${doneTask.id} (not active — done)`);
      expect(text).toContain("Current Task: FN-404404 (unresolved)");
      expect(text).not.toMatch(new RegExp(`Current Task: ${triageTask.id}(?! \\()`));
    });

    it("returns empty list message when no agents", async () => {
      const tool = api.tools.get("fn_list_agents")!;
      const result = await tool.execute("la-5", {}, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("No agents found");
      expect(result.details.count).toBe(0);
    });
  });

  /*
  FNXC:MergeQueue 2026-07-15-11:28:
  Host extension no longer registers fn_research_*. See research-extension-tools.test.ts for the off-surface lock.
  */

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
      const store = createStore();
      const task = await store.getTask(result.details.taskId);
      expect(task).toBeTruthy();
      expect(task!.assignedAgentId).toBe(agentId);
      expect(task!.column).toBe("todo");
    });

    it("delegates task with workflow_id selected and materialized", async () => {
      const agentId = await seedAgent(tmpDir, { name: "delegate-workflow-target" });
      const workflowId = await seedWorkflow(tmpDir, "Delegate workflow");

      const tool = api.tools.get("fn_delegate_task")!;
      const result = await tool.execute(
        "dt-workflow",
        { agent_id: agentId, description: "Do workflow work", workflow_id: workflowId },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain(`(workflow: ${workflowId})`);
      const { task, selection } = await readTaskWorkflowState(tmpDir, result.details.taskId);
      expect(task.column).toBe("todo");
      expect(task.assignedAgentId).toBe(agentId);
      expect(selection?.workflowId).toBe(workflowId);
      expect(task.enabledWorkflowSteps).toHaveLength(2);
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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

      const store = createStore();
      const task = await store.getTask(result.details.taskId);
      expect(task.sourceMetadata).toMatchObject({ executorRoleOverride: true });

      const selected = await store.selectNextTaskForAgent(reviewer.id, { id: reviewer.id, role: reviewer.role });
      expect(selected?.task.id).toBe(task.id);
    });

    it("wires dependencies correctly", async () => {
      const agentId = await seedAgent(tmpDir, { name: "dep-agent" });

      // Create a real task to use as a dependency
      const store = createStore();
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

    it("surfaces lastError, pauseReason, and recovery counters", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
      await agentStore.init();
      const agent = await agentStore.createAgent({
        name: "diagnostic-agent",
        role: "executor",
        metadata: {
          heartbeatErrorRecovery: { consecutiveAttempts: 1, updatedAt: "2026-07-12T18:20:00.000Z" },
          durableErrorRecovery: { attempts: 3, nextRetryAt: "2026-07-12T18:30:00.000Z" },
        },
      });
      await agentStore.updateAgentState(agent.id, "error");
      await agentStore.updateAgent(agent.id, {
        lastError: "Error: 401 Invalid authentication credentials",
        pauseReason: "heartbeat-model-unavailable",
      });

      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-diagnostics", { id: agent.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("Last Error: Error: 401 Invalid authentication credentials");
      expect(result.content[0].text).toContain("Pause Reason: heartbeat-model-unavailable");
      expect(result.content[0].text).toContain("Error Recovery: attempts 3, next 2026-07-12T18:30:00.000Z");
    });

    it("omits empty diagnostic fields for healthy agents", async () => {
      const agentId = await seedAgent(tmpDir, { name: "healthy-show-agent" });

      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-no-diagnostics", { id: agentId }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).not.toContain("Last Error:");
      expect(result.content[0].text).not.toContain("Pause Reason:");
      expect(result.content[0].text).not.toContain("Error Recovery:");
    });

    it("shows current task column context for linked agents", async () => {
      const store = createStore();
      const triageTask = await store.createTask({ description: "Show linked task", column: "triage" });
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
      await agentStore.init();
      const agent = await agentStore.createAgent({ name: "show-linked", role: "executor", metadata: {} });
      await agentStore.syncExecutionTaskLink(agent.id, triageTask.id);

      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-current-task-context", { id: agent.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain(`Current Task: ${triageTask.id} (triage)`);
      expect(result.content[0].text).not.toMatch(new RegExp(`Current Task: ${triageTask.id}(?! \\()`));
    });

    it("returns error for unknown agent", async () => {
      const tool = api.tools.get("fn_agent_show")!;
      const result = await tool.execute("as-3", { id: "no-such-agent" }, undefined, undefined, makeCtx(tmpDir));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("shows reports-to and direct reports", async () => {
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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
      const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
      await agentStore.init();
      const lone = await agentStore.createAgent({ name: "lone-agent", role: "executor", metadata: {} });

      const tool = api.tools.get("fn_agent_org_chart")!;
      const result = await tool.execute("oc-4", { root_agent_id: lone.id }, undefined, undefined, makeCtx(tmpDir));

      expect(result.content[0].text).toContain("lone-agent");
    });
  });
});
