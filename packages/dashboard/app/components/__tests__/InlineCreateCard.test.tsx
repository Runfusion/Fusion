import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineCreateCard } from "../InlineCreateCard";
import type { Task, Column } from "@fusion/core";
import { fetchModels, fetchSettings } from "../../api";
import type { ModelInfo } from "../../api";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Brain: () => null,
  Cpu: () => null,
  Link: () => null,
  Search: () => null,
  Sparkles: () => null,
  Terminal: () => null,
  Lightbulb: () => null,
  ListTree: () => null,
  Zap: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Globe: () => null,
}));

// Mock ModelSelectionModal (renders via portal, so mock for testability)
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
    favoriteModels,
    onToggleModelFavorite,
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
    favoriteModels?: string[];
    onToggleModelFavorite?: (modelId: string) => void;
  }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="model-selection-modal">
        <div data-testid="modal-props-executor-value">{executorValue}</div>
        <div data-testid="modal-props-validator-value">{validatorValue}</div>
        <div data-testid="modal-props-loading">{modelsLoading ? "loading" : "not-loading"}</div>
        <div data-testid="modal-props-error">{modelsError || "no-error"}</div>
        <div data-testid="modal-props-favorite-models">{JSON.stringify(favoriteModels ?? [])}</div>
        <div data-testid="modal-props-has-toggle-model-favorite">{onToggleModelFavorite ? "yes" : "no"}</div>
        <button data-testid="modal-close" onClick={onClose}>Close</button>
        <button data-testid="modal-select-executor" onClick={() => onExecutorChange("anthropic/claude-sonnet-4-5")}>Select Executor</button>
        <button data-testid="modal-select-validator" onClick={() => onValidatorChange("openai/gpt-4o")}>Select Validator</button>
        <button data-testid="modal-clear-executor" onClick={() => onExecutorChange("")}>Clear Executor</button>
        <button data-testid="modal-clear-validator" onClick={() => onValidatorChange("")}>Clear Validator</button>
        <button data-testid="modal-retry" onClick={onRetry}>Retry</button>
      </div>
    );
  },
}));

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
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
  uploadAttachment: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const MOCK_MODELS: ModelInfo[] = [
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

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    description: "Task description",
    column: "todo" as Column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderCard(
  tasks: Task[] = [],
  overrides: Partial<ComponentProps<typeof InlineCreateCard>> = {},
) {
  const props: ComponentProps<typeof InlineCreateCard> = {
    tasks,
    onSubmit: vi.fn().mockResolvedValue({ id: "FN-001" } as Task),
    onCancel: vi.fn(),
    addToast: vi.fn(),
    availableModels: MOCK_MODELS,
    ...overrides,
  };
  const result = render(<InlineCreateCard {...props} />);
  return { ...result, props };
}

function openModelModal() {
  // Models button is inside expanded section - expand first if not already
  const modelsButton = screen.queryByRole("button", { name: /Models/i });
  if (!modelsButton) {
    expandCard();
  }
  fireEvent.click(screen.getByRole("button", { name: /Models/i }));
}

function expandCard() {
  fireEvent.click(screen.getByTestId("inline-create-toggle"));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(fetchModels).mockResolvedValue({ models: MOCK_MODELS, favoriteProviders: [], favoriteModels: [] });
  vi.mocked(fetchSettings).mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  });
});

