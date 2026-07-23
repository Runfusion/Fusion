import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MAX_TASK_LIST_TEXT_CHARS, type AgentPermissionPolicy, type Task, type TaskDetail, type TaskStore } from "@fusion/core";
import { createPlanningBoardTools } from "../../../dashboard/src/planning-board-tools.js";
import { createTaskReadTools } from "../agent-tools.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { evaluateAgentActionGate } from "../agents/agent-action-gate.js";
import { COORDINATION_EXEMPT_TOOLS, READONLY_FN_TOOLS } from "../execution/gating-classifications.js";
import { classifyPermanentAgentToolCall } from "../agents/permanent-agent-gating.js";
import { TriageProcessor } from "../triage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const lockedDownPolicy: AgentPermissionPolicy = {
  presetId: "locked-down",
  rules: {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
  },
};

type TaskReadResult = Awaited<ReturnType<ReturnType<typeof createTaskReadTools>[number]["execute"]>>;

function textOf(result: TaskReadResult): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]).toMatchObject({ type: "text" });
  const text = result.content[0]?.text ?? "";
  expect(text.trim().length).toBeGreaterThan(0);
  return text;
}

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? `Description for ${overrides.id}`,
    column: overrides.column ?? "todo",
    dependencies: overrides.dependencies ?? [],
    steps: overrides.steps ?? [],
    currentStep: overrides.currentStep ?? 0,
    ...overrides,
  } as Task;
}

function taskDetail(overrides: Partial<TaskDetail> & Pick<TaskDetail, "id">): TaskDetail {
  return {
    ...task(overrides),
    prompt: overrides.prompt ?? "# Prompt body",
  } as TaskDetail;
}

function createStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    listTasks: vi.fn(async () => []),
    searchTasks: vi.fn(async () => []),
    getTask: vi.fn(async (id: string) => taskDetail({ id })),
    getSettings: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name);
}

function extractRegisteredCliTaskReadNames(): string[] {
  const source = readFileSync(resolve(__dirname, "../../../cli/src/extension.ts"), "utf8");
  return [...source.matchAll(/name:\s*"(fn_task_(?:list|show|search|get))"/g)].map((match) => match[1]!);
}

describe("shared task read tools", () => {
  it("returns the canonical heartbeat task-read names in order", () => {
    expect(toolNames(createTaskReadTools(createStore()))).toEqual([
      "fn_task_list",
      "fn_task_show",
      "fn_task_search",
    ]);
  });

  it("returns non-empty bounded text for empty, populated, no-match, and oversized boards", async () => {
    const emptyTools = createTaskReadTools(createStore());
    expect(textOf(await emptyTools[0]!.execute("list-empty", {}))).toBe("No active tasks.");
    expect(textOf(await emptyTools[2]!.execute("search-empty", { query: "missing" }))).toBe("No tasks matched.");

    const populatedStore = createStore({
      listTasks: vi.fn(async () => [
        task({ id: "FN-001", title: "Active task", column: "todo", dependencies: ["FN-000"] }),
        task({ id: "FN-002", title: "Done task", column: "done" }),
      ]),
      searchTasks: vi.fn(async () => [task({ id: "FN-003", title: "Search hit", column: "done" })]),
      getTask: vi.fn(async () => taskDetail({ id: "FN-004", title: "Show me", prompt: "# Prompt" })),
    });
    const populatedTools = createTaskReadTools(populatedStore);
    const listText = textOf(await populatedTools[0]!.execute("list-populated", {}));
    expect(listText).toContain("FN-001 (todo): Active task [deps: FN-000]");
    expect(listText).not.toContain("FN-002");
    expect(textOf(await populatedTools[1]!.execute("show-populated", { id: "FN-004" }))).toContain("PROMPT.md:");
    expect(textOf(await populatedTools[2]!.execute("search-populated", { query: "search", includeDone: true }))).toContain("FN-003 (done): Search hit");

    const oversizedTasks = Array.from({ length: 120 }, (_, index) => task({
      id: `FN-${String(index + 100).padStart(3, "0")}`,
      title: `Oversized ${index} ${"x".repeat(120)}`,
      column: "todo",
    }));
    const oversizedStore = createStore({
      listTasks: vi.fn(async () => oversizedTasks),
      searchTasks: vi.fn(async () => oversizedTasks),
    });
    const oversizedTools = createTaskReadTools(oversizedStore);
    const oversizedListText = textOf(await oversizedTools[0]!.execute("list-oversized", {}));
    const oversizedSearchText = textOf(await oversizedTools[2]!.execute("search-oversized", { query: "oversized" }));
    expect(oversizedListText.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
    expect(oversizedSearchText.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
    expect(oversizedListText).toContain("truncated to fit");
  });

  it("exposes task reads through the shared heartbeat helper and task-scoped heartbeat tools", () => {
    const monitor = new HeartbeatMonitor({ store: {} as never, taskStore: createStore(), rootDir: "/tmp/fn-test" });
    const sharedNames = toolNames((monitor as unknown as { createSharedHeartbeatWorkTools: (store: TaskStore) => Array<{ name: string }> }).createSharedHeartbeatWorkTools(createStore()));
    expect(sharedNames.slice(0, 3)).toEqual(["fn_task_list", "fn_task_show", "fn_task_search"]);

    const taskScopedNames = toolNames(monitor.createHeartbeatTools("agent-1", createStore(), "FN-001"));
    expect(taskScopedNames).toEqual(expect.arrayContaining(["fn_task_list", "fn_task_show", "fn_task_search"]));
  });

  it("positively classifies all task-read names as read-only", () => {
    for (const toolName of ["fn_task_search", "fn_task_get", "fn_task_list", "fn_task_show"] as const) {
      expect(READONLY_FN_TOOLS.has(toolName)).toBe(true);
      expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes(toolName)).toBe(true);
      expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
      const decision = evaluateAgentActionGate({ agentId: "agent-1", toolName, args: {}, permissionPolicy: lockedDownPolicy });
      expect(decision).toMatchObject({ disposition: "allow", category: "exempt", operation: toolName });
    }
  });

  it("pins per-surface task-read tool name parity on canonical fn_task_show", () => {
    const triageProcessor = new TriageProcessor(createStore() as never, "/tmp/fn-test");
    const triageNames = toolNames((triageProcessor as unknown as { createTriageTools: (opts: unknown) => Array<{ name: string }> }).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    })).filter((name) => name.startsWith("fn_task_") && name !== "fn_task_create");

    const surfaces = {
      triage: triageNames,
      planningBoard: toolNames(createPlanningBoardTools(createStore())).filter((name) => name.startsWith("fn_task_")),
      cliExtension: extractRegisteredCliTaskReadNames(),
      sharedFactory: toolNames(createTaskReadTools(createStore())),
    };

    expect(surfaces).toEqual({
      triage: ["fn_task_list", "fn_task_search", "fn_task_show"],
      planningBoard: ["fn_task_list", "fn_task_show"],
      cliExtension: ["fn_task_list", "fn_task_show"],
      sharedFactory: ["fn_task_list", "fn_task_show", "fn_task_search"],
    });
    const deprecatedGetName = ["fn_task", "get"].join("_");
    for (const names of Object.values(surfaces)) {
      expect(names).toContain("fn_task_show");
      expect(names).not.toContain(deprecatedGetName);
    }
  });
});
