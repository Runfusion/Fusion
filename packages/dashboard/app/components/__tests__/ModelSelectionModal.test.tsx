import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModelSelectionModal } from "../ModelSelectionModal";
import type { ModelInfo } from "../../api";
import type { ModelPreset } from "@fusion/core";

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

const MOCK_PRESETS: ModelPreset[] = [
  {
    id: "fast",
    name: "Fast",
    executorProvider: "anthropic",
    executorModelId: "claude-sonnet-4-5",
  },
  {
    id: "thorough",
    name: "Thorough",
    executorProvider: "openai",
    executorModelId: "gpt-4o",
    validatorProvider: "anthropic",
    validatorModelId: "claude-sonnet-4-5",
  },
];

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Brain: () => null,
  X: () => null,
}));

// Mock applyPresetToSelection
vi.mock("../../utils/modelPresets", () => ({
  applyPresetToSelection: vi.fn((preset: ModelPreset | undefined) => {
    if (!preset) return { executorValue: "", validatorValue: "" };
    return {
      executorValue: preset.executorProvider && preset.executorModelId
        ? `${preset.executorProvider}/${preset.executorModelId}`
        : "",
      validatorValue: preset.validatorProvider && preset.validatorModelId
        ? `${preset.validatorProvider}/${preset.validatorModelId}`
        : "",
    };
  }),
}));

