import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelectorTab } from "../ModelSelectorTab";
import type { Task } from "@kb/core";
import * as api from "../../api";

// Mock the API module
vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof api>("../../api");
  return {
    ...actual,
    fetchModels: vi.fn(),
    updateTask: vi.fn(),
  };
});

const mockFetchModels = api.fetchModels as ReturnType<typeof vi.fn>;
const mockUpdateTask = api.updateTask as ReturnType<typeof vi.fn>;

const FAKE_TASK: Task = {
  id: "KB-001",
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

describe("ModelSelectorTab", () => {
  const mockAddToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchModels.mockResolvedValue(MOCK_MODELS);
  });

  it("renders loading state initially", () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);
    expect(screen.getByText("Loading available models…")).toBeInTheDocument();
  });

  it("renders model selectors after loading", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Validator Model")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Reset")).toBeInTheDocument();
  });

  it("shows 'Using default' when no model overrides are set", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    expect(within(executorSection!).getByText("Using default")).toBeInTheDocument();

    const validatorSection = screen.getByLabelText("Validator Model").closest(".form-group");
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

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    expect(screen.getByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
  });

  it("opens combobox when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Click the executor combobox trigger
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);

    // Dropdown should be visible with models
    expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
    expect(screen.getByText("3 models")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
  });

  it("groups models by provider in dropdown", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Open the combobox
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);

    // Check provider headers are present
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
  });

  it("enables Save button when selections change", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();

    // Open combobox and select a model
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    
    // Click on a model option
    const modelOption = screen.getByText("Claude Sonnet 4.5");
    await user.click(modelOption);

    expect(saveButton).toBeEnabled();
  });

  it("calls updateTask with correct model fields on save", async () => {
    const user = userEvent.setup();
    mockUpdateTask.mockResolvedValue({ ...FAKE_TASK });

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Select executor model
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    // Select validator model
    const validatorTrigger = screen.getByLabelText("Validator Model");
    await user.click(validatorTrigger);
    await user.click(screen.getByText("GPT-4o"));

    // Click save
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("KB-001", {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
    });

    expect(mockAddToast).toHaveBeenCalledWith("Model settings saved", "success");
  });

  it("calls updateTask with null to clear models on 'Use default' selection", async () => {
    const user = userEvent.setup();
    const taskWithModels = {
      ...FAKE_TASK,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };
    mockUpdateTask.mockResolvedValue({ ...taskWithModels });

    render(<ModelSelectorTab task={taskWithModels} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Open combobox
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    
    // Select "Use default"
    const defaultOption = screen.getAllByText("Use default").find(
      el => el.classList.contains("model-combobox-option-text--default")
    ) || screen.getAllByText("Use default")[0];
    await user.click(defaultOption);

    // Click save
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("KB-001", {
        modelProvider: undefined,
        modelId: undefined,
        validatorModelProvider: undefined,
        validatorModelId: undefined,
      });
    });
  });

  it("resets selections to original values when Reset is clicked", async () => {
    const user = userEvent.setup();

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Open and select a model
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    // Verify Save is enabled
    expect(screen.getByText("Save")).toBeEnabled();

    // Reset
    await user.click(screen.getByText("Reset"));

    // Save should be disabled again (no changes)
    expect(screen.getByText("Save")).toBeDisabled();
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
    mockFetchModels.mockResolvedValue([]);

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByText(/No models available/)).toBeInTheDocument();
    });
  });

  it("disables inputs while saving", async () => {
    const user = userEvent.setup();
    mockUpdateTask.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ...FAKE_TASK }), 100)));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Select a model
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    // Start save
    await user.click(screen.getByText("Save"));

    // Should show saving state
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(executorTrigger).toBeDisabled();
  });

  it("shows error toast when save fails", async () => {
    const user = userEvent.setup();
    mockUpdateTask.mockRejectedValue(new Error("Save failed"));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Select a model
    const executorTrigger = screen.getByLabelText("Executor Model");
    await user.click(executorTrigger);
    await user.click(screen.getByText("Claude Sonnet 4.5"));

    // Click save
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Save failed", "error");
    });
  });

  // Combobox-specific tests
  describe("Combobox behavior", () => {
    it("filters models when typing in search input", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type filter text
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");

      // Should show filtered results
      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("GPT-4o")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
      expect(screen.queryByText("Claude Opus 4")).not.toBeInTheDocument();
    });

    it("filters models by model ID", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type model ID
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "gpt-4o");

      // Should show only GPT-4o
      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("GPT-4o")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
    });

    it("filters models by display name", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type display name
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "opus");

      // Should show only Opus
      expect(screen.getByText("1 model")).toBeInTheDocument();
      expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
      expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
    });

    it("supports multi-word filter (AND logic)", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type multi-word filter
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "anthropic claude");

      // Should show only anthropic models
      expect(screen.getByText("2 models")).toBeInTheDocument();
      expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
      expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
      expect(screen.queryByText("GPT-4o")).not.toBeInTheDocument();
    });

    it("clear button clears filter and restores full list", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type a filter
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");

      // Verify filter is applied
      expect(screen.getByText("1 model")).toBeInTheDocument();

      // Click clear button
      const clearButton = screen.getByLabelText("Clear filter");
      await user.click(clearButton);

      // Filter should be cleared
      expect(searchInput).toHaveValue("");
      expect(screen.getByText("3 models")).toBeInTheDocument();
    });

    it("shows empty state message when filter matches nothing", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Type a filter that matches nothing
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "xyz123");

      // Should show no results message
      expect(screen.getByText("0 models")).toBeInTheDocument();
      expect(screen.getByText(/No models match/)).toBeInTheDocument();
    });

    it("closes dropdown when clicking outside", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Dropdown should be visible
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

      // Click outside (on the intro text)
      await user.click(screen.getByText(/Override the AI models/));

      // Dropdown should be closed
      expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
    });

    it("closes dropdown on Escape key", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Dropdown should be visible
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

      // Press Escape
      await user.keyboard("{Escape}");

      // Dropdown should be closed
      expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
    });

    it("navigates with arrow keys and selects with Enter", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Focus and open combobox with arrow down
      const executorTrigger = screen.getByLabelText("Executor Model");
      executorTrigger.focus();
      await user.keyboard("{ArrowDown}");

      // Dropdown should be visible
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
      });

      // Navigate down and press Enter to select
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{Enter}");

      // Dropdown should be closed and Save button should be enabled
      await waitFor(() => {
        expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
      });
      expect(screen.getByText("Save")).toBeEnabled();
    });

    it("Use default option is always visible", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Use default should be visible
      const defaultOptions = screen.getAllByText("Use default");
      expect(defaultOptions.length).toBeGreaterThan(0);

      // Type a filter that matches nothing
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "nonexistent123");

      // Use default should still be visible
      expect(screen.getAllByText("Use default").length).toBeGreaterThan(0);
    });

    it("shows model ID next to model name", async () => {
      const user = userEvent.setup();
      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Model IDs should be visible next to names
      expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
      expect(screen.getByText("claude-opus-4")).toBeInTheDocument();
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    });

    it("selecting a model from filtered list works correctly", async () => {
      const user = userEvent.setup();
      mockUpdateTask.mockResolvedValue({ ...FAKE_TASK });

      render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
      });

      // Open combobox
      const executorTrigger = screen.getByLabelText("Executor Model");
      await user.click(executorTrigger);

      // Filter to show only openai
      const searchInput = screen.getByPlaceholderText("Filter models…");
      await user.type(searchInput, "openai");

      // Select the filtered model
      const modelOption = screen.getByText("GPT-4o");
      await user.click(modelOption);

      // Save
      await user.click(screen.getByText("Save"));

      // Verify correct model was saved
      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("KB-001", {
          modelProvider: "openai",
          modelId: "gpt-4o",
          validatorModelProvider: undefined,
          validatorModelId: undefined,
        });
      });
    });
  });
});