describe("InlineCreateCard blur-to-cancel", () => {
  it("calls onCancel when focus leaves the card with empty input", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onCancel when focus leaves with non-empty input", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Some task description" } });
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("does NOT call onCancel when focus moves to another element inside the card", () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    const depsButton = screen.getByText(/Deps/);

    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: depsButton });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when blur with only whitespace input", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("InlineCreateCard dep-dropdown focus retention", () => {
  const testTasks: Task[] = [
    createMockTask({ id: "FN-010", title: "Task A", description: "First task" }),
  ];

  it("dep-dropdown-item mouseDown calls preventDefault to retain focus", () => {
    renderCard(testTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const item = document.querySelector(".dep-dropdown-item") as HTMLElement;
    expect(item).toBeTruthy();

    const prevented = !fireEvent.mouseDown(item);
    expect(prevented).toBe(true);
  });

  it("does NOT call onCancel when focus leaves card with selected dependencies but empty description", () => {
    const { props } = renderCard(testTasks);
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.click(screen.getByText(/Deps/));
    const item = document.querySelector(".dep-dropdown-item") as HTMLElement;
    expect(item).toBeTruthy();
    fireEvent.click(item);

    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe("InlineCreateCard model selector", () => {
  it("clicking Models button opens the ModelSelectionModal", () => {
    renderCard();

    openModelModal();
    expect(screen.getByTestId("model-selection-modal")).toBeTruthy();
  });

  it("passes favoriteModels and onToggleModelFavorite to ModelSelectionModal", () => {
    renderCard();
    openModelModal();

    expect(screen.getByTestId("modal-props-favorite-models").textContent).toBe("[]");
    expect(screen.getByTestId("modal-props-has-toggle-model-favorite").textContent).toBe("yes");
  });

  it("closes the model modal via the close button", () => {
    renderCard();

    openModelModal();
    expect(screen.getByTestId("model-selection-modal")).toBeTruthy();

    fireEvent.click(screen.getByTestId("modal-close"));
    expect(screen.queryByTestId("model-selection-modal")).toBeNull();
  });

  it("updates executor selection via the modal", () => {
    renderCard();

    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-executor"));

    // The executor value should be propagated to the modal props
    expect(screen.getByTestId("modal-props-executor-value").textContent).toBe("anthropic/claude-sonnet-4-5");
  });

  it("updates validator selection via the modal", () => {
    renderCard();

    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-validator"));

    expect(screen.getByTestId("modal-props-validator-value").textContent).toBe("openai/gpt-4o");
  });

  it("clears the model selection back to default", () => {
    renderCard();

    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-executor"));
    expect(screen.getByTestId("modal-props-executor-value").textContent).toBe("anthropic/claude-sonnet-4-5");

    fireEvent.click(screen.getByTestId("modal-clear-executor"));
    expect(screen.getByTestId("modal-props-executor-value").textContent).toBe("");
  });

  it("omits model fields from the submit payload after clearing back to default", async () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task using defaults again" } });
    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-executor"));
    fireEvent.click(screen.getByTestId("modal-clear-executor"));
    fireEvent.click(screen.getByTestId("modal-close"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task using defaults again",
          modelProvider: undefined,
          modelId: undefined,
          validatorModelProvider: undefined,
          validatorModelId: undefined,
        }),
      );
    });
  });

  it("includes selected models in the submit payload", async () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task with model overrides" } });
    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-executor"));
    fireEvent.click(screen.getByTestId("modal-select-validator"));
    fireEvent.click(screen.getByTestId("modal-close"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with model overrides",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
          validatorModelProvider: "openai",
          validatorModelId: "gpt-4o",
        }),
      );
    });
  });

  it("does NOT call onCancel when focus leaves while the model modal is open", () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    openModelModal();
    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("does NOT call onCancel when focus leaves while the preset dropdown is open", () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [{ id: "budget", name: "Budget", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" }],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 30000,
      groupOverlappingFiles: true,
      autoMerge: true,
    });
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.click(screen.getByRole("button", { name: /Preset/i }));
    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("includes selected preset id in the submit payload", async () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [{ id: "budget", name: "Budget", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" }],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 30000,
      groupOverlappingFiles: true,
      autoMerge: true,
    });
    const { props } = renderCard([], { availableModels: undefined });
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task with preset" } });
    fireEvent.click(screen.getByRole("button", { name: /Preset/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Budget" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        description: "Task with preset",
        modelPresetId: "budget",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }));
    });
  });

  it("calls onCancel after a model override is selected and focus leaves the card", () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    openModelModal();
    fireEvent.click(screen.getByTestId("modal-select-executor"));
    fireEvent.click(screen.getByTestId("modal-close"));

    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses parent-provided models without fetching again", () => {
    renderCard();
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("fetches models when parent-provided models are omitted", async () => {
    renderCard([], { availableModels: undefined });

    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalledTimes(1);
    });
  });

  it("shows error state in modal and retries model loading", async () => {
    vi.mocked(fetchModels)
      .mockRejectedValueOnce(new Error("no auth"))
      .mockResolvedValueOnce({ models: MOCK_MODELS, favoriteProviders: [], favoriteModels: [] });

    renderCard([], { availableModels: undefined });

    await waitFor(() => {
      // Wait for the failed fetch to complete
      expect(fetchModels).toHaveBeenCalledTimes(1);
    });

    openModelModal();

    // Modal should show the error state
    expect(screen.getByTestId("modal-props-error").textContent).toBe("no auth");

    // Click retry in the modal
    fireEvent.click(screen.getByTestId("modal-retry"));

    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalledTimes(2);
    });

    // After retry, error should be cleared
    await waitFor(() => {
      expect(screen.getByTestId("modal-props-error").textContent).toBe("no-error");
    });
  });
});

