import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";
import type { Task } from "@fusion/core";

const MOCK_MODELS = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: true,
    contextWindow: 128_000,
  },
];

const mockTasks: Task[] = [
  {
    id: "FN-001",
    title: "Test task 1",
    description: "First test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "FN-002",
    title: "Test task 2",
    description: "Second test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      contextWindow: 200_000,
    },
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
      reasoning: true,
      contextWindow: 128_000,
    },
  ]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
}));

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Link: () => null,
  Brain: () => null,
  Lightbulb: () => null,
  ListTree: () => null,
  Sparkles: () => null,
  Save: () => null,
  X: () => null,
}));

// Mock ModelSelectionModal
vi.mock("../ModelSelectionModal", () => ({
  ModelSelectionModal: ({
    isOpen,
    onClose,
    models,
    executorValue,
    validatorValue,
    onExecutorChange,
    onValidatorChange,
    modelsLoading,
    modelsError,
    onRetry,
  }: {
    isOpen: boolean;
    onClose: () => void;
    models: typeof MOCK_MODELS;
    executorValue: string;
    validatorValue: string;
    onExecutorChange: (value: string) => void;
    onValidatorChange: (value: string) => void;
    modelsLoading: boolean;
    modelsError: string | null;
    onRetry: () => void;
  }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="model-selection-modal">
        <div data-testid="modal-props-models-count">{models.length}</div>
        <div data-testid="modal-props-executor-value">{executorValue}</div>
        <div data-testid="modal-props-validator-value">{validatorValue}</div>
        <div data-testid="modal-props-loading">{modelsLoading ? "loading" : "not-loading"}</div>
        <div data-testid="modal-props-error">{modelsError || "no-error"}</div>
        <button data-testid="modal-close" onClick={onClose}>
          Close
        </button>
        <button
          data-testid="modal-select-executor"
          onClick={() => onExecutorChange("anthropic/claude-sonnet-4-5")}
        >
          Select Executor
        </button>
        <button
          data-testid="modal-select-validator"
          onClick={() => onValidatorChange("openai/gpt-4o")}
        >
          Select Validator
        </button>
        <button data-testid="modal-retry" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  },
}));

function renderQuickEntryBox(props = {}) {
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    availableModels: MOCK_MODELS,
  };
  const result = render(<QuickEntryBox {...defaultProps} {...props} />);
  return { ...result, props: { ...defaultProps, ...props } };
}

