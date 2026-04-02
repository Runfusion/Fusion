import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(screen.queryByText("Reset")).not.toBeInTheDocument();
  });

  it("shows 'Using default' when no model overrides are set", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitForSelectors();

    const executorSection = getSection("Executor Model");
    expect(within(executorSection!).getByText("Using default")).toBeInTheDocument();

    const validatorSection = getSection("Validator Model");
    expect(within(validatorSection!).getByText("Using default")).toBeInTheDocument();
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
      expect(mockUpdateTask).toHaveBeenNthCalledWith(1, "FN-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: null,
        validatorModelId: null,
      });
    });

    await selectOption("Validator Model", "GPT-4o");

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenNthCalledWith(2, "FN-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
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
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
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
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        modelProvider: null,
        modelId: null,
        validatorModelProvider: null,
        validatorModelId: null,
      });
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
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
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
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        modelProvider: null,
        modelId: null,
        validatorModelProvider: null,
        validatorModelId: null,
      });
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

  it("disables both selectors while saving", async () => {
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
    });

    resolveUpdate?.({
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(getSelector("Executor Model")).not.toBeDisabled();
      expect(getSelector("Validator Model")).not.toBeDisabled();
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

      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: null,
        validatorModelId: null,
      });
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
        expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
          modelProvider: "openai",
          modelId: "gpt-4o",
          validatorModelProvider: null,
          validatorModelId: null,
        });
      });
    });
  });
});
