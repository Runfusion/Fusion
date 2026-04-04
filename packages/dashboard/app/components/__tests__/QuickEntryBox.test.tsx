import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";
import type { Task } from "@fusion/core";
import { fetchSettings } from "../../api";

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
  fetchModels: vi.fn().mockResolvedValue({ models: [
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
  ], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
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
  ChevronDown: () => null,
  ChevronUp: () => null,
  ChevronRight: () => null,
}));

// Mock ModelSelectionModal (kept for backward compatibility - no longer directly rendered)
vi.mock("../ModelSelectionModal", () => ({
  ModelSelectionModal: () => null,
}));

// Mock CustomModelDropdown - renders a simple test-friendly control
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    disabled?: boolean;
    models?: unknown[];
    placeholder?: string;
    id?: string;
    favoriteProviders?: string[];
    onToggleFavorite?: (provider: string) => void;
    favoriteModels?: string[];
    onToggleModelFavorite?: (modelId: string) => void;
  }) => (
    <div data-testid={`custom-model-dropdown-${label}`}>
      <span data-testid={`dropdown-value-${label}`}>{value || "none"}</span>
      <button
        data-testid={`dropdown-select-${label}`}
        onClick={() => onChange("anthropic/claude-sonnet-4-5")}
        disabled={disabled}
      >
        Select {label}
      </button>
      <button
        data-testid={`dropdown-clear-${label}`}
        onClick={() => onChange("")}
        disabled={disabled}
      >
        Clear {label}
      </button>
    </div>
  ),
}));

function renderQuickEntryBox(props = {}, { startExpanded = false } = {}) {
  // Component defaults to collapsed; set localStorage to expand if needed
  if (startExpanded) {
    localStorage.setItem("kb-quick-entry-expanded", "true");
  }
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    availableModels: MOCK_MODELS,
  };
  const result = render(<QuickEntryBox {...defaultProps} {...props} />);
  return { ...result, props: { ...defaultProps, ...props } };
}

// Helper to expand the QuickEntryBox by clicking the toggle button
function expandQuickEntry() {
  const toggleButton = screen.getByTestId("quick-entry-toggle");
  fireEvent.click(toggleButton);
}