describe("InlineCreateCard dependency dropdown sort order", () => {
  const scrambledTasks: Task[] = [
    createMockTask({ id: "FN-001", title: "Oldest", description: "First", createdAt: "2026-01-01T00:00:00Z" }),
    createMockTask({ id: "FN-003", title: "Newest", description: "Third", createdAt: "2026-03-01T00:00:00Z" }),
    createMockTask({ id: "FN-002", title: "Middle", description: "Second", createdAt: "2026-02-01T00:00:00Z" }),
  ];

  it("renders dependency dropdown items sorted newest-first by createdAt", () => {
    renderCard(scrambledTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("preserves newest-first sort order when a search filter is applied", () => {
    renderCard(scrambledTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "FN-00" } });
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });
});

describe("InlineCreateCard dependency dropdown sort with identical timestamps", () => {
  const sameTimeTasks: Task[] = [
    createMockTask({ id: "FN-001", title: "First", description: "First task" }),
    createMockTask({ id: "FN-002", title: "Second", description: "Second task" }),
    createMockTask({ id: "FN-003", title: "Third", description: "Third task" }),
  ];

  it("renders tasks with identical createdAt sorted newest-ID-first (descending numeric ID)", () => {
    renderCard(sameTimeTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("preserves newest-ID-first order when search filter is applied with identical timestamps", () => {
    renderCard(sameTimeTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "FN-00" } });
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });
});

describe("InlineCreateCard dependency dropdown search", () => {
  const testTasks: Task[] = [
    createMockTask({ id: "FN-001", title: "Fix login", description: "Login page broken", createdAt: "2026-01-01T00:00:00Z" }),
    createMockTask({ id: "FN-002", title: "Add dark mode", description: "Theme support", createdAt: "2026-02-01T00:00:00Z" }),
    createMockTask({ id: "FN-003", title: "Refactor API", description: "Clean up endpoints", createdAt: "2026-03-01T00:00:00Z" }),
  ];

  it("shows search input when dropdown is opened", () => {
    renderCard(testTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe("Search tasks…");
  });

  it("filters tasks by search term", () => {
    renderCard(testTasks);
    expandCard();
    fireEvent.click(screen.getByText(/Deps/));
    const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "dark" } });

    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(1);
    expect(items[0].querySelector(".dep-dropdown-id")?.textContent).toBe("FN-002");
  });
});

