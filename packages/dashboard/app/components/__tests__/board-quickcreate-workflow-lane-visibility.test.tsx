import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Task, TaskCreateInput } from "@fusion/core";
import { Board } from "../Board";
import { ListView } from "../ListView";
import type { BoardWorkflowsPayload } from "../../api";

const fetchBoardWorkflowsMock = vi.fn();
const fetchTaskDetailMock = vi.fn();
const batchUpdateTaskModelsMock = vi.fn();
const fetchNodesMock = vi.fn(() => new Promise(() => {}));

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
  promoteTask: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: (...args: unknown[]) => fetchTaskDetailMock(...args),
  batchUpdateTaskModels: (...args: unknown[]) => batchUpdateTaskModelsMock(...args),
  fetchNodes: (...args: unknown[]) => fetchNodesMock(...args),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../Column", () => ({
  Column: ({ column, tasks, onQuickCreate, workflowId, workflowMode }: {
    column: string;
    tasks: Task[];
    onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
    workflowId?: string;
    workflowMode?: boolean;
  }) => (
    <section data-testid={`column-${column}`} data-task-ids={JSON.stringify(tasks.map((task) => task.id))}>
      {tasks.map((task) => <article key={task.id}>{task.title}</article>)}
      {onQuickCreate ? (
        <button
          type="button"
          data-testid={`quick-create-${column}`}
          onClick={() => void onQuickCreate({
            title: `Created ${workflowId ?? "legacy"}`,
            description: `Created ${workflowId ?? "legacy"}`,
            column,
            ...(workflowMode && workflowId ? { workflowId } : {}),
          })}
        >
          Create in {column}
        </button>
      ) : null}
    </section>
  ),
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: ({ onCreate }: { onCreate?: (input: TaskCreateInput) => Promise<Task | void> }) => (
    <button
      type="button"
      data-testid="list-quick-create"
      onClick={() => void onCreate?.({ title: "Created from list", description: "Created from list" })}
    >
      Create list task
    </button>
  ),
}));

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: () => <div data-testid="task-detail-content" />,
}));

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: () => <div data-testid="custom-model-dropdown" />,
}));

const PROJECT_ID = "project-fn-6903";

const DEFAULT_WORKFLOW = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
    { id: "archived", name: "Archived", flags: { archived: true } },
  ],
};