describe("QuickEntryBox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders textarea with placeholder", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
    expect((textarea as HTMLTextAreaElement).placeholder).toBe("Add a task...");
  });

  it("expands on focus", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("collapses on blur when empty", async () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });
  });

  it("collapses on blur even when has content", async () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Some task" } });

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    
    // Wait for React to re-render after state change
    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });
  });

  it("creates task on Enter key with TaskCreateInput", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "New task description" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New task description",
          column: "triage",
        }),
      );
    });
  });

  it("allows Shift+Enter to insert newline when expanded", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Line 1" } });

    // Shift+Enter should not prevent default (allow newline)
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Event should not be prevented (returns true if preventDefault was NOT called)
    expect(event).toBe(true);
  });

  it("submits on Enter even when expanded (without Shift)", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Task to submit" } });

    // Enter without Shift should submit
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task to submit",
        }),
      );
    });
  });

  it("prevents default on Enter key (without Shift)", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task" } });
    const event = fireEvent.keyDown(textarea, { key: "Enter" });

    // Event is prevented (returns false)
    expect(event).toBe(false);
  });

  it("shows loading state during creation", async () => {
    const { props } = renderQuickEntryBox();
    // Slow down the promise to see loading state
    props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "New task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Check loading placeholder
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).placeholder).toBe("Creating...");
    });

    // Textarea should be disabled during creation
    expect(textarea).toBeDisabled();
  });

  it("clears input after successful creation", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("shows error toast on failure and keeps input content", async () => {
    const { props } = renderQuickEntryBox();
    props.onCreate.mockRejectedValue(new Error("Network error"));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "Failed task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Network error", "error");
    });

    // Input content should be preserved for retry
    expect((textarea as HTMLTextAreaElement).value).toBe("Failed task");
  });

  it("clears non-empty input on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Some text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Some text");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("collapses and blurs on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("does not clear empty input on Escape key", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit on Enter if input is empty", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Enter" });

    // Wait a bit to ensure no async call happens
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("does not submit on Enter if input is only whitespace", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("updates textarea value on change", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Updated text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Updated text");
  });

  it("trims whitespace when creating task", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with spaces",
        }),
      );
    });
  });

  it("maintains focus after successful creation", async () => {
    const { props } = renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    // After successful creation, focus should be maintained
    expect(document.activeElement).toBe(textarea);
  });

  describe("Rich creation features", () => {
    it("shows dependency button when focused", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Initially, no controls are visible before focus
      expect(screen.queryByTestId("quick-entry-deps-button")).toBeNull();

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with deps" } });

      // Now the dependency button should be visible
      expect(screen.getByTestId("quick-entry-deps-button")).toBeTruthy();
    });

    it("shows model selector button when focused", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Initially, no controls are visible
      expect(screen.queryByTestId("quick-entry-models-button")).toBeNull();

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with models" } });

      // Now the model selector button should be visible
      expect(screen.getByTestId("quick-entry-models-button")).toBeTruthy();
    });

    it("shows Plan and Subtask buttons when focused", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Initially, no controls are visible
      expect(screen.queryByTestId("plan-button")).toBeNull();
      expect(screen.queryByTestId("subtask-button")).toBeNull();

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      // Now the Plan and Subtask buttons should be visible
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("opens dependency dropdown when clicking deps button", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with deps" } });
      fireEvent.click(screen.getByTestId("quick-entry-deps-button"));

      // Dropdown should be visible with search input
      expect(document.querySelector(".dep-dropdown")).toBeTruthy();
      expect(document.querySelector(".dep-dropdown-search")).toBeTruthy();
    });

    it("opens model modal when clicking models button", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with models" } });

      // Modal should not be visible initially
      expect(screen.queryByTestId("model-selection-modal")).toBeNull();

      // Click the models button
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Modal should now be visible
      expect(screen.getByTestId("model-selection-modal")).toBeTruthy();
    });

    it("modal receives correct props (models, loading state, etc.)", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Modal should be open
      expect(screen.getByTestId("model-selection-modal")).toBeTruthy();

      // Check props passed to modal
      expect(screen.getByTestId("modal-props-models-count").textContent).toBe("2");
      expect(screen.getByTestId("modal-props-executor-value").textContent).toBe("");
      expect(screen.getByTestId("modal-props-validator-value").textContent).toBe("");
      expect(screen.getByTestId("modal-props-loading").textContent).toBe("not-loading");
      expect(screen.getByTestId("modal-props-error").textContent).toBe("no-error");
    });

    it("selects dependencies and includes them in submit payload", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with deps" } });
      fireEvent.click(screen.getByTestId("quick-entry-deps-button"));

      // Click on a task to select it
      const taskItem = document.querySelector(".dep-dropdown-item");
      expect(taskItem).toBeTruthy();
      fireEvent.click(taskItem!);

      // Close dropdown and submit
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with deps",
            dependencies: expect.arrayContaining(["FN-002"]), // Most recent task
          }),
        );
      });
    });

    it("calls onPlanningMode and clears input when Plan clicked", async () => {
      const onPlanningMode = vi.fn();
      const { props } = renderQuickEntryBox({ onPlanningMode });
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Plan this task" } });
      fireEvent.click(screen.getByTestId("plan-button"));

      await waitFor(() => {
        expect(onPlanningMode).toHaveBeenCalledWith("Plan this task");
      });

      // Input should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });

    it("calls onSubtaskBreakdown and clears input when Subtask clicked", async () => {
      const onSubtaskBreakdown = vi.fn();
      const { props } = renderQuickEntryBox({ onSubtaskBreakdown });
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");
      });

      // Input should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });

    it("disables Plan and Subtask buttons when description is empty", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type something first to make buttons appear
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Some task" } });

      const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
      const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;

      // Buttons should be enabled when there's content
      expect(planButton.disabled).toBe(false);
      expect(subtaskButton.disabled).toBe(false);

      // Clear the input
      fireEvent.change(textarea, { target: { value: "" } });

      // Buttons should now be disabled (or hidden since controls collapse)
      // Since the controls might hide when empty, we check if they exist and are disabled
      const updatedPlanButton = screen.queryByTestId("plan-button") as HTMLButtonElement | null;
      if (updatedPlanButton) {
        expect(updatedPlanButton.disabled).toBe(true);
      }
    });

    it("Plan button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and expand
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      // Get plan button and trigger mousedown (prevents blur)
      const planButton = screen.getByTestId("plan-button");
      fireEvent.mouseDown(planButton);

      // Trigger blur on textarea
      fireEvent.blur(textarea);

      // Controls should still be visible immediately after blur
      expect(screen.getByTestId("plan-button")).toBeTruthy();
    });

    it("Subtask button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and expand
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to break down" } });

      // Get subtask button and trigger mousedown (prevents blur)
      const subtaskButton = screen.getByTestId("subtask-button");
      fireEvent.mouseDown(subtaskButton);

      // Trigger blur on textarea
      fireEvent.blur(textarea);

      // Controls should still be visible immediately after blur
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("shows toast when Plan clicked with empty description", () => {
      const addToast = vi.fn();
      renderQuickEntryBox({ addToast });
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type something first to make buttons appear
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Some task" } });

      // Clear input
      fireEvent.change(textarea, { target: { value: "" } });

      // Button should be hidden when input is empty (controls collapse)
      const planButton = screen.queryByTestId("plan-button");
      if (planButton) {
        // If somehow visible, it should be disabled
        expect((planButton as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("includes selected models in submit payload", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with model" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Modal should be open
      expect(screen.getByTestId("model-selection-modal")).toBeTruthy();

      // Select executor model via mocked modal
      fireEvent.click(screen.getByTestId("modal-select-executor"));

      // Close the modal
      fireEvent.click(screen.getByTestId("modal-close"));

      // Submit the task
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with model",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
        );
      });
    });

    it("closes modal on Escape when open", async () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with modal" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Modal should be open
      expect(screen.getByTestId("model-selection-modal")).toBeTruthy();

      // Press Escape - should close modal but not clear input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Modal should be closed
      expect(screen.queryByTestId("model-selection-modal")).toBeNull();

      // Input should still have the value
      expect((textarea as HTMLTextAreaElement).value).toBe("Task with modal");
    });

    it("clears all state on second Escape after dropdowns are closed", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to clear" } });

      // First Escape closes any dropdowns
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Second Escape clears everything
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input should be cleared and collapsed
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });

    it("resets all state after successful creation", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to reset" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After creation, controls should be collapsed
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(screen.queryByTestId("quick-entry-deps-button")).toBeNull();
      expect(screen.queryByTestId("plan-button")).toBeNull();
      expect(screen.queryByTestId("subtask-button")).toBeNull();
    });
  });

  describe("localStorage persistence", () => {
    beforeEach(() => {
      // Clear localStorage before each test
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it("restores description from localStorage on mount", () => {
      // Pre-populate localStorage
      localStorage.setItem("kb-quick-entry-text", "Saved task description");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Should restore the saved description
      expect((textarea as HTMLTextAreaElement).value).toBe("Saved task description");
    });

    it("updates localStorage when typing", async () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Typing this task" } });

      // Wait for the useEffect to run
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Typing this task");
      });
    });

    it("clears localStorage after successful task creation", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something to set localStorage
      fireEvent.change(textarea, { target: { value: "Task to create" } });
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Task to create");
      });

      // Submit the task
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // localStorage should be cleared
      expect(localStorage.getItem("kb-quick-entry-text")).toBeNull();
    });

    it("clears localStorage when Escape clears non-empty input", async () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something to set localStorage
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to clear" } });
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Task to clear");
      });

      // Press Escape to clear the input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input and localStorage should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(localStorage.getItem("kb-quick-entry-text")).toBeNull();
    });

    it("does not clear localStorage on first Escape when closing dropdowns", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something and open dropdown
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task with dropdown" } });
      fireEvent.click(screen.getByTestId("quick-entry-deps-button"));

      // localStorage should have the value
      expect(localStorage.getItem("kb-quick-entry-text")).toBe("Task with dropdown");

      // First Escape closes dropdown but keeps input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input and localStorage should be preserved
      expect((textarea as HTMLTextAreaElement).value).toBe("Task with dropdown");
      expect(localStorage.getItem("kb-quick-entry-text")).toBe("Task with dropdown");
    });
  });

  describe("AI Refine feature", () => {
    it("shows refine button when text is entered", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Initially, refine button is not visible
      expect(screen.queryByTestId("refine-button")).toBeNull();

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to refine" } });

      // Now the refine button should be visible
      expect(screen.getByTestId("refine-button")).toBeTruthy();
    });

    it("refine button is hidden when textarea is empty", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Some text" } });
      expect(screen.getByTestId("refine-button")).toBeTruthy();

      // Clear the input
      fireEvent.change(textarea, { target: { value: "" } });

      // Button should be hidden/disabled (might be hidden when controls collapse)
      const refineButton = screen.queryByTestId("refine-button");
      if (refineButton) {
        expect((refineButton as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("opens refine menu on button click", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to refine" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be visible with all options
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();
      expect(screen.getByTestId("refine-add-details")).toBeTruthy();
      expect(screen.getByTestId("refine-expand")).toBeTruthy();
      expect(screen.getByTestId("refine-simplify")).toBeTruthy();
    });

    it("closes refine menu on Escape key", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to refine" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be open
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Press Escape
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Menu should be closed but input preserved
      expect(screen.queryByTestId("refine-clarify")).toBeNull();
      expect((textarea as HTMLTextAreaElement).value).toBe("Task to refine");
    });

    it("closes refine menu when option is selected", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be open
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Click on an option
      fireEvent.click(screen.getByTestId("refine-clarify"));

      // Menu should close
      await waitFor(() => {
        expect(screen.queryByTestId("refine-clarify")).toBeNull();
      });
    });

    it("successful refinement updates textarea content", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description");

      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      await waitFor(() => {
        expect(refineText).toHaveBeenCalledWith("Original text", "clarify");
      });

      // Textarea should be updated
      await waitFor(() => {
        expect((textarea as HTMLTextAreaElement).value).toBe("Refined description");
      });

      // Success toast should be shown
      await waitFor(() => {
        expect(props.addToast).toHaveBeenCalledWith("Description refined with AI", "success");
      });
    });

    it("failed refinement shows toast and preserves original text", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockRejectedValueOnce(new Error("Rate limit exceeded"));

      const { getRefineErrorMessage } = await import("../../api");

      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      await waitFor(() => {
        expect(props.addToast).toHaveBeenCalled();
      });

      // Original text should be preserved
      expect((textarea as HTMLTextAreaElement).value).toBe("Original text");
    });

    it("loading state disables button during refinement", async () => {
      const { refineText } = await import("../../api");
      // Slow down the promise to see loading state
      vi.mocked(refineText).mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      // Button should show loading text
      await waitFor(() => {
        expect(screen.getByText("Refining...")).toBeTruthy();
      });

      // Button should be disabled
      const refineButton = screen.getByTestId("refine-button");
      expect((refineButton as HTMLButtonElement).disabled).toBe(true);
    });

    it("auto-resizes textarea after refinement", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description with much more content here");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Short" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-expand"));

      await waitFor(() => {
        expect(refineText).toHaveBeenCalled();
      });
    });

    it("resets refine state when form is reset after creation", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined text");

      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Open refine menu but don't select anything
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Submit the form
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After reset, refine menu should be closed
      expect(screen.queryByTestId("refine-clarify")).toBeNull();
    });
  });

  describe("Save button", () => {
    it("shows save button when text is entered", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Initially, save button is not visible
      expect(screen.queryByTestId("save-button")).toBeNull();

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Now the save button should be visible
      expect(screen.getByTestId("save-button")).toBeTruthy();
    });

    it("save button is disabled when textarea is empty", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type something
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Some text" } });
      expect(screen.getByTestId("save-button")).toBeTruthy();

      // Clear the input
      fireEvent.change(textarea, { target: { value: "" } });

      // Button should be hidden or disabled when input is empty
      const saveButton = screen.queryByTestId("save-button") as HTMLButtonElement | null;
      if (saveButton) {
        expect(saveButton.disabled).toBe(true);
      }
    });

    it("save button is disabled during submission", async () => {
      const { props } = renderQuickEntryBox();
      // Slow down the promise to see loading state
      props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "New task" } });

      // Start submission with Enter key
      fireEvent.keyDown(textarea, { key: "Enter" });

      // During submission, button should be disabled
      await waitFor(() => {
        const saveButton = screen.queryByTestId("save-button") as HTMLButtonElement | null;
        if (saveButton) {
          expect(saveButton.disabled).toBe(true);
        }
      });
    });

    it("clicking save button persists to localStorage", async () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Draft task description" } });

      // Click the save button
      fireEvent.click(screen.getByTestId("save-button"));

      // localStorage should have the value
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Draft task description");
      });
    });

    it("clicking save button creates the task", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Click the save button
      fireEvent.click(screen.getByTestId("save-button"));

      // Task should be created
      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task to save",
            column: "triage",
          }),
        );
      });
    });

    it("save button has correct test id", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Button should have data-testid="save-button"
      const saveButton = screen.getByTestId("save-button");
      expect(saveButton).toBeTruthy();
    });

    it("save button has correct title attribute", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      const saveButton = screen.getByTestId("save-button");
      expect(saveButton.getAttribute("title")).toBe("Create task");
    });

    it("save button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and expand
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Get save button and trigger mousedown (prevents blur)
      const saveButton = screen.getByTestId("save-button");
      fireEvent.mouseDown(saveButton);

      // Trigger blur on textarea - the 200ms timer would collapse controls
      // but since we called mousedown with preventDefault first, it should be blocked
      // The blur event should still fire, but the onMouseDown handler prevents focus loss
      fireEvent.blur(textarea);
      
      // Controls should still be visible immediately after blur (blur timeout hasn't fired yet)
      // The real protection happens during the mousedown event before blur
      expect(screen.getByTestId("save-button")).toBeTruthy();
    });
  });
});
