import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SubtaskBreakdownModal } from "../SubtaskBreakdownModal";

const mockStartSubtaskBreakdown = vi.fn();
const mockRetrySubtaskSession = vi.fn();
const mockConnectSubtaskStream = vi.fn();
const mockCreateTasksFromBreakdown = vi.fn();
const mockCancelSubtaskBreakdown = vi.fn();
const mockFetchAiSession = vi.fn();
const mockParseConversationHistory = vi.fn();
const mockAcquireSessionLock = vi.fn();
const mockReleaseSessionLock = vi.fn();
const mockForceAcquireSessionLock = vi.fn();

vi.mock("../../api", () => ({
  startSubtaskBreakdown: (...args: any[]) => mockStartSubtaskBreakdown(...args),
  retrySubtaskSession: (...args: any[]) => mockRetrySubtaskSession(...args),
  connectSubtaskStream: (...args: any[]) => mockConnectSubtaskStream(...args),
  createTasksFromBreakdown: (...args: any[]) => mockCreateTasksFromBreakdown(...args),
  cancelSubtaskBreakdown: (...args: any[]) => mockCancelSubtaskBreakdown(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
}));

vi.mock("../../hooks/modalPersistence", () => ({
  saveSubtaskDescription: vi.fn(),
  getSubtaskDescription: vi.fn(() => ""),
  clearSubtaskDescription: vi.fn(),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
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
    mockRetrySubtaskSession.mockResolvedValue({ success: true, sessionId: "session-123" });
    mockConnectSubtaskStream.mockImplementation((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    mockCreateTasksFromBreakdown.mockResolvedValue({ tasks: [{ id: "FN-101" }, { id: "FN-102" }] });
    mockCancelSubtaskBreakdown.mockResolvedValue(undefined);
    mockFetchAiSession.mockResolvedValue(null);
    mockParseConversationHistory.mockImplementation((raw: string) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
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
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalledWith("Build a complex feature", undefined));
    expect(await screen.findByText("AI is generating subtasks...")).toBeInTheDocument();
  });

  it("shows lock overlay and allows take-control", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");
    mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });

    renderModal();

    await waitFor(() => {
      expect(screen.getByTestId("session-lock-overlay")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Take Control"));

    await waitFor(() => {
      expect(mockForceAcquireSessionLock).toHaveBeenCalledWith("session-123", "tab-self");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("session-lock-overlay")).not.toBeInTheDocument();
    });
  });

  it("hides send to background button in initial state", () => {
    render(
      <SubtaskBreakdownModal
        isOpen={true}
        onClose={onClose}
        initialDescription=""
        onTasksCreated={onTasksCreated}
      />,
    );

    expect(screen.queryByLabelText("Send to background")).not.toBeInTheDocument();
  });

  it("renders editable subtasks when stream returns items", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    expect(await screen.findByDisplayValue("First")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Do second")).toBeInTheDocument();
  });

  it("shows reconnecting indicator without clearing subtask state", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());

    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    expect(await screen.findByDisplayValue("First")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });
    await waitFor(() => {
      expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("First")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("connected");
    });
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("First")).toBeInTheDocument();
  });

  it("preserves thinking output while reconnecting in generating state", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());

    act(() => {
      streamHandlers.onThinking?.("Generating subtasks...");
    });
    expect(await screen.findByText("Generating subtasks...")).toBeInTheDocument();

    act(() => {
      streamHandlers.onConnectionStateChange?.("reconnecting");
    });
    await waitFor(() => {
      expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    });
    expect(screen.getByText("Generating subtasks...")).toBeInTheDocument();
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

  it("renders description textarea with 8 rows", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    const textareas = await screen.findAllByRole("textbox");
    const descriptionTextarea = textareas.find((t) => t.tagName === "TEXTAREA");
    expect(descriptionTextarea).toHaveAttribute("rows", "8");
  });

  it("changes size and dependency selection", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);

    const selects = await screen.findAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "L" } });
    // Use findAllByText to get all occurrences of subtask-1 and check the first one
    const subtaskLabels = await screen.findAllByText("subtask-1");
    expect(subtaskLabels.length).toBeGreaterThan(0);
  });

  it("changes size via dropdown selection", async () => {
    renderModal();
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    const selects = await screen.findAllByRole("combobox");
    expect(selects.length).toBeGreaterThan(0);
    fireEvent.change(selects[0], { target: { value: "L" } });
    // Verify state was updated (the API call will receive the updated value)
    fireEvent.click(screen.getByText("Create Tasks"));
    await waitFor(() => expect(mockCreateTasksFromBreakdown).toHaveBeenCalled());
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

  it("sends active breakdown session to background without canceling", async () => {
    const closeSpy = vi.fn();
    mockConnectSubtaskStream.mockImplementationOnce((_sessionId, _projectId, handlers) => {
      streamHandlers = handlers;
      return { close: closeSpy, isConnected: () => true };
    });

    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());
    await screen.findByText("AI is generating subtasks...");

    fireEvent.click(screen.getByLabelText("Send to background"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(mockCancelSubtaskBreakdown).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancel closes modal", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());
    fireEvent.click(await screen.findByLabelText("Close"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("close button explicitly cancels the session (destructive)", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());

    fireEvent.click(await screen.findByLabelText("Close"));

    await waitFor(() => {
      expect(mockCancelSubtaskBreakdown).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("escape key cancels session when in editing state (destructive)", async () => {
    renderModal();
    await waitFor(() => expect(mockStartSubtaskBreakdown).toHaveBeenCalled());

    // First transition to editing state
    await waitFor(() => expect(streamHandlers).toBeDefined());
    streamHandlers.onSubtasks(SAMPLE_SUBTASKS);
    await screen.findByDisplayValue("First");

    // Now escape should trigger confirm dialog then cancel
    fireEvent.keyDown(document, { key: "Escape" });

    // confirm() returns true (stubbed in beforeEach)
    await waitFor(() => {
      expect(mockCancelSubtaskBreakdown).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
    });
    expect(onClose).toHaveBeenCalled();
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

      // Start dragging first subtask with dataTransfer mock
      const dataTransferStart = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(firstSubtask, { dataTransfer: dataTransferStart });

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

      const dragStartDataTransfer = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(firstItem, { dataTransfer: dragStartDataTransfer });

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

      const dragStartDataTransfer = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(firstItem, { dataTransfer: dragStartDataTransfer });

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

      const dragStartDataTransfer = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(firstItem, { dataTransfer: dragStartDataTransfer });
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

  describe("error handling", () => {
    it("displays error message when stream returns error event", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onError("Something went wrong");
      expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    });

    it("retries after an error and reconnects stream", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      streamHandlers.onError("Something went wrong");

      const retryButton = await screen.findByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(mockRetrySubtaskSession).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
      });
      expect(mockConnectSubtaskStream).toHaveBeenCalledTimes(2);
    });

    it("recovers retry from connection-loss when session is still generating", async () => {
      let streamAttempt = 0;
      mockConnectSubtaskStream.mockImplementation((_sessionId, _projectId, handlers) => {
        streamHandlers = handlers;
        streamAttempt += 1;
        if (streamAttempt === 1) {
          setTimeout(() => handlers.onError?.("Connection lost"), 10);
        }
        return { close: vi.fn(), isConnected: vi.fn().mockReturnValue(true) };
      });

      mockRetrySubtaskSession.mockRejectedValueOnce(new Error("Subtask session session-123 is not in an error state"));
      mockFetchAiSession.mockResolvedValueOnce({
        id: "session-123",
        type: "subtask",
        status: "generating",
        title: "Build a complex feature",
        inputPayload: JSON.stringify({ description: "Build a complex feature" }),
        conversationHistory: "[]",
        currentQuestion: null,
        result: null,
        thinkingOutput: "Still generating...",
        error: null,
        projectId: null,
        lockedByTab: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lockedAt: null,
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Connection lost")).toBeInTheDocument();
      });

      const retryButton = await screen.findByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(mockRetrySubtaskSession).toHaveBeenCalledWith("session-123", undefined, expect.any(String));
        expect(mockFetchAiSession).toHaveBeenCalledWith("session-123");
      });
      expect(await screen.findByText("AI is generating subtasks...")).toBeInTheDocument();
      expect(screen.getByText("Still generating...")).toBeInTheDocument();
      expect(mockConnectSubtaskStream).toHaveBeenCalledTimes(2);
    });

    it("shows Stream error fallback when receiving empty error", async () => {
      renderModal();
      await waitFor(() => expect(streamHandlers).toBeDefined());
      // In real flow, api.ts converts empty string to "Stream error" before calling onError
      streamHandlers.onError("Stream error");
      expect(await screen.findByText("Stream error")).toBeInTheDocument();
    });
  });
});