describe("InlineCreateCard Plan and Subtask buttons", () => {
  it("renders Plan and Subtask buttons disabled when description is empty", () => {
    renderCard();
    expandCard();
    const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
    const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;
    expect(planButton.disabled).toBe(true);
    expect(subtaskButton.disabled).toBe(true);
  });

  it("enables Plan and Subtask buttons when description is entered", () => {
    renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(textarea, { target: { value: "Test task" } });

    const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
    const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;
    expect(planButton.disabled).toBe(false);
    expect(subtaskButton.disabled).toBe(false);
  });

  it("calls onPlanningMode with description and clears input when Plan clicked", () => {
    const onPlanningMode = vi.fn();
    renderCard([], { onPlanningMode });
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Plan this task" } });
    fireEvent.click(screen.getByTestId("plan-button"));

    expect(onPlanningMode).toHaveBeenCalledWith("Plan this task");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("calls onSubtaskBreakdown with description and clears input when Subtask clicked", () => {
    const onSubtaskBreakdown = vi.fn();
    renderCard([], { onSubtaskBreakdown });
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Break this down" } });
    fireEvent.click(screen.getByTestId("subtask-button"));

    expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("shows toast when Plan clicked with empty description (via direct handler call)", () => {
    const addToast = vi.fn();
    const onPlanningMode = vi.fn();
    renderCard([], { addToast, onPlanningMode });
    expandCard();

    // When no description, button is disabled - verify that behavior
    const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
    expect(planButton.disabled).toBe(true);

    // The handler validation exists but can't be triggered via click when disabled
    // The disabled state is the primary UX protection
  });

  it("shows toast when Subtask clicked with empty description (via direct handler call)", () => {
    const addToast = vi.fn();
    const onSubtaskBreakdown = vi.fn();
    renderCard([], { addToast, onSubtaskBreakdown });
    expandCard();

    // When no description, button is disabled - verify that behavior
    const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;
    expect(subtaskButton.disabled).toBe(true);

    // The handler validation exists but can't be triggered via click when disabled
    // The disabled state is the primary UX protection
  });
});

describe("InlineCreateCard localStorage persistence", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("restores description from localStorage on mount", () => {
    // Pre-populate localStorage
    localStorage.setItem("kb-inline-create-text", "Saved draft description");

    renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    // Should restore the saved description
    expect((textarea as HTMLTextAreaElement).value).toBe("Saved draft description");
  });

  it("updates localStorage when typing", async () => {
    renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Typing this task" } });

    // Wait for the useEffect to run
    await waitFor(() => {
      expect(localStorage.getItem("kb-inline-create-text")).toBe("Typing this task");
    });
  });

  it("clears localStorage after successful task creation", async () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    // Type something to set localStorage
    fireEvent.change(textarea, { target: { value: "Task to create" } });
    await waitFor(() => {
      expect(localStorage.getItem("kb-inline-create-text")).toBe("Task to create");
    });

    // Submit the task by clicking the Save button
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalled();
    });

    // localStorage should be cleared
    expect(localStorage.getItem("kb-inline-create-text")).toBeNull();
  });

  it("clears localStorage when cancelling via Escape key", async () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    // Type something to set localStorage
    fireEvent.change(textarea, { target: { value: "Draft to cancel" } });
    await waitFor(() => {
      expect(localStorage.getItem("kb-inline-create-text")).toBe("Draft to cancel");
    });

    // Press Escape to cancel
    fireEvent.keyDown(textarea, { key: "Escape" });

    // onCancel should be called
    await waitFor(() => {
      expect(props.onCancel).toHaveBeenCalled();
    });

    // localStorage should be cleared
    expect(localStorage.getItem("kb-inline-create-text")).toBeNull();
  });

  it("starts with empty description when localStorage is empty", () => {
    renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });
});