// Mock CustomModelDropdown
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    id,
    label,
    value,
    onChange,
    models,
    placeholder,
  }: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    models: ModelInfo[];
    placeholder: string;
  }) => (
    <div data-testid={`mock-dropdown-${id}`}>
      <span data-testid={`dropdown-label-${id}`}>{label}</span>
      <span data-testid={`dropdown-value-${id}`}>{value || "empty"}</span>
      <select
        data-testid={`dropdown-select-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {models.map((m) => (
          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  ),
}));

function renderModelSelectionModal(props = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    models: MOCK_MODELS,
    executorValue: "",
    validatorValue: "",
    onExecutorChange: vi.fn(),
    onValidatorChange: vi.fn(),
    modelsLoading: false,
    modelsError: null,
    onRetry: vi.fn(),
  };
  return render(<ModelSelectionModal {...defaultProps} {...props} />);
}

describe("ModelSelectionModal", () => {
  it("renders null when isOpen is false", () => {
    renderModelSelectionModal({ isOpen: false });
    expect(screen.queryByTestId("model-selection-modal")).toBeNull();
  });

  it("renders when isOpen is true", () => {
    renderModelSelectionModal({ isOpen: true });
    expect(screen.getByTestId("model-selection-modal")).toBeTruthy();
  });

  it("shows loading state when modelsLoading is true", () => {
    renderModelSelectionModal({ modelsLoading: true });
    expect(screen.getByText("Loading models…")).toBeTruthy();
  });

  it("shows error state with retry button when modelsError is set", () => {
    const onRetry = vi.fn();
    renderModelSelectionModal({ modelsError: "Failed to fetch", onRetry });

    expect(screen.getByText("Failed to fetch")).toBeTruthy();

    const retryButton = screen.getByTestId("model-selection-retry");
    expect(retryButton).toBeTruthy();

    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows empty state when no models available", () => {
    renderModelSelectionModal({ models: [] });
    expect(
      screen.getByText(/No models available. Configure authentication in Settings/),
    ).toBeTruthy();
  });

  it("renders CustomModelDropdown for executor and validator", () => {
    renderModelSelectionModal();

    expect(screen.getByTestId("mock-dropdown-model-selection-executor")).toBeTruthy();
    expect(screen.getByTestId("mock-dropdown-model-selection-validator")).toBeTruthy();
  });

  it("calls onClose when clicking close button", () => {
    const onClose = vi.fn();
    renderModelSelectionModal({ onClose });

    const closeButton = screen.getByTestId("model-selection-close");
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking overlay", () => {
    const onClose = vi.fn();
    renderModelSelectionModal({ onClose });

    const overlay = screen.getByTestId("model-selection-modal");
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when pressing Escape key", async () => {
    const onClose = vi.fn();
    renderModelSelectionModal({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("calls onExecutorChange when executor selection changes", () => {
    const onExecutorChange = vi.fn();
    renderModelSelectionModal({ onExecutorChange });

    const executorSelect = screen.getByTestId("dropdown-select-model-selection-executor");
    fireEvent.change(executorSelect, { target: { value: "anthropic/claude-sonnet-4-5" } });

    expect(onExecutorChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
  });

  it("calls onValidatorChange when validator selection changes", () => {
    const onValidatorChange = vi.fn();
    renderModelSelectionModal({ onValidatorChange });

    const validatorSelect = screen.getByTestId("dropdown-select-model-selection-validator");
    fireEvent.change(validatorSelect, { target: { value: "openai/gpt-4o" } });

    expect(onValidatorChange).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("displays executor badge with selected model", () => {
    renderModelSelectionModal({
      executorValue: "anthropic/claude-sonnet-4-5",
    });

    const executorBadge = screen.getByTestId("executor-badge");
    expect(executorBadge.textContent).toBe("anthropic/claude-sonnet-4-5");
    expect(executorBadge.classList.contains("model-badge-custom")).toBe(true);
  });

  it("displays executor badge with 'Using default' when no selection", () => {
    renderModelSelectionModal({ executorValue: "" });

    const executorBadge = screen.getByTestId("executor-badge");
    expect(executorBadge.textContent).toBe("Using default");
    expect(executorBadge.classList.contains("model-badge-default")).toBe(true);
  });

  it("displays validator badge with selected model", () => {
    renderModelSelectionModal({
      validatorValue: "openai/gpt-4o",
    });

    const validatorBadge = screen.getByTestId("validator-badge");
    expect(validatorBadge.textContent).toBe("openai/gpt-4o");
    expect(validatorBadge.classList.contains("model-badge-custom")).toBe(true);
  });

  it("displays validator badge with 'Using default' when no selection", () => {
    renderModelSelectionModal({ validatorValue: "" });

    const validatorBadge = screen.getByTestId("validator-badge");
    expect(validatorBadge.textContent).toBe("Using default");
    expect(validatorBadge.classList.contains("model-badge-default")).toBe(true);
  });

  it("calls onClose when clicking Done button", () => {
    const onClose = vi.fn();
    renderModelSelectionModal({ onClose });

    const doneButton = screen.getByTestId("model-selection-done");
    fireEvent.click(doneButton);

    expect(onClose).toHaveBeenCalled();
  });

  it("passes correct props to executor dropdown", () => {
    renderModelSelectionModal({
      executorValue: "openai/gpt-4o",
    });

    expect(screen.getByTestId("dropdown-value-model-selection-executor").textContent).toBe(
      "openai/gpt-4o",
    );
    expect(screen.getByTestId("dropdown-label-model-selection-executor").textContent).toBe(
      "Executor Model",
    );
  });

  it("passes correct props to validator dropdown", () => {
    renderModelSelectionModal({
      validatorValue: "anthropic/claude-sonnet-4-5",
    });

    expect(screen.getByTestId("dropdown-value-model-selection-validator").textContent).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(screen.getByTestId("dropdown-label-model-selection-validator").textContent).toBe(
      "Validator Model",
    );
  });

  describe("Preset selection", () => {
    it("does not show preset selector when presets prop is omitted", () => {
      renderModelSelectionModal();
      expect(screen.queryByTestId("model-selection-preset")).toBeNull();
      expect(screen.queryByTestId("preset-badge")).toBeNull();
    });

    it("does not show preset selector when presets array is empty", () => {
      renderModelSelectionModal({
        presets: [],
        onPresetChange: vi.fn(),
      });
      expect(screen.queryByTestId("model-selection-preset")).toBeNull();
    });

    it("does not show preset selector when onPresetChange is not provided", () => {
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
      });
      expect(screen.queryByTestId("model-selection-preset")).toBeNull();
    });

    it("shows preset selector when presets and onPresetChange are provided", () => {
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: undefined,
        onPresetChange: vi.fn(),
      });
      expect(screen.getByTestId("model-selection-preset")).toBeTruthy();
      expect(screen.getByTestId("preset-badge")).toBeTruthy();
    });

    it("renders preset options in the select dropdown", () => {
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        onPresetChange: vi.fn(),
      });
      const select = screen.getByTestId("model-selection-preset") as HTMLSelectElement;
      expect(select).toBeTruthy();

      // default, separator (disabled), fast, thorough, custom
      const options = Array.from(select.options);
      expect(options.map((o) => o.value)).toEqual(["default", "──────────", "fast", "thorough", "custom"]);
    });

    it("shows 'Use default' badge when no preset is selected", () => {
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        onPresetChange: vi.fn(),
      });
      const badge = screen.getByTestId("preset-badge");
      expect(badge.textContent).toBe("Use default");
      expect(badge.classList.contains("model-badge-default")).toBe(true);
    });

    it("shows preset name badge when a preset is selected", () => {
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: "fast",
        onPresetChange: vi.fn(),
      });
      const badge = screen.getByTestId("preset-badge");
      expect(badge.textContent).toBe("Fast");
      expect(badge.classList.contains("model-badge-custom")).toBe(true);
    });

    it("calls onPresetChange with preset id and applies executor/validator when selecting a preset", () => {
      const onPresetChange = vi.fn();
      const onExecutorChange = vi.fn();
      const onValidatorChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        onPresetChange,
        onExecutorChange,
        onValidatorChange,
      });

      const select = screen.getByTestId("model-selection-preset");
      fireEvent.change(select, { target: { value: "thorough" } });

      expect(onPresetChange).toHaveBeenCalledWith("thorough");
      expect(onExecutorChange).toHaveBeenCalledWith("openai/gpt-4o");
      expect(onValidatorChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
    });

    it("clears executor/validator when selecting 'Use default'", () => {
      const onPresetChange = vi.fn();
      const onExecutorChange = vi.fn();
      const onValidatorChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: "fast",
        onPresetChange,
        onExecutorChange,
        onValidatorChange,
      });

      const select = screen.getByTestId("model-selection-preset");
      fireEvent.change(select, { target: { value: "default" } });

      expect(onPresetChange).toHaveBeenCalledWith(undefined);
      expect(onExecutorChange).toHaveBeenCalledWith("");
      expect(onValidatorChange).toHaveBeenCalledWith("");
    });

    it("clears preset mode without changing models when selecting 'Custom'", () => {
      const onPresetChange = vi.fn();
      const onExecutorChange = vi.fn();
      const onValidatorChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: "fast",
        executorValue: "anthropic/claude-sonnet-4-5",
        onPresetChange,
        onExecutorChange,
        onValidatorChange,
      });

      const select = screen.getByTestId("model-selection-preset");
      fireEvent.change(select, { target: { value: "custom" } });

      expect(onPresetChange).toHaveBeenCalledWith(undefined);
      // Should NOT change executor/validator when switching to custom
      expect(onExecutorChange).not.toHaveBeenCalled();
      expect(onValidatorChange).not.toHaveBeenCalled();
    });

    it("clears preset mode when executor is manually changed", () => {
      const onPresetChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: "fast",
        onPresetChange,
      });

      const executorSelect = screen.getByTestId("dropdown-select-model-selection-executor");
      fireEvent.change(executorSelect, { target: { value: "openai/gpt-4o" } });

      expect(onPresetChange).toHaveBeenCalledWith(undefined);
    });

    it("clears preset mode when validator is manually changed", () => {
      const onPresetChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: "fast",
        onPresetChange,
      });

      const validatorSelect = screen.getByTestId("dropdown-select-model-selection-validator");
      fireEvent.change(validatorSelect, { target: { value: "openai/gpt-4o" } });

      expect(onPresetChange).toHaveBeenCalledWith(undefined);
    });

    it("does not call onPresetChange when manually changing executor with no preset selected", () => {
      const onPresetChange = vi.fn();
      renderModelSelectionModal({
        presets: MOCK_PRESETS,
        selectedPresetId: undefined,
        onPresetChange,
      });

      const executorSelect = screen.getByTestId("dropdown-select-model-selection-executor");
      fireEvent.change(executorSelect, { target: { value: "openai/gpt-4o" } });

      expect(onPresetChange).not.toHaveBeenCalled();
    });
  });
});