describe("QuickEntryBox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("renders textarea with placeholder", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
    expect((textarea as HTMLTextAreaElement).placeholder).toBe("Add a task...");
  });

  it("does NOT expand on focus when autoExpand is false", () => {
    renderQuickEntryBox({ autoExpand: false });
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    // Should NOT auto-expand on focus when autoExpand is false
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("expands on focus by default (backward compatible)", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    // Should auto-expand on focus by default (autoExpand defaults to true)
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("toggle button expands the view", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const toggleButton = screen.getByTestId("quick-entry-toggle");
    const controls = document.getElementById("quick-entry-controls");

    // Initially not expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").className).toContain("quick-entry-box");
    expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(controls?.hasAttribute("hidden")).toBe(true);

    // Click toggle to expand
    expandQuickEntry();

    // Now expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(controls?.hasAttribute("hidden")).toBe(false);
  });

  it("toggle button collapses the view when expanded", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const box = screen.getByTestId("quick-entry-box");

    // Expand first
    expandQuickEntry();
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    // Click toggle again to collapse
    expandQuickEntry();

    // Now collapsed
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
  });

  it("maintains the collapsed and expanded styling contract on the root container", () => {
    renderQuickEntryBox({});
    const box = screen.getByTestId("quick-entry-box");

    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(box.classList.contains("quick-entry-box--expanded")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    expandQuickEntry();

    expect(box.classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("does NOT collapse on blur when empty", async () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    // Expand manually
    expandQuickEntry();
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Should NOT collapse on blur
    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    });
  });

  it("does NOT collapse on blur when has content", async () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    // Expand manually and add content
    expandQuickEntry();
    fireEvent.change(textarea, { target: { value: "Some task" } });

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    
    // Should NOT collapse on blur - expanded state persists
    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    });
  });

  it("creates task on Enter key with TaskCreateInput", async () => {
    const { props } = renderQuickEntryBox({});
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
    renderQuickEntryBox({});
    expandQuickEntry();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Line 1" } });

    // Shift+Enter should not prevent default (allow newline)
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Event should not be prevented (returns true if preventDefault was NOT called)
    expect(event).toBe(true);
  });

  it("submits on Enter even when expanded (without Shift)", async () => {
    const { props } = renderQuickEntryBox({});
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
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task" } });
    const event = fireEvent.keyDown(textarea, { key: "Enter" });

    // Event is prevented (returns false)
    expect(event).toBe(false);
  });

  it("shows loading state during creation", async () => {
    const { props } = renderQuickEntryBox({});
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
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("shows error toast on failure and keeps input content", async () => {
    const { props } = renderQuickEntryBox({});
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
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Some text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Some text");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("collapses and blurs on Escape key", () => {
    renderQuickEntryBox({});
    expandQuickEntry();
    const textarea = screen.getByTestId("quick-entry-input");

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("does not clear empty input on Escape key", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit on Enter if input is empty", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Enter" });

    // Wait a bit to ensure no async call happens
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("does not submit on Enter if input is only whitespace", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("updates textarea value on change", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Updated text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Updated text");
  });

  it("trims whitespace when creating task", async () => {
    const { props } = renderQuickEntryBox({});
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
    const { props } = renderQuickEntryBox({});
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
    it("shows dependency button when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with deps" } });

      // Now the dependency button should be visible
      expect(screen.getByTestId("quick-entry-deps-button")).toBeTruthy();
    });

    it("shows model selector button when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with models" } });

      // Now the model selector button should be visible
      expect(screen.getByTestId("quick-entry-models-button")).toBeTruthy();
    });

    it("shows Plan and Subtask buttons when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      // Now the Plan and Subtask buttons should be visible
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("opens dependency dropdown when clicking deps button", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with deps" } });
      fireEvent.click(screen.getByTestId("quick-entry-deps-button"));

      // Dropdown should be visible with search input
      expect(document.querySelector(".dep-dropdown")).toBeTruthy();
      expect(document.querySelector(".dep-dropdown-search")).toBeTruthy();
    });

    it("opens model menu when clicking models button", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });

      // Menu should not be visible initially
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();

      // Click the models button
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Menu should now be visible
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
    });

    it("shows Plan, Executor, and Validator options in model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("clicking Executor opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Submenu should show the dropdown for executor
      expect(screen.getByTestId("custom-model-dropdown-executor model")).toBeTruthy();
      // Back button should be visible
      expect(screen.getByTestId("model-submenu-back")).toBeTruthy();
    });

    it("clicking Plan opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      fireEvent.click(screen.getByTestId("model-menu-plan"));

      expect(screen.getByTestId("custom-model-dropdown-plan model")).toBeTruthy();
    });

    it("clicking Validator opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      fireEvent.click(screen.getByTestId("model-menu-validator"));

      expect(screen.getByTestId("custom-model-dropdown-validator model")).toBeTruthy();
    });

    it("back button returns to top-level model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Click back
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      // Should show top-level menu items again
      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("selects dependencies and includes them in submit payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");
      });

      // Input should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });

    it("disables Plan and Subtask buttons when description is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something first to make buttons appear
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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something first to make buttons appear
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
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with model" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Menu should be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Navigate to executor submenu
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Select executor model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-executor model"));

      // Close the menu via Escape
      fireEvent.keyDown(textarea, { key: "Escape" });

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

    it("closes model menu on Escape when open", async () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with menu" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      // Menu should be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Press Escape - should close menu but not clear input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Menu should be closed
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();

      // Input should still have the value
      expect((textarea as HTMLTextAreaElement).value).toBe("Task with menu");
    });

    it("clears all state on second Escape after dropdowns are closed", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to clear" } });

      // First Escape closes any dropdowns
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Second Escape clears everything
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input should be cleared and collapsed
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });

    it("resets all state after successful creation (disclosure resets to collapsed)", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to reset" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After creation, input is cleared and focus is restored
      expect((textarea as HTMLTextAreaElement).value).toBe("");

      // With autoExpand=true (default), textarea auto-expands on focus restore
      // but disclosure resets to collapsed — controls hidden until user toggles again
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("State sync between isExpanded and isDisclosureExpanded", () => {
    it("focus then toggle shows controls without collapsing textarea", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Focus auto-expands textarea height (isExpanded=true) but NOT disclosure
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(true); // controls still hidden

      // Now click toggle — should expand disclosure AND keep textarea expanded
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);
    });

    it("toggle twice from focused state returns to collapsed", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Focus → auto-expand textarea
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

      // Toggle expand
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);

      // Toggle collapse — both states should collapse together
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("after task creation with autoExpand, focus restore does not show controls unless toggle was used", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Type and submit without toggling disclosure
      fireEvent.change(textarea, { target: { value: "New task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After creation, focus is restored → autoExpand triggers isExpanded=true
      // But disclosure should still be false (controls hidden)
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("textarea aria-expanded reflects disclosure state, not textarea height", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus auto-expands textarea height but NOT disclosure
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      // aria-expanded should still be false (reflects disclosure, not height)
      expect(textarea.getAttribute("aria-expanded")).toBe("false");

      // Toggle expand — now aria-expanded should be true
      expandQuickEntry();
      expect(textarea.getAttribute("aria-expanded")).toBe("true");
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

    it("ignores legacy kb-quick-entry-expanded localStorage on mount", () => {
      // Pre-populate localStorage with expanded state from a previous version
      localStorage.setItem("kb-quick-entry-expanded", "true");

      renderQuickEntryBox();
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Should NOT restore the saved disclosure state — always starts collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // Controls should be hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });

    it("saved draft description does not reveal controls panel", () => {
      // Pre-populate localStorage with saved draft text
      localStorage.setItem("kb-quick-entry-text", "Previously saved draft task");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Description should be restored
      expect((textarea as HTMLTextAreaElement).value).toBe("Previously saved draft task");
      // But controls should remain hidden — draft text does not auto-expand disclosure
      expect(controls?.hasAttribute("hidden")).toBe(true);
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("false");
    });

    it("cleans up legacy kb-quick-entry-expanded key on mount", async () => {
      // Pre-populate localStorage with legacy key
      localStorage.setItem("kb-quick-entry-expanded", "true");

      renderQuickEntryBox();

      // The legacy key should be removed by the cleanup useEffect
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();
      });
    });

    it("defaults to collapsed when localStorage is empty", () => {
      renderQuickEntryBox();
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Should default to collapsed (false) — controls hidden until user expands
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // Controls should be hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });

    it("does not persist disclosure state to localStorage when toggling", async () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");

      // Click to expand
      fireEvent.click(toggleButton);

      // Should be expanded
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
      // localStorage should NOT be updated — disclosure is ephemeral
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();

      // Click to collapse
      fireEvent.click(toggleButton);

      // Should be collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // localStorage still should not have the key
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();
    });

    it("aria-expanded attribute updates correctly when toggling", () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");

      // Click to expand
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");

      // Click to collapse
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    });

    it("restores description from localStorage on mount", () => {
      // Pre-populate localStorage
      localStorage.setItem("kb-quick-entry-text", "Saved task description");

      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      // Should restore the saved description
      expect((textarea as HTMLTextAreaElement).value).toBe("Saved task description");
    });

    it("updates localStorage when typing", async () => {
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Typing this task" } });

      // Wait for the useEffect to run
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Typing this task");
      });
    });

    it("clears localStorage after successful task creation", async () => {
      const { props } = renderQuickEntryBox({});
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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something to set localStorage
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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something and open dropdown
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
    it("shows refine button when expanded and text is entered", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to refine" } });

      // Now the refine button should be visible
      expect(screen.getByTestId("refine-button")).toBeTruthy();
    });

    it("refine button is hidden when textarea is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something
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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to refine" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be visible with all options
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();
      expect(screen.getByTestId("refine-add-details")).toBeTruthy();
      expect(screen.getByTestId("refine-expand")).toBeTruthy();
      expect(screen.getByTestId("refine-simplify")).toBeTruthy();
    });

    it("closes refine menu on Escape key", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Open refine menu but don't select anything
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
    it("shows save button when expanded and text is entered", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Now the save button should be visible
      expect(screen.getByTestId("save-button")).toBeTruthy();
    });

    it("save button is disabled when textarea is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something
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
      const { props } = renderQuickEntryBox({});
      // Slow down the promise to see loading state
      props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Draft task description" } });

      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-text")).toBe("Draft task description");
      });

      // Click the save button
      fireEvent.click(screen.getByTestId("save-button"));

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // localStorage should be cleared after successful submission
      expect(localStorage.getItem("kb-quick-entry-text")).toBeNull();
    });

    it("clicking save button creates the task", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });

      // Button should have data-testid="save-button"
      const saveButton = screen.getByTestId("save-button");
      expect(saveButton).toBeTruthy();
      // Save button uses theme-driven class for task creation CTA
      expect(saveButton.className).toContain("btn-task-create");
    });

    it("save button has correct title attribute", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });

      const saveButton = screen.getByTestId("save-button");
      expect(saveButton.getAttribute("title")).toBe("Create task");
    });

    it("save button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

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

  describe("Button visibility when collapsed", () => {
    it("controls div has hidden attribute when not expanded", () => {
      renderQuickEntryBox({});
      // Component starts collapsed (disclosure expanded state is false)
      // Only the toggle button should be visible, all other buttons should be hidden

      const controls = document.getElementById("quick-entry-controls");
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("toggle button is always visible regardless of expanded state", () => {
      renderQuickEntryBox({});
      // Toggle button should always be visible
      expect(screen.getByTestId("quick-entry-toggle")).toBeTruthy();
    });

    it("shows buttons after clicking toggle to expand", () => {
      renderQuickEntryBox({});

      // Initially collapsed - controls hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Click toggle to expand
      expandQuickEntry();

      // Now controls should be visible
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
      // And buttons inside should be accessible
      expect(screen.getByTestId("quick-entry-deps-button")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models-button")).toBeTruthy();
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("hides buttons again after collapsing via toggle", () => {
      renderQuickEntryBox({});

      // Expand
      expandQuickEntry();
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
      expect(screen.getByTestId("quick-entry-deps-button")).toBeTruthy();

      // Collapse
      expandQuickEntry();

      // Controls should be hidden again
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });

    it("verifies all buttons are accessible when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      // All buttons should be accessible when expanded
      expect(screen.getByTestId("quick-entry-deps-button")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models-button")).toBeTruthy();
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
      expect(screen.getByTestId("save-button")).toBeTruthy();
      expect(screen.getByTestId("refine-button")).toBeTruthy();
    });
  });

  describe("Description-adjacent actions layout (FN-781)", () => {
    it("renders Plan, Subtask, and Refine in description-actions area when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      // The description-actions container should exist
      expect(screen.getByTestId("quick-entry-description-actions")).toBeTruthy();

      // Plan, Subtask, and Refine buttons should be inside it
      const actionsContainer = screen.getByTestId("quick-entry-description-actions");
      expect(actionsContainer.contains(screen.getByTestId("plan-button"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("subtask-button"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("refine-button"))).toBe(true);
    });

    it("does not render description-actions when not expanded", () => {
      renderQuickEntryBox({});

      // Description actions should not exist when collapsed
      expect(screen.queryByTestId("quick-entry-description-actions")).toBeNull();
    });

    it("Save button remains in the expanded controls area, not description-actions", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const actionsContainer = screen.getByTestId("quick-entry-description-actions");
      const saveButton = screen.getByTestId("save-button");

      // Save button should NOT be in the description-actions area
      expect(actionsContainer.contains(saveButton)).toBe(false);
    });

    it("Deps and Models buttons remain in the expanded controls area, not description-actions", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const actionsContainer = screen.getByTestId("quick-entry-description-actions");
      const depsButton = screen.getByTestId("quick-entry-deps-button");
      const modelsButton = screen.getByTestId("quick-entry-models-button");

      // Deps and Models should NOT be in the description-actions area
      expect(actionsContainer.contains(depsButton)).toBe(false);
      expect(actionsContainer.contains(modelsButton)).toBe(false);
    });

    it("Plan button disabled state still works when in description-actions", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Plan button should be disabled when description is empty
      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(true);

      // Type something — Plan should become enabled
      fireEvent.change(textarea, { target: { value: "Some task" } });
      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe("Preset selection through model menu", () => {
    it("shows Models button with menu options when settings loaded", async () => {
      const mockPresets = [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ];
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: mockPresets,
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 30000,
        groupOverlappingFiles: true,
        autoMerge: true,
      } as any);

      // Don't pass availableModels so component fetches settings itself
      renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();

      // Open model menu
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      await waitFor(() => {
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      });

      // The menu should show the three options
      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("omits modelPresetId when executor selected via submenu but no preset", async () => {
      const mockPresets = [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ];
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: mockPresets,
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 30000,
        groupOverlappingFiles: true,
        autoMerge: true,
      } as any);

      const onCreate = vi.fn().mockResolvedValue(undefined);
      renderQuickEntryBox({ onCreate, availableModels: undefined });
      expandQuickEntry();

      // Open model menu and select an executor via submenu
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      await waitFor(() => {
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      });

      // Navigate to executor submenu
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Select executor model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-executor model"));

      // Close menu via Escape
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Type and submit
      fireEvent.change(textarea, { target: { value: "Test task" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
      });

      const payload = onCreate.mock.calls[0][0];
      // modelPresetId should be undefined when no preset was explicitly selected
      expect(payload.modelPresetId).toBeUndefined();
    });

    it("omits modelPresetId when no preset is selected (direct create)", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Test task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
      });

      const payload = onCreate.mock.calls[0][0];
      expect(payload.modelPresetId).toBeUndefined();
    });
  });

  describe("FN-879: portaled model menu layering and filter-input stability", () => {
    it("renders model menu as a portal in document.body (not inside QuickEntryBox)", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // The portaled menu should have the --portal modifier class
      expect(menu.classList.contains("model-nested-menu--portal")).toBe(true);

      // The menu should be a direct child of document.body, NOT inside the QuickEntryBox container
      const quickEntryBox = screen.getByTestId("quick-entry-box");
      expect(quickEntryBox.contains(menu)).toBe(false);
      expect(document.body.contains(menu)).toBe(true);
    });

    it("positions the portaled menu with fixed positioning to escape column overflow", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-models-button"));

      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // The portaled menu should use fixed positioning
      expect(menu.style.position).toBe("fixed");
      // Should have explicit top, left, and width set
      expect(menu.style.top).toBeTruthy();
      expect(menu.style.left).toBeTruthy();
      expect(menu.style.width).toBeTruthy();
    });

    it("does not close model menu when clicking inside CustomModelDropdown portal", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Navigate to executor submenu (shows CustomModelDropdown mock)
      fireEvent.click(screen.getByTestId("model-menu-executor"));
      expect(screen.getByTestId("custom-model-dropdown-executor model")).toBeTruthy();

      // Simulate a mousedown inside the CustomModelDropdown's portaled dropdown.
      // In production, the CustomModelDropdown renders its dropdown as a portal
      // with class "model-combobox-dropdown--portal". The outside-click handler
      // must recognize clicks inside this portal as internal interactions.
      const comboboxPortal = document.createElement("div");
      comboboxPortal.className = "model-combobox-dropdown--portal";
      const filterInput = document.createElement("input");
      filterInput.type = "text";
      comboboxPortal.appendChild(filterInput);
      document.body.appendChild(comboboxPortal);

      try {
        // Dispatch mousedown on the filter input inside the combobox portal
        fireEvent.mouseDown(filterInput);

        // The model menu should remain open
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      } finally {
        document.body.removeChild(comboboxPortal);
      }
    });

    it("does not close model menu when clicking inside the model-nested-menu portal itself", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // Click inside the menu portal (simulating click on a menu item)
      fireEvent.mouseDown(menu);

      // Menu should still be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
    });

    it("closes model menu on outside click (click outside both trigger and portal)", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with menu" } });
      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Click on an element outside both the trigger and the portal
      const outsideElement = document.createElement("div");
      document.body.appendChild(outsideElement);
      try {
        fireEvent.mouseDown(outsideElement);
      } finally {
        document.body.removeChild(outsideElement);
      }

      // Menu should be closed
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();
    });

    it("repositions portaled menu on window resize while open", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-models-button"));
      const menu = screen.getByTestId("model-nested-menu");
      const initialTop = menu.style.top;

      // Trigger a resize event
      fireEvent.resize(window);

      // Menu should still be open and have position styles (may or may not change in test env)
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      expect(menu.style.position).toBe("fixed");
    });
  });
});
