import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCard } from "@fusion/dashboard/app/components/TaskCard";
import { GraphTaskNode } from "../GraphTaskNode";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-TEST",
    description: "Task description",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    ...overrides,
  } as Task;
}

function createProps(task: Task) {
  return {
    task,
    position: { x: 0, y: 0 },
    scale: 1,
    onNodePositionChange: vi.fn(),
    onNodeDragStateChange: vi.fn(),
    projectId: "proj-1",
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    onUpdateTask: vi.fn(),
    onArchiveTask: vi.fn(),
    onUnarchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRetryTask: vi.fn(),
    onOpenDetailWithTab: vi.fn(),
    onMoveTask: vi.fn(),
    onOpenMission: vi.fn(),
    taskStuckTimeoutMs: 60_000,
    lastFetchTimeMs: Date.now(),
    workflowStepNameLookup: new Map<string, string>(),
  };
}

afterEach(() => {
  cleanup();
});

describe("GraphTaskNode", () => {
  it("renders a TaskCard and passes core props through", () => {
    const props = createProps(createTask());
    const { container } = render(<GraphTaskNode {...props} style={{ left: 10, top: 20 }} />);

    const node = screen.getByTestId("graph-task-node-FN-TEST");
    expect(node).toBeTruthy();
    expect(container.querySelector(".card-title")?.textContent).toContain("Task description");
    expect(node.getAttribute("draggable")).toBe("false");
    expect(container.querySelector(".card")?.getAttribute("draggable")).toBe("false");
  });

  it("shows active indicator with capitalized status for in-progress executing tasks", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [{ name: "step one", status: "in-progress" }],
      }),
    );

    const { container } = render(<GraphTaskNode {...props} />);
    const node = screen.getByTestId("graph-task-node-FN-TEST");
    expect(node.className).toContain("graph-task-node--active");
    expect(container.querySelector(".card")?.className).toContain("agent-active");
    expect(screen.getByText("Executing")).toBeTruthy();
    expect(container.querySelector(".graph-task-active-indicator")).toBeTruthy();
  });

  it("defaults indicator text to Executing when status is missing on in-progress tasks", () => {
    const props = createProps(createTask({ column: "in-progress", status: undefined }));
    const { container } = render(<GraphTaskNode {...props} />);

    expect(container.querySelector(".graph-task-active-indicator")).toBeTruthy();
    expect(screen.getByText("Executing")).toBeTruthy();
  });

  it("applies in-review visual class and does not apply active class for in-review tasks", () => {
    const props = createProps(createTask({ column: "in-review", status: "idle" }));
    const { container } = render(<GraphTaskNode {...props} />);

    const node = screen.getByTestId("graph-task-node-FN-TEST");
    expect(container.querySelector(".graph-task-active-indicator")).toBeFalsy();
    expect(node.className).toContain("graph-task-node--in-review");
    expect(node.className).not.toContain("graph-task-node--active");
  });

  it.each(["todo", "triage", "in-progress"] as const)("does not apply in-review class for %s tasks", (column) => {
    const props = createProps(createTask({ column, status: column === "in-progress" ? "executing" : "idle" }));

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").className).not.toContain("graph-task-node--in-review");
  });

  it("does not render active indicator for paused in-progress tasks", () => {
    const props = createProps(createTask({ column: "in-progress", status: "executing", paused: true }));
    const { container } = render(<GraphTaskNode {...props} />);

    expect(container.querySelector(".graph-task-active-indicator")).toBeFalsy();
  });

  it("does not render active indicator for failed in-progress tasks", () => {
    const props = createProps(createTask({ column: "in-progress", status: "failed" }));
    const { container } = render(<GraphTaskNode {...props} />);

    expect(container.querySelector(".graph-task-active-indicator")).toBeFalsy();
  });

  it("sets current-step attribute for active task when current step is valid", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [
          { name: "step one", status: "done" },
          { name: "step two", status: "done" },
          { name: "step three", status: "in-progress" },
        ],
        currentStep: 2,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").getAttribute("data-current-step")).toBe("2");
  });

  it("sets current-step attribute to zero when first step is active", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [{ name: "step one", status: "in-progress" }],
        currentStep: 0,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").getAttribute("data-current-step")).toBe("0");
  });

  it("omits current-step attribute when current step is out of bounds", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [{ name: "step one", status: "in-progress" }],
        currentStep: 10,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").hasAttribute("data-current-step")).toBe(false);
  });

  it("omits current-step attribute when current step is negative", () => {
    const props = createProps(createTask({ column: "in-progress", status: "executing", steps: [], currentStep: -1 }));

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").hasAttribute("data-current-step")).toBe(false);
  });

  it("omits current-step attribute when current step is undefined", () => {
    const props = createProps(createTask({ column: "in-progress", status: "executing", steps: [], currentStep: undefined }));

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").hasAttribute("data-current-step")).toBe(false);
  });

  it("does not set current-step for non-active tasks", () => {
    const props = createProps(
      createTask({
        column: "todo",
        status: "queued",
        steps: [{ name: "step one", status: "in-progress" }],
        currentStep: 0,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").hasAttribute("data-current-step")).toBe(false);
  });

  it("sets current-step to native step index when workflow steps are present", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [
          { id: "native-1", name: "native one", status: "done" },
          { id: "native-2", name: "native two", status: "in-progress" },
        ],
        enabledWorkflowSteps: ["wf-1"],
        currentStep: 1,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").getAttribute("data-current-step")).toBe("1");
  });

  it("does not set current-step when native step list is empty even with workflow steps", () => {
    const props = createProps(
      createTask({
        column: "in-progress",
        status: "executing",
        steps: [],
        enabledWorkflowSteps: ["wf-1"],
        currentStep: 0,
      }),
    );

    render(<GraphTaskNode {...props} />);
    expect(screen.getByTestId("graph-task-node-FN-TEST").hasAttribute("data-current-step")).toBe(false);
  });

  it("clicking card opens task detail", () => {
    const props = createProps(createTask());
    const { container } = render(<GraphTaskNode {...props} />);

    const card = container.querySelector(".card");
    expect(card).toBeTruthy();
    fireEvent.click(card!);
    expect(props.onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-TEST" }));
  });

  it("applies highlighted class only when requested", () => {
    const highlightedProps = createProps(createTask({ id: "FN-HL" }));
    const neutralProps = createProps(createTask({ id: "FN-NEUTRAL" }));

    const { unmount } = render(<GraphTaskNode {...highlightedProps} isHighlighted={true} />);
    expect(screen.getByTestId("graph-task-node-FN-HL").className).toContain("graph-task-node--highlighted");
    unmount();

    render(<GraphTaskNode {...neutralProps} />);
    const neutral = screen.getByTestId("graph-task-node-FN-NEUTRAL");
    expect(neutral.className).not.toContain("graph-task-node--highlighted");
    expect(neutral.className).not.toContain("graph-task-node--dimmed");
  });

  it("renders the same TaskCard structure as board usage", () => {
    const task = createTask({
      id: "FN-SAME",
      column: "in-progress",
      status: "executing",
      error: "Execution failed",
      missionId: "M-1",
      sourceType: "automation",
      sourceAgentId: "agent-1",
      steps: [{ name: "sync", status: "in-progress" }],
      currentStep: 0,
    });
    const props = createProps(task);

    const { container } = render(
      <div>
        <TaskCard {...props} disableDrag={true} />
        <GraphTaskNode {...props} />
      </div>,
    );

    const cards = container.querySelectorAll(".card");
    expect(cards.length).toBe(2);

    const [boardCard, graphCard] = cards;
    const selectors = [
      ".card-id",
      ".card-title",
      ".card-status-badge",
      ".card-step-dot",
      ".card-step-name",
      ".card-progress",
      ".card-progress-fill",
      ".card-error",
      ".card-mission-badge",
      ".card-provider-icons",
      ".card-agent-badge",
    ];

    for (const selector of selectors) {
      expect(Boolean(boardCard.querySelector(selector))).toBe(Boolean(graphCard.querySelector(selector)));
    }

    expect(Boolean(boardCard.querySelector(".card-error"))).toBe(Boolean(graphCard.querySelector(".card-error")));
    expect(boardCard.querySelector(".card-id")?.textContent).toBe(graphCard.querySelector(".card-id")?.textContent);
    expect(boardCard.querySelector(".card-title")?.textContent).toBe(graphCard.querySelector(".card-title")?.textContent);
  });
});
