import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelectorTab } from "../ModelSelectorTab";
import type { Task } from "@fusion/core";
import * as api from "../../api";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof api>("../../api");
  return {
    ...actual,
    fetchModels: vi.fn(),
    updateTask: vi.fn(),
  };
});

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

const mockFetchModels = api.fetchModels as ReturnType<typeof vi.fn>;
const mockUpdateTask = api.updateTask as ReturnType<typeof vi.fn>;

const FAKE_TASK: Task = {
  id: "FN-001",
  description: "Test task",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const MOCK_MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

// Mock response format (with models and favoriteProviders)
const MOCK_MODELS_RESPONSE = {
  models: MOCK_MODELS,
  favoriteProviders: [],
  favoriteModels: [],
};

describe("ModelSelectorTab", () => {
  const mockAddToast = vi.fn();

  async function waitForSelectors() {
    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });
  }

  function getSelector(label: string) {
    return screen.getByLabelText(label);
  }

  function getSection(label: string): HTMLElement | null {
    const section = getSelector(label).closest(".form-group");
    return section instanceof HTMLElement ? section : null;
  }

  async function openSelector(label: string) {
    const user = userEvent.setup();
    await user.click(getSelector(label));
    return user;
  }

  async function selectOption(label: string, optionText: string) {
    const user = await openSelector(label);
    await user.click(screen.getByText(optionText));
  }

  function getUseDefaultOption() {
    return screen.getAllByText("Use default").find(
      (element) => element.classList.contains("model-combobox-option-text--default"),
    ) ?? screen.getAllByText("Use default")[0];
  }

  /** Helper to build expected updateTask call with all model fields */
  function expectedModelCall(overrides: {
    modelProvider?: string | null;
    modelId?: string | null;
    validatorModelProvider?: string | null;
    validatorModelId?: string | null;
    planningModelProvider?: string | null;
    planningModelId?: string | null;
  } = {}) {
    return {
      modelProvider: overrides.modelProvider ?? null,
      modelId: overrides.modelId ?? null,
      validatorModelProvider: overrides.validatorModelProvider ?? null,
      validatorModelId: overrides.validatorModelId ?? null,
      planningModelProvider: overrides.planningModelProvider ?? null,
      planningModelId: overrides.planningModelId ?? null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchModels.mockResolvedValue(MOCK_MODELS_RESPONSE);
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...FAKE_TASK,
      ...updates,
    }));
  });

  it("renders loading state initially", () => {
    mockFetchModels.mockReturnValue(new Promise(() => {}));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);
    expect(screen.getByText("Loading available models…")).toBeInTheDocument();
  });

  it("renders model selectors after loading without save or reset buttons", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    expect(screen.getByLabelText("Validator Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Planning Model")).toBeInTheDocument();
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(screen.queryByText("Reset")).not.toBeInTheDocument();
  });

  it("shows updated intro copy mentioning project or global defaults", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    expect(
      screen.getByText(
        "Override the AI models used for this task. When not specified, project or global defaults are used.",
      ),
    ).toBeInTheDocument();
  });

  it("shows updated status copy when all selections use defaults", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    expect(screen.getByText("Using project or global default models.")).toBeInTheDocument();
  });

  it("shows 'Using default' when no model overrides are set", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    const executorSection = getSection("Executor Model");
    expect(within(executorSection!).getByText("Using default")).toBeInTheDocument();

    const validatorSection = getSection("Validator Model");
    expect(within(validatorSection!).getByText("Using default")).toBeInTheDocument();

    const planningSection = getSection("Planning Model");
    expect(within(planningSection!).getByText("Using default")).toBeInTheDocument();
  });

  it("shows resolved default model in badge when settings are provided", async () => {
    render(
      <ModelSelectorTab
        task={FAKE_TASK}
        addToast={mockAddToast}
        settings={{
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }}
      />,
    );

    await waitForSelectors();

    const executorSection = getSection("Executor Model");
    expect(within(executorSection!).getByText("Using default (anthropic/claude-sonnet-4-5)")).toBeInTheDocument();
  });

  it("shows 'Using default' without resolution when settings prop is undefined", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    const executorSection = getSection("Executor Model");
    expect(within(executorSection!).getByText("Using default")).toBeInTheDocument();
    expect(within(executorSection!).queryByText(/Using default \(.+\)/)).not.toBeInTheDocument();
  });

  it("shows validator resolved model using validator settings then default fallback", async () => {
    render(
      <ModelSelectorTab
        task={FAKE_TASK}
        addToast={mockAddToast}
        settings={{
          validatorProvider: "openai",
          validatorModelId: "gpt-4o",
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }}
      />,
    );

    await waitForSelectors();

    const validatorSection = getSection("Validator Model");
    expect(within(validatorSection!).getByText("Using default (openai/gpt-4o)")).toBeInTheDocument();
  });

  it("shows planning resolved model using planning settings then default fallback", async () => {
    render(
      <ModelSelectorTab
        task={FAKE_TASK}
        addToast={mockAddToast}
        settings={{
          planningProvider: "google",
          planningModelId: "gemini-2.5-pro",
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }}
      />,
    );

    await waitForSelectors();

    const planningSection = getSection("Planning Model");
    expect(within(planningSection!).getByText("Using default (google/gemini-2.5-pro)")).toBeInTheDocument();
  });

  it("updates resolved model when settings change", async () => {
    const { rerender } = render(
      <ModelSelectorTab
        task={FAKE_TASK}
        addToast={mockAddToast}
        settings={{
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
        }}
      />,
    );

    await waitForSelectors();

    const executorSection = getSection("Executor Model");
    expect(within(executorSection!).getByText("Using default (anthropic/claude-sonnet-4-5)")).toBeInTheDocument();

    rerender(
      <ModelSelectorTab
        task={FAKE_TASK}
        addToast={mockAddToast}
        settings={{
          defaultProvider: "openai",
          defaultModelId: "gpt-4o",
        }}
      />,
    );

    await waitFor(() => {
      const nextExecutorSection = getSection("Executor Model");
      expect(within(nextExecutorSection!).getByText("Using default (openai/gpt-4o)")).toBeInTheDocument();
    });
  });

  it("shows current custom model when overrides are set", async () => {
    const taskWithModels = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };

    render(<ModelSelectorTab task={taskWithModels} addToast={mockAddToast} />);

    await waitForSelectors();

    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
  });

  it("displays provider icon next to current selection in badge", async () => {
    const taskWithModels = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };

    render(<ModelSelectorTab task={taskWithModels} addToast={mockAddToast} />);

    await waitForSelectors();

    const anthropicIcons = screen.getAllByTestId("provider-icon-anthropic");
    const openaiIcons = screen.getAllByTestId("provider-icon-openai");

    expect(anthropicIcons.length).toBeGreaterThanOrEqual(1);
    expect(openaiIcons.length).toBeGreaterThanOrEqual(1);
  });

  it("does not display provider icon in badge when using default", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    expect(screen.queryByTestId(/provider-icon-/)).not.toBeInTheDocument();
  });

  it("opens combobox in the shared portal layer when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Executor Model"));

    const portal = await screen.findByTestId("model-combobox-portal");
    expect(portal).toBeInTheDocument();
    expect(portal).toHaveClass("model-combobox-dropdown--portal");
    expect(document.body).toContainElement(portal);

    expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
    expect(screen.getByText("3 models")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
  });

  it("groups models by provider in dropdown", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await openSelector("Executor Model");

    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
  });

  it("displays provider icons in dropdown group headers", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await openSelector("Executor Model");

    expect(screen.getByTestId("provider-icon-anthropic")).toBeInTheDocument();
    expect(screen.getByTestId("provider-icon-openai")).toBeInTheDocument();
  });

  it("auto-saves executor and validator changes immediately", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(1, "FN-001", expectedModelCall({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }));
    });

    await selectOption("Validator Model", "GPT-4o");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(2, "FN-001", expectedModelCall({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }));
    });
  });

  it("preserves the saved validator override when auto-saving an executor change", async () => {
    const taskWithValidator = {
      ...FAKE_TASK,
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...taskWithValidator,
      ...updates,
    }));

    render(<ModelSelectorTab task={taskWithValidator} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }));
    });
  });

  it("calls updateTask with null fields to clear models on 'Use default' selection", async () => {
    const taskWithModels = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...taskWithModels,
      ...updates,
    }));

    const user = userEvent.setup();
    render(<ModelSelectorTab task={taskWithModels} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Executor Model"));
    await user.click(getUseDefaultOption());

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall());
    });
  });

  it("preserves the saved executor override when auto-saving a validator change", async () => {
    const taskWithExecutor = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...taskWithExecutor,
      ...updates,
    }));

    render(<ModelSelectorTab task={taskWithExecutor} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Validator Model", "GPT-4o");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      }));
    });
  });

  it("clears the validator override with null fields when selecting 'Use default'", async () => {
    const taskWithValidator = {
      ...FAKE_TASK,
      validatorModelProvider: "openai",
      validatorModelId: "gpt-4o",
    };
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...taskWithValidator,
      ...updates,
    }));

    const user = userEvent.setup();
    render(<ModelSelectorTab task={taskWithValidator} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Validator Model"));
    await user.click(getUseDefaultOption());

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall());
    });
  });

  it("shows error state when fetchModels fails", async () => {
    mockFetchModels.mockRejectedValue(new Error("Network error"));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText(/Error loading models:/)).toBeInTheDocument();
    });

    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows empty state when no models available", async () => {
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [] });

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText(/No models available/)).toBeInTheDocument();
    });
  });

  it("disables all selectors while saving", async () => {
    const user = userEvent.setup();
    let resolveUpdate: ((value: Task) => void) | undefined;
    mockUpdateTask.mockImplementation(
      () => new Promise((resolve) => {
        resolveUpdate = resolve as (value: Task) => void;
      }),
    );

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Executor Model"));
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    await waitFor(() => {
      expect(getSelector("Executor Model")).toBeDisabled();
      expect(getSelector("Validator Model")).toBeDisabled();
      expect(getSelector("Planning Model")).toBeDisabled();
    });

    resolveUpdate?.({
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(getSelector("Executor Model")).not.toBeDisabled();
      expect(getSelector("Validator Model")).not.toBeDisabled();
      expect(getSelector("Planning Model")).not.toBeDisabled();
    });
  });

  it("keeps the badge on the last saved value while an auto-save is pending", async () => {
    const user = userEvent.setup();
    let resolveUpdate: ((value: Task) => void) | undefined;
    mockUpdateTask.mockImplementation(
      () => new Promise((resolve) => {
        resolveUpdate = resolve as (value: Task) => void;
      }),
    );

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Executor Model"));
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    await waitFor(() => {
      expect(getSelector("Executor Model")).toHaveTextContent("Claude Sonnet 4.5");
    });
    expect(within(getSection("Executor Model")!).getByText("Using default")).toBeInTheDocument();

    resolveUpdate?.({
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(within(getSection("Executor Model")!).getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument();
    });
  });

  it("shows error toast and reverts the dropdown when auto-save fails", async () => {
    mockUpdateTask.mockRejectedValue(new Error("Save failed"));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Save failed", "error");
    });

    expect(getSelector("Executor Model")).toHaveTextContent("Use default");
    expect(within(getSection("Executor Model")!).getByText("Using default")).toBeInTheDocument();
  });

  it("shows a specific executor success toast with the saved model name", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        "Executor model set to anthropic/claude-sonnet-4-5",
        "success",
      );
    });
  });

  it("calls onTaskUpdated with server task after saving executor model", async () => {
    const onTaskUpdated = vi.fn();
    const updatedTask = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };
    mockUpdateTask.mockResolvedValueOnce(updatedTask);

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} onTaskUpdated={onTaskUpdated} />);

    await waitForSelectors();
    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
    });
  });

  it("shows a specific validator success toast with the saved model name", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Validator Model", "GPT-4o");

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Validator model set to openai/gpt-4o", "success");
    });
  });

  it("shows a 'set to default' toast when clearing a model override", async () => {
    const taskWithModel = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };
    mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
      ...taskWithModel,
      ...updates,
    }));

    const user = userEvent.setup();
    render(<ModelSelectorTab task={taskWithModel} addToast={mockAddToast} />);

    await waitForSelectors();

    await user.click(getSelector("Executor Model"));
    await user.click(getUseDefaultOption());

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Executor model set to default", "success");
    });
  });

  it("updates the saved badge after a successful save", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();
    await selectOption("Executor Model", "Claude Sonnet 4.5");

    await waitFor(() => {
      expect(within(getSection("Executor Model")!).getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument();
    });
  });

  describe("Combobox behavior", () => {
    it("filters models when typing in search input", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");

      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("GPT-4o")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
      expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
    });

    it("filters models by model ID", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "gpt-4o");

      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("GPT-4o")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
    });

    it("filters models by display name", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "opus");

      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
    });

    it("supports multi-word filter (AND logic)", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "anthropic claude");

      expect(screen.getByText("2 models")).toBeInTheDocument();
      expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
      expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
      expect(screen.queryByText("GPT-4o")).not.toBeInTheDocument();
    });

    it("clear button clears filter and restores full list", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");

      expect(screen.getByText("1 model")).toBeInTheDocument();

      const clearButton = screen.getByLabelText("Clear filter");
      await user.click(clearButton);

      expect(searchInput).toHaveValue("");
      expect(screen.getByText("3 models")).toBeInTheDocument();
    });

    it("shows empty state message when filter matches nothing", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "xyz123");

      expect(screen.getByText("0 models")).toBeInTheDocument();
      expect(screen.getByText(/No models match/)).toBeInTheDocument();
    });

    it("closes dropdown when clicking outside", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

      await user.click(screen.getByText(/Override the AI models/));

      expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
    });

    it("closes dropdown on Escape key", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

      await user.keyboard("{Escape}");

      expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
    });

    it("navigates with arrow keys and auto-saves with Enter", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      const executorTrigger = getSelector("Executor Model");
      executorTrigger.focus();
      await user.keyboard("{ArrowDown}");

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
      });

      await user.keyboard("{ArrowDown}");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
      });

      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }));
    });

    it("Use default option is always visible", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      expect(screen.getAllByText("Use default").length).toBeGreaterThan(0);

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "nonexistent123");

      expect(screen.getAllByText("Use default").length).toBeGreaterThan(0);
    });

    it("shows model ID next to model name", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
      expect(screen.getByText("claude-opus-4")).toBeInTheDocument();
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    });

    it("selecting a model from a filtered list auto-saves the correct value", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Executor Model"));

      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");
      await user.click(screen.getByText("GPT-4o"));

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
          modelProvider: "openai",
          modelId: "gpt-4o",
        }));
      });
    });
  });

  describe("Planning model selector", () => {
    it("renders planning model dropdown", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      expect(screen.getByLabelText("Planning Model")).toBeInTheDocument();
    });

    it("shows 'Using default' badge when no planning model override is set", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      const planningSection = getSection("Planning Model");
      expect(within(planningSection!).getByText("Using default")).toBeInTheDocument();
    });

    it("shows custom badge when planning model override is set", async () => {
      const taskWithPlanning = {
        ...FAKE_TASK,
        planningModelProvider: "google",
        planningModelId: "gemini-2.5-pro",
      };

      render(<ModelSelectorTab task={taskWithPlanning} addToast={mockAddToast} />);

      await waitForSelectors();

      const planningSection = getSection("Planning Model");
      const badge = within(planningSection!).getByText("google/gemini-2.5-pro", { selector: ".model-badge-custom" });
      expect(badge).toBeInTheDocument();
    });

    it("auto-saves planning model selection correctly", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();
      await selectOption("Planning Model", "Claude Sonnet 4.5");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
          planningModelProvider: "anthropic",
          planningModelId: "claude-sonnet-4-5",
        }));
      });
    });

    it("clears planning model override with 'Use default'", async () => {
      const taskWithPlanning = {
        ...FAKE_TASK,
        planningModelProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...taskWithPlanning,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={taskWithPlanning} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Planning Model"));
      await user.click(getUseDefaultOption());

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall());
      });
    });

    it("preserves executor and validator overrides when saving planning model", async () => {
      const taskWithModels = {
        ...FAKE_TASK,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...taskWithModels,
        ...updates,
      }));

      render(<ModelSelectorTab task={taskWithModels} addToast={mockAddToast} />);

      await waitForSelectors();
      await selectOption("Planning Model", "Claude Opus 4");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expectedModelCall({
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
          validatorModelProvider: "openai",
          validatorModelId: "gpt-4o",
          planningModelProvider: "anthropic",
          planningModelId: "claude-opus-4",
        }));
      });
    });

    it("shows planning model success toast with correct model name", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();
      await selectOption("Planning Model", "GPT-4o");

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Planning model set to openai/gpt-4o",
          "success",
        );
      });
    });

    it("shows 'set to default' toast when clearing planning model override", async () => {
      const taskWithPlanning = {
        ...FAKE_TASK,
        planningModelProvider: "anthropic",
        planningModelId: "claude-sonnet-4-5",
      };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...taskWithPlanning,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={taskWithPlanning} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.click(getSelector("Planning Model"));
      await user.click(getUseDefaultOption());

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith("Planning model set to default", "success");
      });
    });
  });

  describe("thinkingLevel selector", () => {
    it("renders thinking level selector with empty string default", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      const select = screen.getByLabelText("Thinking Level");
      expect(select).toBeInTheDocument();
      expect((select as HTMLSelectElement).value).toBe("");
    });

    it("renders current thinking level from task", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "high" as const };
      render(<ModelSelectorTab task={taskWithThinking} addToast={mockAddToast} />);

      await waitForSelectors();

      const select = screen.getByLabelText("Thinking Level");
      expect((select as HTMLSelectElement).value).toBe("high");
    });

    it("saves thinking level when changed", async () => {
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...FAKE_TASK,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      await user.selectOptions(screen.getByLabelText("Thinking Level"), "high");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          thinkingLevel: "high",
        });
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Thinking level set to high",
          "success",
        );
      });
    });

    it("calls onTaskUpdated with server task after saving thinking level", async () => {
      const onTaskUpdated = vi.fn();
      const updatedTask = {
        ...FAKE_TASK,
        thinkingLevel: "high" as const,
      };
      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} onTaskUpdated={onTaskUpdated} />);

      await waitForSelectors();
      await user.selectOptions(screen.getByLabelText("Thinking Level"), "high");

      await waitFor(() => {
        expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      });
    });

    it("shows 'set to default' toast when clearing thinking level", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "high" as const };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...FAKE_TASK,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={taskWithThinking} addToast={mockAddToast} />);

      await waitForSelectors();

      // Select the "Default (...)" option (empty string) to clear the override
      await user.selectOptions(screen.getByLabelText("Thinking Level"), "");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          thinkingLevel: null,
        });
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Thinking level set to default (off)",
          "success",
        );
      });
    });

    it("shows thinking level badge for non-default values", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "medium" as const };
      render(<ModelSelectorTab task={taskWithThinking} addToast={mockAddToast} />);

      await waitForSelectors();

      expect(screen.getByText("medium")).toBeInTheDocument();
    });

    it("shows effective default thinking level in badge when settings.defaultThinkingLevel is 'high' and no task override", async () => {
      render(
        <ModelSelectorTab
          task={FAKE_TASK}
          addToast={mockAddToast}
          settings={{ defaultThinkingLevel: "high" }}
        />,
      );

      await waitForSelectors();

      const thinkingSection = getSection("Thinking Level");
      expect(within(thinkingSection!).getByText("Using default (high)")).toBeInTheDocument();
    });

    it("shows effective default thinking level in badge for all valid thinking levels", async () => {
      for (const level of ["minimal", "low", "medium", "high"] as const) {
        render(
          <ModelSelectorTab
            task={FAKE_TASK}
            addToast={mockAddToast}
            settings={{ defaultThinkingLevel: level }}
          />,
        );

        await waitForSelectors();

        const thinkingSection = getSection("Thinking Level");
        expect(within(thinkingSection!).getByText(`Using default (${level})`)).toBeInTheDocument();

        cleanup();
      }
    });

    it("shows toast with effective default when clearing thinking override with settings", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "high" as const };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...FAKE_TASK, // Return task without override
        ...updates,
      }));

      const user = userEvent.setup();
      render(
        <ModelSelectorTab
          task={taskWithThinking}
          addToast={mockAddToast}
          settings={{ defaultThinkingLevel: "high" }}
        />,
      );

      await waitForSelectors();

      // Select the "Default (...)" option (empty string) to clear the override
      await user.selectOptions(screen.getByLabelText("Thinking Level"), "");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          thinkingLevel: null,
        });
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Thinking level set to default (high)",
          "success",
        );
      });
    });

    it("shows 'Using default (off)' when settings is undefined and no task override", async () => {
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitForSelectors();

      const thinkingSection = getSection("Thinking Level");
      expect(within(thinkingSection!).getByText("Using default (off)")).toBeInTheDocument();
    });

    it("shows 'Using default (off)' toast when clearing with undefined settings", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "high" as const };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...FAKE_TASK,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={taskWithThinking} addToast={mockAddToast} />);

      await waitForSelectors();

      // Select the "Default (...)" option (empty string) to clear the override
      await user.selectOptions(screen.getByLabelText("Thinking Level"), "");

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Thinking level set to default (off)",
          "success",
        );
      });
    });

    it("saves 'off' explicitly as a real override when selected", async () => {
      const taskWithThinking = { ...FAKE_TASK, thinkingLevel: "high" as const };
      mockUpdateTask.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
        ...FAKE_TASK,
        ...updates,
      }));

      const user = userEvent.setup();
      render(<ModelSelectorTab task={taskWithThinking} addToast={mockAddToast} />);

      await waitForSelectors();

      // Select "off" explicitly (not the default clear option)
      await user.selectOptions(screen.getByLabelText("Thinking Level"), "off");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          thinkingLevel: "off",
        });
      });

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          "Thinking level set to off",
          "success",
        );
      });
    });
  });
});
