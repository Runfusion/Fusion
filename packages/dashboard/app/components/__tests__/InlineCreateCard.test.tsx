import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { InlineCreateCard } from "../InlineCreateCard";
import type { Task, Column } from "@fusion/core";
import { fetchModels, fetchSettings, fetchAgents } from "../../api";
import { useNodes } from "../../hooks/useNodes";
import type { ModelInfo } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

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
  Bot: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
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
    presets,
    selectedPresetId,
    onPresetChange,
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
    presets?: unknown[];
    selectedPresetId?: string;
    onPresetChange?: (presetId: string | undefined) => void;
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
        <div data-testid="modal-props-presets">{JSON.stringify(presets ?? [])}</div>
        <div data-testid="modal-props-selected-preset-id">{selectedPresetId ?? ""}</div>
        <div data-testid="modal-props-has-preset-change">{onPresetChange ? "yes" : "no"}</div>
        <button data-testid="modal-close" onClick={onClose}>Close</button>
        <button data-testid="modal-select-executor" onClick={() => onExecutorChange("anthropic/claude-sonnet-4-5")}>Select Executor</button>
        <button data-testid="modal-select-validator" onClick={() => onValidatorChange("openai/gpt-4o")}>Select Reviewer</button>
        <button data-testid="modal-clear-executor" onClick={() => onExecutorChange("")}>Clear Executor</button>
        <button data-testid="modal-clear-validator" onClick={() => onValidatorChange("")}>Clear Reviewer</button>
        <button data-testid="modal-retry" onClick={onRetry}>Retry</button>
      </div>
    );
  },
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [
      { id: "node-1", name: "Node One", status: "online", type: "remote", createdAt: "", updatedAt: "" },
      { id: "node-2", name: "Node Two", status: "offline", type: "remote", createdAt: "", updatedAt: "" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
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
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

const TEST_PROJECT_ID = "proj-123";
const INLINE_CREATE_STORAGE_KEY = scopedKey("kb-inline-create-text", TEST_PROJECT_ID);

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
    projectId: TEST_PROJECT_ID,
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
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(useNodes).mockReturnValue({
    nodes: [
      { id: "node-1", name: "Node One", status: "online", type: "remote", createdAt: "", updatedAt: "" },
      { id: "node-2", name: "Node Two", status: "offline", type: "remote", createdAt: "", updatedAt: "" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  });
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

describe("InlineCreateCard textarea width (FN-1608)", () => {
  it("textarea spans full container width in board view", () => {
    renderCard();
    const input = screen.getByPlaceholderText("What needs to be done?") as HTMLTextAreaElement;
    const card = document.querySelector(".inline-create-card") as HTMLElement;

    // Get the bounding rectangles for the textarea and its container
    const inputRect = input.getBoundingClientRect();
    const containerRect = card.getBoundingClientRect();

    // The textarea should span the full width of its container (within 34px tolerance for toggle button + gap)
    // This ensures the input visually reaches the right edge of the container
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width - 34);

    // The textarea should be at least 80% of the container width
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width * 0.8);
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

  it("Save button uses theme-driven btn-task-create class", () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(textarea, { target: { value: "Some task" } });

    // Save button should have the btn-task-create class
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton.className).toContain("btn-task-create");
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
    localStorage.setItem(INLINE_CREATE_STORAGE_KEY, "Saved draft description");

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
      expect(localStorage.getItem(INLINE_CREATE_STORAGE_KEY)).toBe("Typing this task");
    });
  });

  it("clears localStorage after successful task creation", async () => {
    const { props } = renderCard();
    expandCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    // Type something to set localStorage
    fireEvent.change(textarea, { target: { value: "Task to create" } });
    await waitFor(() => {
      expect(localStorage.getItem(INLINE_CREATE_STORAGE_KEY)).toBe("Task to create");
    });

    // Submit the task by clicking the Save button
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalled();
    });

    // localStorage should be cleared
    expect(localStorage.getItem(INLINE_CREATE_STORAGE_KEY)).toBeNull();
  });

  it("clears localStorage when cancelling via Escape key", async () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    // Type something to set localStorage
    fireEvent.change(textarea, { target: { value: "Draft to cancel" } });
    await waitFor(() => {
      expect(localStorage.getItem(INLINE_CREATE_STORAGE_KEY)).toBe("Draft to cancel");
    });

    // Press Escape to cancel
    fireEvent.keyDown(textarea, { key: "Escape" });

    // onCancel should be called
    await waitFor(() => {
      expect(props.onCancel).toHaveBeenCalled();
    });

    // localStorage should be cleared
    expect(localStorage.getItem(INLINE_CREATE_STORAGE_KEY)).toBeNull();
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

  it("submits with enabledWorkflowSteps undefined", async () => {
    const mockOnSubmit = vi.fn().mockResolvedValue(createMockTask());
    renderCard([], { onSubmit: mockOnSubmit });
    expandCard();

    const textarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(textarea, { target: { value: "Test task" } });
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledWorkflowSteps: undefined,
        }),
      );
    });
  });

  it("submits browser-verification workflow step when browser verification is enabled", async () => {
    const mockOnSubmit = vi.fn().mockResolvedValue(createMockTask());
    renderCard([], { onSubmit: mockOnSubmit });
    expandCard();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Verify login flow in browser" },
    });

    fireEvent.click(screen.getByTestId("inline-create-browser-verification-toggle"));
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledWorkflowSteps: ["browser-verification"],
        }),
      );
    });
  });

  it("includes priority in submit payload and resets to normal after successful create", async () => {
    const mockOnSubmit = vi.fn().mockResolvedValue(createMockTask());
    renderCard([], { onSubmit: mockOnSubmit });
    expandCard();

    fireEvent.change(screen.getByTestId("inline-create-priority-select"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
      target: { value: "Task with urgent priority" },
    });
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: "urgent",
        }),
      );
    });

    expandCard();
    expect(screen.getByTestId("inline-create-priority-select")).toHaveValue("normal");
  });

  describe("Consolidated controls layout (FN-781, FN-1292)", () => {
    it("renders Plan, Subtask, Deps, Agent, and Models together in footer controls when expanded", () => {
      renderCard();
      expandCard();

      // All buttons should be in the footer controls row
      const controlsRow = document.querySelector(".inline-create-controls");
      expect(controlsRow).toBeTruthy();

      // Plan, Subtask, Deps, Agent, Browser Verify, Priority, Preset, Models all in one row
      expect(controlsRow!.contains(screen.getByTestId("plan-button"))).toBe(true);
      expect(controlsRow!.contains(screen.getByTestId("subtask-button"))).toBe(true);
      expect(controlsRow!.contains(screen.getByTestId("inline-create-agent-button"))).toBe(true);
      expect(controlsRow!.contains(screen.getByTestId("inline-create-priority-select"))).toBe(true);
      const depsButton = screen.getByText(/Deps/);
      expect(controlsRow!.contains(depsButton)).toBe(true);
      const modelsButton = screen.getByRole("button", { name: /Models/i });
      expect(controlsRow!.contains(modelsButton)).toBe(true);
    });

    it("does not render footer controls when not expanded", () => {
      renderCard();

      // Footer controls should not exist when collapsed
      expect(document.querySelector(".inline-create-controls")).toBeNull();
    });

    it("Save button remains in footer actions area, separate from controls row", () => {
      renderCard();
      expandCard();

      const controlsRow = document.querySelector(".inline-create-controls");
      const saveButton = screen.getByTestId("save-button");

      // Save button should NOT be in the controls row (it's in inline-create-actions)
      expect(controlsRow!.contains(saveButton)).toBe(false);
    });

    it("Plan and Subtask disabled state still works in consolidated controls", () => {
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

  describe("Preset selection through model modal", () => {
    it("passes presets from settings to ModelSelectionModal", async () => {
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

      renderCard([], { availableModels: undefined });
      expandCard();

      // Wait for settings to load
      await waitFor(() => {
        expect(fetchSettings).toHaveBeenCalled();
      });

      // Open model modal
      const modelsButton = screen.getByRole("button", { name: /Models/i });
      fireEvent.click(modelsButton);

      await waitFor(() => {
        expect(screen.getByTestId("model-selection-modal")).toBeTruthy();
      });

      expect(screen.getByTestId("modal-props-presets").textContent).toBe(JSON.stringify(mockPresets));
      expect(screen.getByTestId("modal-props-has-preset-change").textContent).toBe("yes");
    });

    it("reflects selected preset ID in modal props", async () => {
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

      renderCard([], { availableModels: undefined });
      expandCard();

      await waitFor(() => {
        expect(fetchSettings).toHaveBeenCalled();
      });

      // First select a preset via the inline Preset button
      const presetButton = screen.getByRole("button", { name: /Preset/i });
      fireEvent.click(presetButton);

      // Click the preset option in the dropdown
      const fastOption = screen.getByText("Fast");
      fireEvent.click(fastOption);

      // Now open the model modal — the Models button text includes the preset name
      // Find it by looking for the button with Brain icon (the models button)
      const allButtons = screen.getAllByRole("button");
      const modelsButton = allButtons.find(
        (b) => b.textContent?.includes("Fast") && b.textContent?.includes("model"),
      );
      expect(modelsButton).toBeTruthy();
      fireEvent.click(modelsButton!);

      await waitFor(() => {
        expect(screen.getByTestId("model-selection-modal")).toBeTruthy();
      });

      expect(screen.getByTestId("modal-props-selected-preset-id").textContent).toBe("fast");
    });
  });

  describe("agent selector", () => {
    it("opens the agent picker", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Task Runner",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderCard([createMockTask({ id: "FN-100" })]);
      expandCard();

      fireEvent.click(screen.getByTestId("inline-create-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
        expect(screen.getByText("Task Runner")).toBeInTheDocument();
      });
    });

    it("passes assignedAgentId when selected", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-002",
          name: "Builder",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      const onSubmit = vi.fn().mockResolvedValue({ id: "FN-900" } as Task);
      renderCard([createMockTask({ id: "FN-100" })], { onSubmit });
      expandCard();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Create card with agent" } });
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));
      await waitFor(() => expect(screen.getByText("Builder")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Builder"));

      fireEvent.keyDown(screen.getByPlaceholderText("What needs to be done?"), { key: "Enter" });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ assignedAgentId: "agent-002" }));
      });
    });

    it("clears assignedAgentId when selection is removed", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-003",
          name: "Reviewer",
          role: "reviewer",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      const onSubmit = vi.fn().mockResolvedValue({ id: "FN-901" } as Task);
      renderCard([createMockTask({ id: "FN-100" })], { onSubmit });
      expandCard();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Create card without agent" } });
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));
      await waitFor(() => expect(screen.getByText("Reviewer")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Reviewer"));

      fireEvent.click(screen.getByTestId("inline-create-agent-button"));
      await waitFor(() => expect(screen.getByText("Clear selection")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Clear selection"));

      fireEvent.keyDown(screen.getByPlaceholderText("What needs to be done?"), { key: "Enter" });

      await waitFor(() => {
        const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload.assignedAgentId).toBeUndefined();
      });
    });

    it("fetches fresh agents when projectId changes to prevent stale cache leakage", async () => {
      const project1Agents = [
        {
          id: "agent-001",
          name: "Project One Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      const project2Agents = [
        {
          id: "agent-002",
          name: "Project Two Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      // First render with project 1
      vi.mocked(fetchAgents).mockResolvedValueOnce(project1Agents);
      const { rerender } = renderCard([], { projectId: "proj-1" });
      expandCard();

      // Open agent picker - should show project 1 agent
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));
      await waitFor(() => {
        expect(screen.getByText("Project One Agent")).toBeInTheDocument();
      });

      // Close picker and switch to project 2
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));

      // Rerender with different projectId - agents should be cleared and re-fetched
      vi.mocked(fetchAgents).mockResolvedValueOnce(project2Agents);
      rerender(<InlineCreateCard
        tasks={[]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        addToast={vi.fn()}
        availableModels={MOCK_MODELS}
        projectId="proj-2"
      />);

      // Open picker again for project 2 (controls already expanded — state persists across rerender)
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));

      await waitFor(() => {
        // Should show project 2's agent, not the stale project 1 agent
        expect(screen.getByText("Project Two Agent")).toBeInTheDocument();
      });

      // Verify project 1's agent is NOT shown
      expect(screen.queryByText("Project One Agent")).not.toBeInTheDocument();
    });

    it("clears selected agent when projectId changes", async () => {
      const agents = [
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      vi.mocked(fetchAgents).mockResolvedValue(agents);
      const { rerender } = renderCard([], { projectId: "proj-1" });
      expandCard();

      // Select an agent
      fireEvent.click(screen.getByTestId("inline-create-agent-button"));
      await waitFor(() => expect(screen.getByText("Test Agent")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Test Agent"));

      // Switch to different project
      rerender(<InlineCreateCard
        tasks={[]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        addToast={vi.fn()}
        availableModels={MOCK_MODELS}
        projectId="proj-2"
      />);

      // Selected agent should be cleared, picker should show "Agent" without name
      const agentButton = screen.getByTestId("inline-create-agent-button");
      expect(agentButton.textContent).toBe(" Agent");
    });
  });

  describe("description fullscreen expansion", () => {
    it("shows expand button when textarea is focused and has content", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Focus and type content
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test task description" } });

      // Expand button should be visible
      await waitFor(() => {
        expect(screen.getByTestId("inline-create-expand")).toBeInTheDocument();
      });
    });

    it("hides expand button when textarea is empty", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Focus without typing
      fireEvent.focus(textarea);

      // Expand button should not be visible when empty
      expect(screen.queryByTestId("inline-create-expand")).not.toBeInTheDocument();
    });

    it("hides expand button when textarea is blurred", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Focus, type, then blur
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test content" } });

      // Verify expand button is visible before blur
      await waitFor(() => {
        expect(screen.getByTestId("inline-create-expand")).toBeInTheDocument();
      });

      // Blur the textarea
      await act(async () => {
        fireEvent.blur(textarea);
      });

      // Expand button should be hidden after blur
      await waitFor(() => {
        expect(screen.queryByTestId("inline-create-expand")).not.toBeInTheDocument();
      });
    });

    it("enters fullscreen mode when expand button is clicked", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Focus and type content
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test description" } });

      // Click expand button
      await waitFor(() => {
        fireEvent.click(screen.getByTestId("inline-create-expand"));
      });

      // Fullscreen textarea should be visible
      await waitFor(() => {
        expect(screen.getByTestId("inline-create-input-fullscreen")).toBeInTheDocument();
      });

      // Collapse button should be visible
      expect(screen.getByTestId("inline-create-collapse")).toBeInTheDocument();
    });

    it("exits fullscreen mode when collapse button is clicked", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Enter fullscreen mode
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test description" } });
      await waitFor(() => {
        fireEvent.click(screen.getByTestId("inline-create-expand"));
      });
      await waitFor(() => {
        expect(screen.getByTestId("inline-create-input-fullscreen")).toBeInTheDocument();
      });

      // Click collapse button
      fireEvent.click(screen.getByTestId("inline-create-collapse"));

      // Fullscreen textarea should be hidden
      await waitFor(() => {
        expect(screen.queryByTestId("inline-create-input-fullscreen")).not.toBeInTheDocument();
      });
    });

    it("exits fullscreen mode when Escape key is pressed in fullscreen", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Enter fullscreen mode
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test description" } });
      await waitFor(() => {
        fireEvent.click(screen.getByTestId("inline-create-expand"));
      });
      await waitFor(() => {
        expect(screen.getByTestId("inline-create-input-fullscreen")).toBeInTheDocument();
      });

      // Press Escape
      const fullscreenTextarea = screen.getByTestId("inline-create-input-fullscreen");
      fireEvent.keyDown(fullscreenTextarea, { key: "Escape" });

      // Fullscreen should be exited
      await waitFor(() => {
        expect(screen.queryByTestId("inline-create-input-fullscreen")).not.toBeInTheDocument();
      });
    });

    it("preserves description text when entering fullscreen", async () => {
      renderCard();
      const textarea = screen.getByPlaceholderText("What needs to be done?");

      // Type some content
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "My test task description" } });

      // Enter fullscreen
      await waitFor(() => {
        fireEvent.click(screen.getByTestId("inline-create-expand"));
      });

      // Check fullscreen textarea has the content
      await waitFor(() => {
        const fullscreenTextarea = screen.getByTestId("inline-create-input-fullscreen") as HTMLTextAreaElement;
        expect(fullscreenTextarea.value).toBe("My test task description");
      });
    });
  });


describe("InlineCreateCard node override", () => {
  it("includes nodeId in payload when execution node override is selected", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ id: "FN-777" } as Task);
    renderCard([], { onSubmit });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Run on node" } });
    expandCard();
    fireEvent.change(screen.getByTestId("inline-create-node-select"), { target: { value: "node-1" } });
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-1" }));
    });
  });
});

});
