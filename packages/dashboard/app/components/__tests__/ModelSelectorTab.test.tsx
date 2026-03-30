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

  it("groups models by provider in select options", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    expect(executorSelect).toBeInTheDocument();

    // Check options exist with model names
    expect(screen.getAllByText("Claude Sonnet 4.5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Claude Opus 4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("GPT-4o").length).toBeGreaterThanOrEqual(1);
  });

  it("enables Save button when selections change", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();

    // Select a model
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "anthropic/claude-sonnet-4-5");

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
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "anthropic/claude-sonnet-4-5");

    // Select validator model
    const validatorSelect = screen.getByLabelText("Validator Model");
    await user.selectOptions(validatorSelect, "openai/gpt-4o");

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

    // Select "Use default" (empty value)
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "");

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

    // Change selection
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "anthropic/claude-sonnet-4-5");

    // Reset
    await user.click(screen.getByText("Reset"));

    // Selection should be back to empty (Use default)
    expect(executorSelect).toHaveValue("");
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
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "anthropic/claude-sonnet-4-5");

    // Start save
    await user.click(screen.getByText("Save"));

    // Should show saving state
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(executorSelect).toBeDisabled();
  });

  it("shows error toast when save fails", async () => {
    const user = userEvent.setup();
    mockUpdateTask.mockRejectedValue(new Error("Save failed"));

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Select a model
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "anthropic/claude-sonnet-4-5");

    // Click save
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith("Save failed", "error");
    });
  });

  // Filter functionality tests
  it("renders filter input for executor and validator selectors", async () => {
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Both filter inputs should be present (placeholder text)
    const filterInputs = screen.getAllByPlaceholderText("Filter models…");
    expect(filterInputs.length).toBe(2);
  });

  it("filters executor models by provider name", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type "openai" in the executor filter
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "openai");

    // Should show result count
    expect(within(executorSection!).getByText("1 model")).toBeInTheDocument();

    // The select should only show openai models
    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("Use default");
    expect(options).toContain("GPT-4o");
    expect(options).not.toContain("Claude Sonnet 4.5");
    expect(options).not.toContain("Claude Opus 4");
  });

  it("filters models by model ID", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type "gpt-4o" in the executor filter
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "gpt-4o");

    // Should show only GPT-4o
    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("GPT-4o");
    expect(options).not.toContain("Claude Sonnet 4.5");
  });

  it("filters models by display name", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type "opus" (case insensitive)
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "opus");

    // Should show only Claude Opus 4
    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("Claude Opus 4");
    expect(options).not.toContain("Claude Sonnet 4.5");
    expect(options).not.toContain("GPT-4o");
  });

  it("supports multi-word filter (AND logic)", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type "anthropic claude" - both terms must match
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "anthropic claude");

    // Should show only anthropic claude models
    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("Claude Sonnet 4.5");
    expect(options).toContain("Claude Opus 4");
    expect(options).not.toContain("GPT-4o");
  });

  it("Use default option remains visible regardless of filter", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type a filter that matches nothing
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "nonexistent");

    // Use default should still be visible
    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("Use default");
  });

  it("clear button clears filter and restores full list", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type a filter
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "openai");

    // Verify filter is applied
    expect(within(executorSection!).getByText("1 model")).toBeInTheDocument();

    // Click clear button
    const clearButton = within(executorSection!).getByLabelText("Clear filter");
    await user.click(clearButton);

    // Filter should be cleared and all models should be visible
    expect(filterInput).toHaveValue("");
    expect(within(executorSection!).getByText("3 models")).toBeInTheDocument();

    const executorSelect = screen.getByLabelText("Executor Model") as HTMLSelectElement;
    const options = Array.from(executorSelect.options).map((o) => o.textContent);
    expect(options).toContain("Claude Sonnet 4.5");
    expect(options).toContain("Claude Opus 4");
    expect(options).toContain("GPT-4o");
  });

  it("shows empty state message when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Type a filter that matches nothing
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "xyz123");

    // Should show no results message
    expect(within(executorSection!).getByText("No models match 'xyz123'")).toBeInTheDocument();
    expect(within(executorSection!).getByText("0 models")).toBeInTheDocument();
  });

  it("selecting a model from filtered list works correctly", async () => {
    const user = userEvent.setup();
    mockUpdateTask.mockResolvedValue({ ...FAKE_TASK });

    render(<ModelSelectorTab task={FAKE_TASK} addToast={mockAddToast} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Executor Model")).toBeInTheDocument();
    });

    // Filter to show only openai
    const executorSection = screen.getByLabelText("Executor Model").closest(".form-group");
    const filterInput = within(executorSection!).getByPlaceholderText("Filter models…");
    await user.type(filterInput, "openai");

    // Select the filtered model
    const executorSelect = screen.getByLabelText("Executor Model");
    await user.selectOptions(executorSelect, "openai/gpt-4o");

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
