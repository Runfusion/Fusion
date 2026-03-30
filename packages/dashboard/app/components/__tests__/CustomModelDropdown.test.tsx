import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomModelDropdown } from "../CustomModelDropdown";
import type { ModelInfo } from "../../api";

// Mock ProviderIcon to avoid rendering actual icons
vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

const MOCK_MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  { provider: "ollama", id: "llama3", name: "Llama 3", reasoning: false, contextWindow: 4096 },
];

const defaultProps = {
  models: MOCK_MODELS,
  value: "",
  onChange: vi.fn(),
  label: "Test Model",
  id: "test-model",
};

describe("CustomModelDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders trigger button with placeholder text", () => {
    render(<CustomModelDropdown {...defaultProps} />);
    expect(screen.getByLabelText("Test Model")).toBeInTheDocument();
    expect(screen.getByText("Use default")).toBeInTheDocument();
  });

  it("renders trigger button with selected model name", () => {
    render(<CustomModelDropdown {...defaultProps} value="anthropic/claude-sonnet-4-5" />);
    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
  });

  it("shows provider icon in trigger when model is selected", () => {
    render(<CustomModelDropdown {...defaultProps} value="anthropic/claude-sonnet-4-5" />);
    expect(screen.getByTestId("provider-icon-anthropic")).toBeInTheDocument();
  });

  it("does not show provider icon in trigger when using default", () => {
    render(<CustomModelDropdown {...defaultProps} value="" />);
    expect(screen.queryByTestId(/provider-icon-/)).not.toBeInTheDocument();
  });

  it("opens dropdown when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
    expect(screen.getByText("4 models")).toBeInTheDocument();
  });

  it("groups models by provider in dropdown", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    // Provider groups should be visible with icons
    expect(screen.getByTestId("provider-icon-anthropic")).toBeInTheDocument();
    expect(screen.getByTestId("provider-icon-openai")).toBeInTheDocument();
    expect(screen.getByTestId("provider-icon-ollama")).toBeInTheDocument();
  });

  it("displays provider names in group headers", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("ollama")).toBeInTheDocument();
  });

  it("displays model names in dropdown", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
    expect(screen.getByText("Llama 3")).toBeInTheDocument();
  });

  it("displays model IDs next to names", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });

  it("calls onChange when a model is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CustomModelDropdown {...defaultProps} onChange={onChange} />);

    await user.click(screen.getByLabelText("Test Model"));
    await user.click(screen.getByText("GPT-4o"));

    expect(onChange).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("calls onChange with empty string when 'Use default' is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CustomModelDropdown {...defaultProps} value="anthropic/claude-sonnet-4-5" onChange={onChange} />);

    await user.click(screen.getByLabelText("Test Model"));

    // Find and click the "Use default" option (it's always first)
    const defaultOptions = screen.getAllByText("Use default");
    // Click the one in the dropdown list (not the trigger)
    const dropdownDefault = defaultOptions.find((el) => el.classList.contains("model-combobox-option-text--default"));
    if (dropdownDefault) {
      await user.click(dropdownDefault);
    }

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("filters models when typing in search input", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    const searchInput = screen.getByPlaceholderText("Filter models…");
    await user.type(searchInput, "openai");

    expect(screen.getByText("1 model")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
    expect(screen.queryByText("Claude Sonnet 4.5")).not.toBeInTheDocument();
  });

  it("filters models by model name", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    const searchInput = screen.getByPlaceholderText("Filter models…");
    await user.type(searchInput, "opus");

    expect(screen.getByText("1 model")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4")).toBeInTheDocument();
  });

  it("clear button clears filter and restores full list", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    const searchInput = screen.getByPlaceholderText("Filter models…");
    await user.type(searchInput, "openai");

    expect(screen.getByText("1 model")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Clear filter"));

    expect(searchInput).toHaveValue("");
    expect(screen.getByText("4 models")).toBeInTheDocument();
  });

  it("shows empty state when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    const searchInput = screen.getByPlaceholderText("Filter models…");
    await user.type(searchInput, "xyz123");

    expect(screen.getByText("0 models")).toBeInTheDocument();
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <CustomModelDropdown {...defaultProps} />
        <div data-testid="outside">Outside</div>
      </div>
    );

    await user.click(screen.getByLabelText("Test Model"));
    expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

    await user.click(screen.getByTestId("outside"));
    expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
  });

  it("closes dropdown on Escape key", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));
    expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
  });

  it("opens dropdown with arrow down key", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    screen.getByLabelText("Test Model").focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
    });
  });

  it("navigates with arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CustomModelDropdown {...defaultProps} onChange={onChange} />);

    screen.getByLabelText("Test Model").focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Filter models…")).toBeInTheDocument();
    });

    // Navigate down and press Enter
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
    });

    expect(onChange).toHaveBeenCalled();
  });

  it("is disabled when disabled prop is true", () => {
    render(<CustomModelDropdown {...defaultProps} disabled />);
    expect(screen.getByLabelText("Test Model")).toBeDisabled();
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} disabled />);

    await user.click(screen.getByLabelText("Test Model"));
    expect(screen.queryByPlaceholderText("Filter models…")).not.toBeInTheDocument();
  });

  it("has correct ARIA attributes", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    const trigger = screen.getByLabelText("Test Model");
    // Native button element - role is implicit
    expect(trigger.tagName.toLowerCase()).toBe("button");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("marks selected option with aria-selected", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} value="openai/gpt-4o" />);

    await user.click(screen.getByLabelText("Test Model"));

    // Find the selected option by looking for the selected class and aria-selected
    const options = screen.getAllByRole("option");
    const selectedOption = options.find((opt) => opt.getAttribute("aria-selected") === "true");
    expect(selectedOption).toHaveTextContent("GPT-4o");
  });

  it("shows 'Use default' option at the top", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown {...defaultProps} />);

    await user.click(screen.getByLabelText("Test Model"));

    // The "Use default" option should be visible
    const defaultOptions = screen.getAllByText("Use default");
    expect(defaultOptions.length).toBeGreaterThan(0);
  });

  it("shows fallback value text when model is not found", () => {
    render(<CustomModelDropdown {...defaultProps} value="unknown/unknown-model" />);
    expect(screen.getByText("unknown/unknown-model")).toBeInTheDocument();
  });
});
