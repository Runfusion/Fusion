import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { Board } from "../Board";
import { FloatingWindow } from "../FloatingWindow";
import { TaskDetailContent } from "../TaskDetailModal";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";

const noop = () => {};
const noopAsync = async () => ({} as Task);

const workflowPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{
    id: "builtin:coding",
    name: "Coding",
    columns: [
      { id: "triage", name: "Planning", flags: { intake: true } },
      { id: "todo", name: "Todo", flags: { hold: true } },
      { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
      { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  }],
  taskWorkflowIds: { "FN-TITLE-FLICKER": "builtin:coding" },
};

const task = {
  id: "FN-TITLE-FLICKER",
  title: "Production card title",
  description: "Production card description",
  column: "todo",
  status: "pending",
  prompt: "",
  steps: [],
  attachments: [],
  dependencies: [],
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
} as Task;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  writeBoardWorkflowsCache(undefined, workflowPayload);
});

/*
FNXC:BoardNavigation 2026-08-21-23:02:
FN-115's required Chromium lane uses production CSS selectors rather than mock-only test IDs.
Keep this in-memory contract on every runner so a selector drift fails before a browser-capable
runner is needed to prove native pointer-capture delivery.
*/
describe("Board card-detail Chromium locator contract", () => {
  it("renders the production Board, Column, and TaskCard selectors exactly once", () => {
    const { container } = render(
      <Board
        tasks={[task]}
        maxConcurrent={2}
        onMoveTask={noopAsync}
        onOpenDetail={noop}
        addToast={noop}
        onQuickCreate={noopAsync}
        onNewTask={noop}
        autoMerge
        onToggleAutoMerge={noop}
        planAutoApproveEnabled={false}
        onTogglePlanAutoApprove={noop}
        globalPaused={false}
      />,
    );

    expect(container.querySelectorAll("main.board-workflow-columns")).toHaveLength(1);
    expect(container.querySelectorAll(".card[data-id='FN-TITLE-FLICKER'] .card-title")).toHaveLength(1);
  });

  it("uses TaskDetailContent's embedded close control in the headerless popup", () => {
    const { container } = render(
      <FloatingWindow
        windowKey="fn-115-locator-contract"
        title="Task detail"
        onClose={noop}
        hideHeader
        className="floating-window--task-detail"
      >
        <TaskDetailContent
          task={task}
          onMoveTask={noopAsync}
          onDeleteTask={noopAsync}
          onMergeTask={async () => ({ success: true } as never)}
          onOpenDetail={noop}
          addToast={noop}
          embedded
          onRequestClose={noop}
        />
      </FloatingWindow>,
    );

    const popup = document.querySelectorAll(".floating-window--task-detail");
    const close = document.querySelectorAll(".floating-window--task-detail button[aria-label='Close']");
    expect(popup).toHaveLength(1);
    expect(close).toHaveLength(1);
    expect(close[0]).toHaveClass("modal-close", "task-detail-floating-close");
    expect(container.querySelector(".floating-window__close")).toBeNull();
  });
});