const CUSTOM_WORKFLOW = {
  id: "wf-custom",
  name: "Custom Flow",
  columns: [
    { id: "intake", name: "Intake", flags: { intake: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

/*
FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
A task created under the Coding (Ideas) workflow (manual "ideas" intake, autoTriage:false) must render in the board's
"ideas" lane, not "triage" — mirrors the real builtin:coding-ideas workflow's intake column id/flag shape.
*/
const CODING_IDEAS_WORKFLOW = {
  id: "builtin:coding-ideas",
  name: "Coding (Ideas)",
  columns: [
    { id: "ideas", name: "Ideas", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
    { id: "archived", name: "Archived", flags: { archived: true } },
  ],
};

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "Task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

function workflowPayload(taskWorkflowIds: Record<string, string>, flagEnabled = true): BoardWorkflowsPayload {
  return {
    flagEnabled,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: flagEnabled ? [DEFAULT_WORKFLOW, CUSTOM_WORKFLOW, CODING_IDEAS_WORKFLOW] : [],
    taskWorkflowIds,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function readWorkflowCache(): BoardWorkflowsPayload | null {
  const raw = window.sessionStorage.getItem(`fusion:board-workflows:${PROJECT_ID}`);
  return raw ? JSON.parse(raw) as BoardWorkflowsPayload : null;
}

function selectWorkflow(workflowId: string) {
  fireEvent.click(screen.getByTestId("workflow-switcher"));
  fireEvent.click(screen.getByTestId(`workflow-switcher-option-${workflowId}`));
}

function BoardHarness({ createdTaskId = "FN-new", createReturnsTask = true, onCreateInput }: {
  createdTaskId?: string;
  createReturnsTask?: boolean;
  onCreateInput?: (input: TaskCreateInput) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const onQuickCreate = vi.fn(async (input: TaskCreateInput) => {
    onCreateInput?.(input);
    if (!createReturnsTask) return undefined;
    const task = mkTask({
      id: createdTaskId,
      title: input.title ?? input.description ?? createdTaskId,
      description: input.description ?? "Task",
      column: input.column ?? "triage",
    });
    setTasks((current) => [...current, task]);
    return task;
  });

  return (
    <Board
      tasks={tasks}
      projectId={PROJECT_ID}
      maxConcurrent={2}
      onMoveTask={vi.fn()}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      onQuickCreate={onQuickCreate}
      onNewTask={vi.fn()}
      autoMerge
      onToggleAutoMerge={vi.fn()}
      workflowColumnsEnabled
      settingsLoaded
    />
  );
}

function ListHarness({ createdTaskId = "FN-new", createReturnsTask = true, onCreateInput }: {
  createdTaskId?: string;
  createReturnsTask?: boolean;
  onCreateInput?: (input: TaskCreateInput) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const onQuickCreate = vi.fn(async (input: TaskCreateInput) => {
    onCreateInput?.(input);
    if (!createReturnsTask) return undefined;
    const task = mkTask({
      id: createdTaskId,
      title: input.title ?? input.description ?? createdTaskId,
      description: input.description ?? "Task",
      column: input.column ?? "triage",
    });
    setTasks((current) => [...current, task]);
    return task;
  });

  return (
    <ListView
      tasks={tasks}
      projectId={PROJECT_ID}
      onMoveTask={vi.fn()}
      onDeleteTask={vi.fn()}
      onMergeTask={vi.fn()}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      onQuickCreate={onQuickCreate}
      workflowColumnsEnabled
      settingsLoaded
    />
  );
}

beforeEach(() => {
  fetchBoardWorkflowsMock.mockReset();
  fetchTaskDetailMock.mockReset();
  batchUpdateTaskModelsMock.mockReset();
  fetchNodesMock.mockClear();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("workflow lane quick-create visibility", () => {
  it.each([
    ["Board", BoardHarness, () => fireEvent.click(screen.getByTestId("quick-create-intake")), "Created wf-custom"],
    ["ListView", ListHarness, () => fireEvent.click(screen.getByTestId("list-quick-create")), "Created from list"],
  ] as const)("%s shows a task created in a non-default workflow lane before the board-workflows refetch resolves", async (_surface, Harness, create, title) => {
    const refetch = deferred<BoardWorkflowsPayload>();
    fetchBoardWorkflowsMock
      .mockResolvedValueOnce(workflowPayload({}))
      .mockResolvedValueOnce(workflowPayload({}))
      .mockReturnValueOnce(refetch.promise);

    render(<Harness />);
    await screen.findByTestId("workflow-switcher");
    selectWorkflow(CUSTOM_WORKFLOW.id);

    await act(async () => {
      create();
    });

    expect(screen.getByText(title)).toBeTruthy();
    expect(readWorkflowCache()?.taskWorkflowIds["FN-new"]).toBe(CUSTOM_WORKFLOW.id);
    expect(fetchBoardWorkflowsMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      refetch.resolve(workflowPayload({ "FN-new": CUSTOM_WORKFLOW.id }));
      await refetch.promise;
    });

    expect(screen.getByText(title)).toBeTruthy();
  });

  it.each([
    ["Board", BoardHarness, () => fireEvent.click(screen.getByTestId("quick-create-triage")), "Created builtin:coding"],
    ["ListView", ListHarness, () => fireEvent.click(screen.getByTestId("list-quick-create")), "Created from list"],
  ] as const)("%s keeps default workflow quick-create visible immediately", async (_surface, Harness, create, title) => {
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({}));

    render(<Harness />);
    await screen.findByTestId("workflow-switcher");

    await act(async () => {
      create();
    });

    expect(screen.getByText(title)).toBeTruthy();
  });

  it("Board renders a task created under the Coding (Ideas) workflow in the ideas lane", async () => {
    const refetch = deferred<BoardWorkflowsPayload>();
    fetchBoardWorkflowsMock
      .mockResolvedValueOnce(workflowPayload({}))
      .mockResolvedValueOnce(workflowPayload({}))
      .mockReturnValueOnce(refetch.promise);

    render(<BoardHarness />);
    await screen.findByTestId("workflow-switcher");
    selectWorkflow(CODING_IDEAS_WORKFLOW.id);

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-create-ideas"));
    });

    const ideasColumn = screen.getByTestId("column-ideas");
    expect(within(ideasColumn).getByText("Created builtin:coding-ideas")).toBeTruthy();
    expect(JSON.parse(ideasColumn.getAttribute("data-task-ids") ?? "[]")).toContain("FN-new");

    await act(async () => {
      refetch.resolve(workflowPayload({ "FN-new": CODING_IDEAS_WORKFLOW.id }));
      await refetch.promise;
    });

    expect(within(screen.getByTestId("column-ideas")).getByText("Created builtin:coding-ideas")).toBeTruthy();
  });

  it("leaves the legacy flag-off Board quick-create path unchanged", async () => {
    const inputs: TaskCreateInput[] = [];
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({}, false));

    render(<BoardHarness onCreateInput={(input) => inputs.push(input)} />);
    await waitFor(() => expect(screen.getByTestId("quick-create-triage")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-create-triage"));
    });

    expect(screen.getByText("Created legacy")).toBeTruthy();
    expect(inputs[0]?.workflowId).toBeUndefined();
  });

  it.each([
    ["Board", BoardHarness, () => fireEvent.click(screen.getByTestId("quick-create-intake"))],
    ["ListView", ListHarness, () => fireEvent.click(screen.getByTestId("list-quick-create"))],
  ] as const)("%s does not crash or merge when quick-create resolves void", async (_surface, Harness, create) => {
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({}));

    render(<Harness createReturnsTask={false} />);
    await screen.findByTestId("workflow-switcher");
    selectWorkflow(CUSTOM_WORKFLOW.id);

    await act(async () => {
      create();
    });

    expect(screen.queryByText(/Created/)).toBeNull();
    expect(readWorkflowCache()?.taskWorkflowIds["FN-new"]).toBeUndefined();
  });

  it("does not overwrite a server-raced taskWorkflowIds entry in the Board cache", async () => {
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ "FN-new": DEFAULT_WORKFLOW.id }));

    render(<BoardHarness />);
    await screen.findByTestId("workflow-switcher");
    selectWorkflow(CUSTOM_WORKFLOW.id);

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-create-intake"));
    });

    expect(within(screen.getByTestId("column-intake")).queryByText("Created wf-custom")).toBeNull();
    expect(readWorkflowCache()?.taskWorkflowIds["FN-new"]).toBe(DEFAULT_WORKFLOW.id);
  });
});
