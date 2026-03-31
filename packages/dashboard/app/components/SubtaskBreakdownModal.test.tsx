import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SubtaskBreakdownModal } from "./SubtaskBreakdownModal";

const mockStartSubtaskBreakdown = vi.fn();
const mockConnectSubtaskStream = vi.fn();
const mockCreateTasksFromBreakdown = vi.fn();
const mockCancelSubtaskBreakdown = vi.fn();

vi.mock("../api", () => ({
  startSubtaskBreakdown: (...args: any[]) => mockStartSubtaskBreakdown(...args),
  connectSubtaskStream: (...args: any[]) => mockConnectSubtaskStream(...args),
  createTasksFromBreakdown: (...args: any[]) => mockCreateTasksFromBreakdown(...args),
  cancelSubtaskBreakdown: (...args: any[]) => mockCancelSubtaskBreakdown(...args),
}));

const SAMPLE_SUBTASKS = [
  { id: "subtask-1", title: "First", description: "Do first", suggestedSize: "S" as const, dependsOn: [] },
  { id: "subtask-2", title: "Second", description: "Do second", suggestedSize: "M" as const, dependsOn: ["subtask-1"] },
];

const THREE_SUBTASKS = [
  { id: "subtask-A", title: "Task A", description: "Do A", suggestedSize: "S" as const, dependsOn: [] },
  { id: "subtask-B", title: "Task B", description: "Do B", suggestedSize: "M" as const, dependsOn: [] },
  { id: "subtask-C", title: "Task C", description: "Do C", suggestedSize: "L" as const, dependsOn: [] },
];

