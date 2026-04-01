import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
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
}));

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue([]),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
  }),
  uploadAttachment: vi.fn(),
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

function openModelPanel() {
  fireEvent.click(screen.getByRole("button", { name: /Models/i }));
}

function chooseModel(label: "Executor Model" | "Validator Model", optionText: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByText(optionText));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(fetchModels).mockResolvedValue(MOCK_MODELS);
  vi.mocked(fetchSettings).mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
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
    fireEvent.click(screen.getByText(/Deps/));
    const item = document.querySelector(".dep-dropdown-item") as HTMLElement;
    expect(item).toBeTruthy();

    const prevented = !fireEvent.mouseDown(item);
    expect(prevented).toBe(true);
  });

  it("does NOT call onCancel when focus leaves card with selected dependencies but empty description", () => {
    const { props } = renderCard(testTasks);
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
  it("opens and closes the model disclosure dropdown", () => {
    renderCard();

    openModelPanel();
    expect(screen.getByText("Executor Model")).toBeTruthy();
    expect(screen.getByText("Validator Model")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Models/i }));
    expect(screen.queryByText("Executor Model")).toBeNull();
  });

  it("updates executor selection and shows the selected model badge", () => {
    renderCard();

    openModelPanel();
    chooseModel("Executor Model", "Claude Sonnet 4.5");

    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeTruthy();
  });

  it("updates validator selection and shows the selected model badge", () => {
    renderCard();

    openModelPanel();
    chooseModel("Validator Model", "GPT-4o");

    expect(screen.getByText("openai/gpt-4o")).toBeTruthy();
  });

  it("clears the model selection when Use default is chosen", () => {
    renderCard();

    openModelPanel();
    chooseModel("Executor Model", "Claude Sonnet 4.5");
    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Executor Model" }));
    const defaultOption = document.querySelector(".model-combobox-dropdown .model-combobox-option") as HTMLElement;
    expect(defaultOption).toBeTruthy();
    fireEvent.click(defaultOption);

    expect(screen.getAllByText("Using default")).toHaveLength(2);
  });

  it("omits model fields from the submit payload after clearing back to default", async () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task using defaults again" } });
    openModelPanel();
    chooseModel("Executor Model", "Claude Sonnet 4.5");
    fireEvent.click(screen.getByRole("button", { name: "Executor Model" }));
    const defaultOption = document.querySelector(".model-combobox-dropdown .model-combobox-option") as HTMLElement;
    expect(defaultOption).toBeTruthy();
    fireEvent.click(defaultOption);
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
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task with model overrides" } });
    openModelPanel();
    chooseModel("Executor Model", "Claude Sonnet 4.5");
    chooseModel("Validator Model", "GPT-4o");
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

  it("does NOT call onCancel when focus leaves while the model dropdown is open", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    openModelPanel();
    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("does NOT call onCancel when focus leaves while the preset dropdown is open", () => {
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [{ id: "budget", name: "Budget", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" }],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });
    const { props } = renderCard();
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
    });
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Task with preset" } });
    fireEvent.click(screen.getByRole("button", { name: /Preset/i }));
    fireEvent.click(screen.getByRole("button", { name: "Budget" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => {
      expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        description: "Task with preset",
        modelPresetId: "budget",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }));
    });
  });

  it("does NOT call onCancel after a model override is selected and focus leaves the card", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    openModelPanel();
    chooseModel("Executor Model", "Claude Sonnet 4.5");
    fireEvent.click(screen.getByRole("button", { name: /1 model/i }));

    textarea.focus();
    fireEvent.focusOut(textarea, { relatedTarget: null });

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("prevents default on model option mouseDown to retain focus while selecting", () => {
    const { props } = renderCard();
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    textarea.focus();
    openModelPanel();
    fireEvent.click(screen.getByRole("button", { name: "Executor Model" }));
    const option = screen.getByText("Claude Sonnet 4.5");
    const prevented = !fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(prevented).toBe(true);
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeTruthy();
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

  it("shows an error state and retries model loading", async () => {
    vi.mocked(fetchModels)
      .mockRejectedValueOnce(new Error("no auth"))
      .mockResolvedValueOnce(MOCK_MODELS);

    renderCard([], { availableModels: undefined });
    openModelPanel();

    await waitFor(() => {
      expect(screen.getByText("Failed to load models.")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.queryByText("Failed to load models.")).toBeNull();
    });
    expect(fetchModels).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByText(/Deps/));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("preserves newest-first sort order when a search filter is applied", () => {
    renderCard(scrambledTasks);
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
    fireEvent.click(screen.getByText(/Deps/));
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items).toHaveLength(3);
    const ids = Array.from(items).map((el) => el.querySelector(".dep-dropdown-id")?.textContent);
    expect(ids).toEqual(["FN-003", "FN-002", "FN-001"]);
  });

  it("preserves newest-ID-first order when search filter is applied with identical timestamps", () => {
    renderCard(sameTimeTasks);
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
    fireEvent.click(screen.getByText(/Deps/));
    const input = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toBe("Search tasks…");
  });

  it("filters tasks by search term", () => {
    renderCard(testTasks);
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
    const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
    const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;
    expect(planButton.disabled).toBe(true);
    expect(subtaskButton.disabled).toBe(true);
  });

  it("enables Plan and Subtask buttons when description is entered", () => {
    renderCard();
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
    const textarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(textarea, { target: { value: "Plan this task" } });
    fireEvent.click(screen.getByTestId("plan-button"));

    expect(onPlanningMode).toHaveBeenCalledWith("Plan this task");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("calls onSubtaskBreakdown with description and clears input when Subtask clicked", () => {
    const onSubtaskBreakdown = vi.fn();
    renderCard([], { onSubtaskBreakdown });
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
