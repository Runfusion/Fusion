import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Column, Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { Column as BoardColumn } from "../Column";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import * as dashboardApi from "../../api";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  mockConfirm,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

setupTaskDetailModalHooks();

const noMoveLabels = /^(Move to|Back to|Done \(no merge\)|Move All to Todo)/;
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-198",
  title: "Remove task relocation",
  description: "Task used to prove dashboard lifecycle controls.",
  column: "in-progress" as Column,
  status: undefined,
  steps: [],
  currentStep: 0,
  dependencies: [],
  log: [],
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  ...overrides,
}) as Task;

const moveSpy = () => vi.fn(async () => task());
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"));
const expectNoMoveItems = () => {
  expect(menuItems().some((item) => noMoveLabels.test(item.textContent?.trim() ?? ""))).toBe(false);
};

function mockMobileViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: vi.fn() });
  }
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return () => {
    matchMediaSpy.mockRestore();
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("FN-198 dashboard task relocation removal", () => {
  it("removes board card destination choices while leaving manual-intake Start operational", async () => {
    const onMoveTask = moveSpy();
    const { rerender } = render(
      <TaskCard
        task={task()}
        onMoveTask={onMoveTask}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        taskMoveColumns={[
          { id: "in-progress", label: "In Progress", flags: { countsTowardWip: true } },
          { id: "in-review", label: "In Review", flags: { review: true } },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();

    rerender(
      <TaskCard
        task={task({ column: "ideas" as Column })}
        onMoveTask={onMoveTask}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        taskColumnFlags={{ intake: true, manualIntake: true }}
        taskMoveColumns={[
          { id: "ideas", label: "Ideas", flags: { intake: true, manualIntake: true } },
          { id: "implementation", label: "Implementation", flags: { countsTowardWip: true } },
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("card-start-FN-198"));
    });
    expect(onMoveTask).toHaveBeenLastCalledWith("FN-198", "implementation", { expectedColumn: "ideas" });
  });

  it("removes List row destination choices opened by a context click", async () => {
    const onMoveTask = moveSpy();
    writeBoardWorkflowsCache("project-fn-198", {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "todo", name: "Todo", flags: { hold: true } },
          { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
          { id: "in-review", name: "In Review", flags: { mergeBlocker: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      }],
      taskWorkflowIds: { "FN-198": "builtin:coding" },
    });
    render(
      <ListView
        tasks={[task()]}
        onMoveTask={onMoveTask}
        onDeleteTask={async () => task()}
        onMergeTask={async () => ({ merged: false })}
        onOpenDetail={noop}
        addToast={noop}
        projectId="project-fn-198"
      />,
    );

    await waitFor(() => expect(document.querySelector(".list-row[data-id='FN-198']")).toBeTruthy());
    const row = document.querySelector<HTMLElement>(".list-row[data-id='FN-198']");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 40, clientY: 40 });
    await waitFor(expectNoMoveItems);
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("opens no destination choice from a mobile card long-press when workflow metadata is absent", async () => {
    vi.useFakeTimers();
    try {
      const onMoveTask = moveSpy();
      const { container } = render(
        <TaskCard task={task()} onMoveTask={onMoveTask} onDeleteTask={noopDelete} onOpenDetail={noop} addToast={noop} />,
      );
      fireEvent.pointerDown(container.querySelector<HTMLElement>("[data-id='FN-198']")!, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expectNoMoveItems();
      expect(onMoveTask).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens no destination choice from a mobile List card long-press", async () => {
    vi.useFakeTimers();
    const restoreViewport = mockMobileViewport();
    try {
      const onMoveTask = moveSpy();
      writeBoardWorkflowsCache("project-fn-198-mobile", {
        flagEnabled: true,
        defaultWorkflowId: "builtin:coding",
        workflows: [{
          id: "builtin:coding",
          name: "Coding",
          columns: [
            { id: "todo", name: "Todo", flags: { hold: true } },
            { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
          ],
        }],
        taskWorkflowIds: { "FN-198": "builtin:coding" },
      });
      render(
        <ListView
          tasks={[task()]}
          onMoveTask={onMoveTask}
          onDeleteTask={async () => task()}
          onMergeTask={async () => ({ merged: false })}
          onOpenDetail={noop}
          addToast={noop}
          projectId="project-fn-198-mobile"
        />,
      );

      const card = document.querySelector<HTMLElement>(".list-card[data-id='FN-198']");
      expect(card).not.toBeNull();
      fireEvent.pointerDown(card!, { pointerType: "touch", pointerId: 1, clientX: 24, clientY: 32 });
      act(() => {
        vi.advanceTimersByTime(550);
      });
      expectNoMoveItems();
      expect(onMoveTask).not.toHaveBeenCalled();
    } finally {
      restoreViewport();
      vi.useRealTimers();
    }
  });

  it("keeps Task Detail Actions and review controls without a move dropdown in modal and embedded hosts", () => {
    const detailTask = makeTask({ id: "FN-198-review", column: "in-review" as Column });
    const modal = render(
      <TaskDetailModal
        initialTab="definition"
        task={detailTask}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge & Close" })).toBeInTheDocument();
    expect(modal.container.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
    modal.unmount();

    const embedded = render(
      <TaskDetailContent
        embedded
        initialTab="definition"
        task={makeTask({ id: "FN-198-embedded", column: "in-progress" as Column })}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(embedded.container.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
  });

  it("has no move affordance when List and Task Detail workflow metadata is absent", async () => {
    const onMoveTask = moveSpy();
    writeBoardWorkflowsCache("project-fn-198-no-metadata", {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "todo", name: "Todo", flags: { hold: true } },
          { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
        ],
      }],
      taskWorkflowIds: { "FN-198-no-metadata": "workflow-no-longer-available" },
    });
    render(
      <ListView
        tasks={[task({ id: "FN-198-no-metadata" })]}
        onMoveTask={onMoveTask}
        onDeleteTask={async () => task()}
        onMergeTask={async () => ({ merged: false })}
        onOpenDetail={noop}
        addToast={noop}
        projectId="project-fn-198-no-metadata"
      />,
    );
    await waitFor(() => expect(document.querySelector(".list-row[data-id='FN-198-no-metadata']")).toBeTruthy());
    fireEvent.contextMenu(document.querySelector<HTMLElement>(".list-row[data-id='FN-198-no-metadata']")!, { clientX: 40, clientY: 40 });
    await waitFor(expectNoMoveItems);
    expect(onMoveTask).not.toHaveBeenCalled();

    const detail = render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ id: "FN-198-detail-no-metadata", column: "in-progress" as Column })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(detail.container.querySelector(".detail-move-dropdown, .detail-move-btn, .detail-move-menu")).toBeNull();
  });

  it("has no recovery destination when a card's workflow no longer declares its column", () => {
    const onMoveTask = moveSpy();
    render(
      <TaskCard
        task={task({ column: "retired-column" as Column })}
        onMoveTask={onMoveTask}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        taskMoveColumns={[{ id: "in-progress", label: "In Progress", flags: { countsTowardWip: true } }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("keeps the card review action while removing every in-review destination item", () => {
    const onMoveTask = moveSpy();
    render(
      <TaskCard
        task={task({ column: "in-review" as Column })}
        onMoveTask={onMoveTask}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expect(screen.getByRole("menuitem", { name: "Merge & Close" })).toBeInTheDocument();
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it.each(["todo", "in-progress", "in-review", "done"] as const)("offers no move item on card or List rows in %s", async (column) => {
    const onMoveTask = moveSpy();
    const id = `FN-198-${column}`;
    const current = task({ id, column: column as Column });
    const card = render(
      <TaskCard
        task={current}
        onMoveTask={onMoveTask}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();
    card.unmount();
    writeBoardWorkflowsCache(`project-fn-198-${column}`, {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "todo", name: "Todo", flags: { hold: true } },
          { id: "in-progress", name: "In Progress", flags: { countsTowardWip: true } },
          { id: "in-review", name: "In Review", flags: { mergeBlocker: true } },
          { id: "done", name: "Done", flags: { complete: true } },
        ],
      }],
      taskWorkflowIds: { [id]: "builtin:coding" },
    });

    render(
      <ListView
        tasks={[current]}
        onMoveTask={onMoveTask}
        onDeleteTask={async () => current}
        onMergeTask={async () => ({ merged: false })}
        onOpenDetail={noop}
        addToast={noop}
        projectId={`project-fn-198-${column}`}
      />,
    );
    await waitFor(() => expect(document.querySelector(`.list-row[data-id='${id}']`)).toBeTruthy());
    fireEvent.contextMenu(document.querySelector<HTMLElement>(`.list-row[data-id='${id}']`)!, { clientX: 40, clientY: 40 });
    await waitFor(expectNoMoveItems);
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("does not leave a WIP card header shell when onMoveTask is its only action input", () => {
    const onMoveTask = moveSpy();
    const { container } = render(
      <TaskCard task={task()} onMoveTask={onMoveTask} onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector(".card-header-actions")).toBeNull();
    expect(container.querySelector(".card-menu-btn")).toBeNull();
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("keeps Stop All but no bulk relocation in processing and review column menus", () => {
    const onMoveTask = moveSpy();
    const props = {
      tasks: [task()],
      maxConcurrent: 2,
      onMoveTask,
      onOpenDetail: noop,
      addToast: noop,
      showWorktreeGrouping: false,
    };
    const processing = render(<BoardColumn {...props} column="in-progress" columnFlags={{ countsTowardWip: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /column actions/i }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeInTheDocument();
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();
    processing.unmount();

    render(<BoardColumn {...props} tasks={[task({ column: "in-review" as Column })]} column="in-review" columnFlags={{ humanReview: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /column actions/i }));
    expect(screen.getByRole("menuitem", { name: /Stop All/i })).toBeInTheDocument();
    expectNoMoveItems();
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("replans todo-like columns through the server-owned spec rebuild without moving cards", async () => {
    const onMoveTask = moveSpy();
    mockConfirm.mockResolvedValue(true);
    vi.spyOn(dashboardApi, "rebuildTaskSpec").mockResolvedValue(task({ column: "triage" as Column, status: "needs-replan" }));
    render(
      <BoardColumn
        tasks={[task({ column: "todo" as Column })]}
        column="todo"
        columnFlags={{ hold: true }}
        maxConcurrent={2}
        onMoveTask={onMoveTask}
        onOpenDetail={noop}
        addToast={noop}
        projectId="project-fn-198"
        showWorktreeGrouping={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /column actions/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Replan All/i }));
    });
    await waitFor(() => expect(dashboardApi.rebuildTaskSpec).toHaveBeenCalledWith("FN-198", "project-fn-198"));
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("disables empty bulk replans and reports a partial server-replan failure without moving cards", async () => {
    const onMoveTask = moveSpy();
    const empty = render(
      <BoardColumn
        tasks={[]}
        column="todo"
        columnFlags={{ hold: true }}
        maxConcurrent={2}
        onMoveTask={onMoveTask}
        onOpenDetail={noop}
        addToast={noop}
        showWorktreeGrouping={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /column actions/i }));
    expect(screen.getByRole("menuitem", { name: /Replan All/i })).toBeDisabled();
    empty.unmount();

    const addToast = vi.fn();
    vi.spyOn(dashboardApi, "rebuildTaskSpec")
      .mockResolvedValueOnce(task({ id: "FN-198-success" }))
      .mockRejectedValueOnce(new Error("replan failed"));
    render(
      <BoardColumn
        tasks={[task({ id: "FN-198-success", column: "todo" as Column }), task({ id: "FN-198-failed", column: "todo" as Column })]}
        column="todo"
        columnFlags={{ hold: true }}
        maxConcurrent={2}
        onMoveTask={onMoveTask}
        onOpenDetail={noop}
        addToast={addToast}
        projectId="project-fn-198-partial"
        showWorktreeGrouping={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /column actions/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Replan All/i }));
    });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/Replanned 1 of 2 tasks; 1 failed/i), "error"));
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("has no retained task-menu move model, detail move CSS, or Column move invocation", () => {
    const appRoot = resolve(__dirname, "../..");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist" ? [] : walk(path);
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    });
    const production = walk(appRoot).map((path) => [path, readFileSync(path, "utf8")] as const);

    for (const forbidden of ["buildTaskMoveMenuItems", "getTaskMoveTransitions", "moveTransitions", "taskDetail.move.moveTo", "taskDetail.move.moveToParent", "...(column.moveTargets ? { moveTargets: column.moveTargets } : {})"]) {
      expect(production.filter(([, source]) => source.includes(forbidden))).toEqual([]);
    }
    const componentMoveTargetMappers = production.filter(([path, source]) => path.includes("/components/") && /moveTargets\s*:/.test(source));
    expect(componentMoveTargetMappers).toEqual([]);
    const column = readFileSync(resolve(appRoot, "components/Column.tsx"), "utf8");
    expect(column).not.toMatch(/onMoveTask\s*\(/);
    expect(readFileSync(resolve(appRoot, "components/TaskDetailModal.css"), "utf8")).not.toContain(".detail-move-");
  });
});