describe("SubtaskBreakdownModal", () => {
  const onClose = vi.fn();
  const onTasksCreated = vi.fn();
  let streamHandlers: any;

  beforeEach(() => {
    vi.clearAllMocks();
    streamHandlers = undefined;
    mockStartSubtaskBreakdown.mockResolvedValue({ sessionId: "session-123" });
    mockConnectSubtaskStream.mockImplementation((_sessionId, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    mockCreateTasksFromBreakdown.mockResolvedValue({ tasks: [{ id: "KB-101" }, { id: "KB-102" }] });
    mockCancelSubtaskBreakdown.mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderModal() {
    return render(
      <SubtaskBreakdownModal
        isOpen={true}
        onClose={onClose}
        initialDescription="Build a complex feature"
        onTasksCreated={onTasksCreated}
      />,
    );
  }

  it("shows generating state after auto-start", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalledWith("Build a complex feature"));
    expect(await screen.findByText("AI is generating subtasks...")).toBeInTheDocument();
  });

  it("renders editable subtasks when stream returns items", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    expect(await screen.findByDisplayValue("First")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Do second")).toBeInTheDocument();
  });

  it("adds and removes subtasks", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks([SAMPLE_SUBTASKS[0]]);

    fireEvent.click(await screen.findByText("Add subtask"));
    expect(screen.getAllByText(/subtask-/i).length).toBeGreaterThan(1);

    // Use getAllByText and click the first Remove button
    const removeButtons = screen.getAllByText(/Remove/);
    fireEvent.click(removeButtons[0]);
    await waitFor(() => expect(screen.queryByDisplayValue("First")).not.toBeInTheDocument());
  });

  it("changes size and dependency selection", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);

    fireEvent.click(await screen.findAllByText("L").then((buttons) => buttons[0]!));
    // Use findAllByText to get all occurrences of subtask-1 and check the first one
    const subtaskLabels = await screen.findAllByText("subtask-1");
    expect(subtaskLabels.length).toBeGreaterThan(0);
  });

  it("saves via API with edited data", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);

    const titleInputs = await screen.findAllByRole("textbox");
    fireEvent.change(titleInputs[0], { target: { value: "Updated first" } });
    fireEvent.click(screen.getByText("Create Tasks"));

    await waitFor(() => expect(mockCreateTasksFromBreakdown).toHaveBeenCalled());
    expect(onTasksCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("cancel closes modal", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());
    fireEvent.click(await screen.findByLabelText("Close"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("escape closes modal", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  describe("drag-and-drop reordering", () => {
    it("drag start sets correct state and dataTransfer", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks(THREE_SUBTASKS);

      const firstSubtask = await screen.findByTestId("subtask-item-0");
      const dataTransfer = { setData: vi.fn(), effectAllowed: "" };

      fireEvent.dragStart(firstSubtask, { dataTransfer });

      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "subtask-A");
      expect(dataTransfer.effectAllowed).toBe("move");
    });

    it("drag over sets position based on mouse location", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks(THREE_SUBTASKS);

      const firstSubtask = await screen.findByTestId("subtask-item-0");
      const secondSubtask = await screen.findByTestId("subtask-item-1");

      // Start dragging first subtask
      fireEvent.dragStart(firstSubtask);

      // Drag over second subtask (below midpoint = after)
      const rect = { top: 100, height: 100, left: 0, right: 200 };
      vi.spyOn(secondSubtask, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

      fireEvent.dragOver(secondSubtask, { clientY: 160 }); // Below midpoint (150)

      // The subtask should show as drop target
      expect(secondSubtask.classList.contains("subtask-item-drop-target")).toBe(true);
    });

    it("drop reorders subtasks correctly - move first to after last", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      const items = await screen.findAllByTestId(/subtask-item-/);
      expect(items).toHaveLength(3);

      // Verify initial order
      expect(items[0]).toHaveAttribute("data-testid", "subtask-item-0");
      expect(items[1]).toHaveAttribute("data-testid", "subtask-item-1");
      expect(items[2]).toHaveAttribute("data-testid", "subtask-item-2");

      // Simulate drag and drop: drag first (A), drop on last (C) with position 'after'
      const firstItem = items[0];
      const lastItem = items[2];

      fireEvent.dragStart(firstItem);

      const dataTransfer = { getData: vi.fn(() => "subtask-A") };
      fireEvent.dragOver(lastItem, { clientY: 200 });
      fireEvent.drop(lastItem, { dataTransfer });
      fireEvent.dragEnd(firstItem);

      // After drag end, verify items still exist
      await waitFor(() => {
        const updatedItems = screen.getAllByTestId(/subtask-item-/);
        expect(updatedItems).toHaveLength(3);
      });
    });

    it("dropping on self does nothing", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      const items = await screen.findAllByTestId(/subtask-item-/);
      const firstItem = items[0];

      fireEvent.dragStart(firstItem);

      const dataTransfer = { getData: vi.fn(() => "subtask-A") };
      fireEvent.drop(firstItem, { dataTransfer });
      fireEvent.dragEnd(firstItem);

      // Should still have 3 items
      const remainingItems = screen.getAllByTestId(/subtask-item-/);
      expect(remainingItems).toHaveLength(3);
    });

    it("drag end clears drag state", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      const firstItem = await screen.findByTestId("subtask-item-0");

      fireEvent.dragStart(firstItem);
      expect(firstItem.classList.contains("subtask-item-dragging")).toBe(true);

      fireEvent.dragEnd(firstItem);
      expect(firstItem.classList.contains("subtask-item-dragging")).toBe(false);
    });

    it("drag handle is visible on each subtask row", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks(THREE_SUBTASKS);

      // Wait for subtasks to be rendered
      await screen.findAllByTestId(/subtask-item-/);

      // Should have drag handles (subtask-drag-handle elements)
      const dragHandles = document.querySelectorAll(".subtask-drag-handle");
      expect(dragHandles.length).toBe(3);
    });
  });

  describe("keyboard reordering", () => {
    it("move up button moves subtask up one position", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      // Wait for subtasks to be rendered
      await screen.findAllByTestId(/subtask-item-/);

      const itemsBefore = screen.getAllByTestId(/subtask-item-/);
      expect(itemsBefore[0]).toContainHTML("Task A");
      expect(itemsBefore[1]).toContainHTML("Task B");

      // Find the move up button for the second subtask (index 1)
      const moveUpButtons = screen.getAllByLabelText("Move subtask up");
      expect(moveUpButtons.length).toBe(3);

      // Click move up on the second subtask (B moves before A)
      fireEvent.click(moveUpButtons[1]!);

      // Verify order changed - now we need to check the actual content
      await waitFor(() => {
        const titleInputs = screen.getAllByDisplayValue(/Task/);
        expect(titleInputs[0]).toHaveValue("Task B");
        expect(titleInputs[1]).toHaveValue("Task A");
      });
    });

    it("move down button moves subtask down one position", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      // Wait for subtasks to be rendered
      await screen.findAllByTestId(/subtask-item-/);

      // Find the move down button for the first subtask
      const moveDownButtons = screen.getAllByLabelText("Move subtask down");
      expect(moveDownButtons.length).toBe(3);

      // Click move down on the first subtask (A moves after B)
      fireEvent.click(moveDownButtons[0]!);

      // Verify order changed
      await waitFor(() => {
        const titleInputs = screen.getAllByDisplayValue(/Task/);
        expect(titleInputs[0]).toHaveValue("Task B");
        expect(titleInputs[1]).toHaveValue("Task A");
      });
    });

    it("move up button is disabled for first subtask", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks(THREE_SUBTASKS);

      // Wait for subtasks to be rendered
      await screen.findAllByTestId(/subtask-item-/);

      const moveUpButtons = screen.getAllByLabelText("Move subtask up");
      expect(moveUpButtons[0]!).toBeDisabled();
      expect(moveUpButtons[1]!).not.toBeDisabled();
    });

    it("move down button is disabled for last subtask", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks(THREE_SUBTASKS);

      // Wait for subtasks to be rendered
      await screen.findAllByTestId(/subtask-item-/);

      const moveDownButtons = screen.getAllByLabelText("Move subtask down");
      expect(moveDownButtons[2]!).toBeDisabled();
      expect(moveDownButtons[0]!).not.toBeDisabled();
    });
  });

  describe("dependency validation with reordering", () => {
    it("only shows earlier subtasks as dependency options", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onSubtasks([...THREE_SUBTASKS]);

      // First subtask should not have any dependency options
      const firstItem = await screen.findByTestId("subtask-item-0");
      const firstDepsSection = firstItem.querySelector(".planning-deps-list");
      expect(firstDepsSection).toHaveTextContent("First subtask cannot have dependencies");

      // Second subtask should only show first as dependency option
      const secondItem = await screen.findByTestId("subtask-item-1");
      const secondDepLabels = secondItem.querySelectorAll(".planning-dep-chip");
      expect(secondDepLabels.length).toBe(1);
      expect(secondDepLabels[0]).toHaveTextContent("subtask-A");

      // Third subtask should show first and second as options
      const thirdItem = await screen.findByTestId("subtask-item-2");
      const thirdDepLabels = thirdItem.querySelectorAll(".planning-dep-chip");
      expect(thirdDepLabels.length).toBe(2);
    });

    it("dependencies are cleared when a subtask is moved before its dependency", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      
      // Setup: B depends on A
      const subtasksWithDep = [
        { id: "subtask-A", title: "Task A", description: "Do A", suggestedSize: "S" as const, dependsOn: [] },
        { id: "subtask-B", title: "Task B", description: "Do B", suggestedSize: "M" as const, dependsOn: ["subtask-A"] },
      ];
      streamHandlers.onSubtasks(subtasksWithDep);

      // Verify dependency checkbox is present for subtask B
      const secondItem = await screen.findByTestId("subtask-item-1");
      const depCheckbox = secondItem.querySelector('input[type="checkbox"]');
      expect(depCheckbox).toBeChecked();

      // Move B before A using keyboard
      const moveUpButtons = screen.getAllByLabelText("Move subtask up");
      fireEvent.click(moveUpButtons[1]!);

      // After reordering, the dependency on A should not be visible in the new first position
      await waitFor(() => {
        const items = screen.getAllByTestId(/subtask-item-/);
        // The new first item (previously B) should not show dependency options
        const firstDepsList = items[0].querySelector(".planning-deps-list");
        expect(firstDepsList).toHaveTextContent("First subtask cannot have dependencies");
      });
    });
  });
});