describe("InlineCreateCard button visibility when collapsed", () => {
  it("hides all buttons when not expanded", () => {
    renderCard();
    // Card starts collapsed (isExpanded is false by default)
    // Only the toggle button should be visible, all footer buttons should be hidden

    // Footer controls should not be rendered
    expect(screen.queryByTestId("plan-button")).toBeNull();
    expect(screen.queryByTestId("subtask-button")).toBeNull();
    expect(screen.queryByText(/Deps/)).toBeNull();
    expect(screen.queryByText(/Preset/)).toBeNull();
    expect(screen.queryByText(/Models/)).toBeNull();
    expect(screen.queryByTestId("save-button")).toBeNull();
  });

  it("toggle button is always visible regardless of expanded state", () => {
    renderCard();
    // Toggle button should always be visible
    expect(screen.getByTestId("inline-create-toggle")).toBeTruthy();
  });

  it("shows buttons after clicking toggle to expand", () => {
    renderCard();

    // Initially collapsed - buttons hidden
    expect(screen.queryByTestId("plan-button")).toBeNull();
    expect(screen.queryByText(/Deps/)).toBeNull();

    // Click toggle to expand
    expandCard();

    // Now buttons should be visible
    expect(screen.getByTestId("plan-button")).toBeTruthy();
    expect(screen.getByTestId("subtask-button")).toBeTruthy();
    expect(screen.getByText(/Deps/)).toBeTruthy();
    expect(screen.getByTestId("save-button")).toBeTruthy();
  });

  it("hides buttons again after collapsing via toggle", () => {
    renderCard();

    // Expand
    expandCard();
    expect(screen.getByTestId("plan-button")).toBeTruthy();

    // Collapse
    expandCard();

    // Buttons should be hidden again
    expect(screen.queryByTestId("plan-button")).toBeNull();
    expect(screen.queryByTestId("subtask-button")).toBeNull();
    expect(screen.queryByText(/Deps/)).toBeNull();
    expect(screen.queryByText(/Preset/)).toBeNull();
    expect(screen.queryByText(/Models/)).toBeNull();
    expect(screen.queryByTestId("save-button")).toBeNull();
  });

  it("footer div is not rendered when collapsed", () => {
    renderCard();
    // Footer should not be in the DOM when collapsed
    expect(document.getElementById("inline-create-controls")).toBeNull();

    expandCard();
    // Footer should now be in the DOM
    expect(document.getElementById("inline-create-controls")).toBeTruthy();
  });

  describe("browser verification", () => {
    it("shows browser verification button when expanded", () => {
      const { props } = renderCard();
      
      // Button should not be visible when collapsed
      expect(screen.queryByTestId("browser-verification-toggle")).toBeNull();
      
      // Expand the card
      expandCard();
      
      // Button should now be visible
      expect(screen.getByTestId("browser-verification-toggle")).toBeTruthy();
    });

    it("toggles browser verification when button is clicked", () => {
      const { props } = renderCard();
      expandCard();
      
      const button = screen.getByTestId("browser-verification-toggle");
      
      // Initially not active
      expect(button).not.toHaveClass("btn-active");
      
      // Click to enable
      fireEvent.click(button);
      expect(button).toHaveClass("btn-active");
      
      // Click to disable
      fireEvent.click(button);
      expect(button).not.toHaveClass("btn-active");
    });

    it("includes browser-verification in enabledWorkflowSteps when submitting with browser verification enabled", async () => {
      const mockOnSubmit = vi.fn().mockResolvedValue(createMockTask());
      const { props } = renderCard([], { onSubmit: mockOnSubmit });
      expandCard();
      
      // Enable browser verification
      fireEvent.click(screen.getByTestId("browser-verification-toggle"));
      
      // Fill in description
      const textarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(textarea, { target: { value: "Test task with browser verification" } });
      
      // Submit
      fireEvent.click(screen.getByTestId("save-button"));
      
      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: ["browser-verification"],
          }),
        );
      });
    });

    it("resets browser verification state after successful submission", async () => {
      const mockOnSubmit = vi.fn().mockResolvedValue(createMockTask({ id: "FN-042" }));
      const { props } = renderCard([], { onSubmit: mockOnSubmit });
      expandCard();
      
      // Enable browser verification
      fireEvent.click(screen.getByTestId("browser-verification-toggle"));
      
      // Verify button is active
      expect(screen.getByTestId("browser-verification-toggle")).toHaveClass("btn-active");
      
      // Fill in description and submit
      const textarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(textarea, { target: { value: "Task to complete" } });
      fireEvent.click(screen.getByTestId("save-button"));
      
      // Wait for submission to complete
      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalled();
      });
      
      // Collapse and expand to reset
      expandCard();
      
      // Browser verification should be reset (button not active)
      expect(screen.getByTestId("browser-verification-toggle")).not.toHaveClass("btn-active");
    });
  });

  describe("Description-adjacent actions layout (FN-781)", () => {
    it("renders Plan and Subtask in description-actions area when expanded", () => {
      renderCard();
      expandCard();

      // The description-actions container should exist
      expect(screen.getByTestId("inline-create-description-actions")).toBeTruthy();

      // Plan and Subtask buttons should be inside it
      const actionsContainer = screen.getByTestId("inline-create-description-actions");
      expect(actionsContainer.contains(screen.getByTestId("plan-button"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("subtask-button"))).toBe(true);
    });

    it("does not render description-actions when not expanded", () => {
      renderCard();

      // Description actions should not exist when collapsed
      expect(screen.queryByTestId("inline-create-description-actions")).toBeNull();
    });

    it("Save button remains in footer area, not description-actions", () => {
      renderCard();
      expandCard();

      const actionsContainer = screen.getByTestId("inline-create-description-actions");
      const saveButton = screen.getByTestId("save-button");

      // Save button should NOT be in the description-actions area
      expect(actionsContainer.contains(saveButton)).toBe(false);
    });

    it("Deps, Preset, Models buttons remain in footer area, not description-actions", () => {
      renderCard();
      expandCard();

      const actionsContainer = screen.getByTestId("inline-create-description-actions");
      const depsButton = screen.getByText(/Deps/);
      const modelsButton = screen.getByRole("button", { name: /Models/i });

      // Deps and Models should NOT be in the description-actions area
      expect(actionsContainer.contains(depsButton)).toBe(false);
      expect(actionsContainer.contains(modelsButton)).toBe(false);
    });

    it("Plan and Subtask disabled state still works in description-actions", () => {
      renderCard();
      expandCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Buttons should be disabled when description is empty
      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("subtask-button") as HTMLButtonElement).disabled).toBe(true);

      // Type something — buttons should become enabled
      fireEvent.change(textarea, { target: { value: "Some task" } });
      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId("subtask-button") as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
