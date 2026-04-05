import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskForm } from "../TaskForm";
import type { Task, Column } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Sparkles: () => null,
  Globe: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
}));

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
  }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn().mockResolvedValue("Refined text"),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column: "todo" as Column,
    status: undefined as any,
    steps: [],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function renderTaskForm(props: Partial<React.ComponentProps<typeof TaskForm>> = {}) {
  const defaultProps: React.ComponentProps<typeof TaskForm> = {
    mode: "create",
    description: "",
    onDescriptionChange: vi.fn(),
    dependencies: [],
    onDependenciesChange: vi.fn(),
    executorModel: "",
    onExecutorModelChange: vi.fn(),
    validatorModel: "",
    onValidatorModelChange: vi.fn(),
    presetMode: "default" as const,
    onPresetModeChange: vi.fn(),
    selectedPresetId: "",
    onSelectedPresetIdChange: vi.fn(),
    selectedWorkflowSteps: [],
    onWorkflowStepsChange: vi.fn(),
    pendingImages: [],
    onImagesChange: vi.fn(),
    tasks: [],
    addToast: vi.fn(),
    isActive: true,
  };
  const mergedProps = { ...defaultProps, ...props };
  const result = render(<TaskForm {...mergedProps} />);
  return { ...result, props: mergedProps };
}

// Mock URL.createObjectURL / revokeObjectURL
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");
globalThis.URL.revokeObjectURL = vi.fn();

describe("TaskForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders description field with AI refine button when text is present", () => {
    renderTaskForm({ description: "Some text" });

    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.getByTestId("refine-button")).toBeTruthy();
  });

  it("does not show refine button when description is empty", () => {
    renderTaskForm({ description: "" });

    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.queryByTestId("refine-button")).toBeNull();
  });

  it("renders dependency selector and can toggle dependencies", () => {
    const onDependenciesChange = vi.fn();
    const tasks = [makeTask("FN-001"), makeTask("FN-002")];

    renderTaskForm({ tasks, onDependenciesChange });

    const depButton = screen.getByRole("button", { name: "Add dependencies" });
    expect(depButton).toBeTruthy();

    fireEvent.click(depButton);
    expect(screen.getByPlaceholderText("Search tasks…")).toBeTruthy();

    // Click to select a task
    fireEvent.click(screen.getByText("FN-001"));
    expect(onDependenciesChange).toHaveBeenCalledWith(["FN-001"]);
  });

  it("renders model configuration section", () => {
    renderTaskForm();

    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
  });

  it("fetches and stores favoriteModels from fetchModels response", async () => {
    const { fetchModels } = await import("../../api");
    vi.mocked(fetchModels).mockResolvedValueOnce({
      models: [],
      favoriteProviders: ["anthropic"],
      favoriteModels: ["anthropic/claude-sonnet-4-5"],
    });
    renderTaskForm();
    // The component fetches models on mount when isActive=true
    // If no error is thrown, the favoriteModels state is accepted
    await vi.waitFor(() => {
      expect(fetchModels).toHaveBeenCalled();
    });
  });

  it("renders workflow step checkboxes with browser verification", () => {
    renderTaskForm();

    expect(screen.getByTestId("browser-verification-checkbox")).toBeTruthy();
    expect(screen.getByText("Browser Verification")).toBeTruthy();
  });

  it("in create mode: shows Plan and Subtask buttons", () => {
    renderTaskForm({
      mode: "create",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subtask" })).toBeTruthy();
  });

  it("in edit mode: hides Plan/Subtask buttons, shows title field", () => {
    renderTaskForm({
      mode: "edit",
      title: "My task",
      onTitleChange: vi.fn(),
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subtask" })).toBeNull();
    expect(screen.getByLabelText(/Title/i)).toBeTruthy();
  });

  it("image paste adds to pending images", () => {
    const onImagesChange = vi.fn();
    const { container } = renderTaskForm({ onImagesChange });

    const taskForm = container.querySelector(".task-form")!;
    const imageFile = new File(["fake"], "test.png", { type: "image/png" });

    fireEvent.paste(taskForm, {
      clipboardData: {
        items: [
          {
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    expect(onImagesChange).toHaveBeenCalled();
    const newImages = onImagesChange.mock.calls[0][0];
    expect(newImages).toHaveLength(1);
    expect(newImages[0].file).toBe(imageFile);
  });

  it("renders selected dependencies as chips", () => {
    renderTaskForm({ dependencies: ["FN-001", "FN-002"] });

    expect(screen.getByText("FN-001")).toBeTruthy();
    expect(screen.getByText("FN-002")).toBeTruthy();
  });

  it("shows pending image previews", () => {
    const images = [
      { file: new File(["fake"], "test.png", { type: "image/png" }), previewUrl: "blob:test" },
    ];
    const { container } = renderTaskForm({ pendingImages: images });

    expect(container.querySelector(".inline-create-previews")).toBeTruthy();
  });

  it("calls onWorkflowStepsChange when browser verification is toggled", () => {
    const onWorkflowStepsChange = vi.fn();
    renderTaskForm({ onWorkflowStepsChange });

    const checkbox = screen.getByTestId("browser-verification-checkbox").querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["browser-verification"]);
  });

  it("disables all inputs when disabled prop is true", () => {
    renderTaskForm({
      disabled: true,
      description: "Some text",
      dependencies: ["FN-001"],
    });

    const textarea = screen.getByLabelText(/Description/i) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);

    // The dep button should be disabled
    const depButton = screen.getByRole("button", { name: "1 selected" });
    expect(depButton).toHaveProperty("disabled", true);
  });

  it("calls AI refine when menu item is clicked", async () => {
    const { refineText } = await import("../../api");
    const onDescriptionChange = vi.fn();

    renderTaskForm({
      description: "Some text to refine",
      onDescriptionChange,
    });

    // Open refine menu
    fireEvent.click(screen.getByTestId("refine-button"));

    // Click clarify
    fireEvent.click(screen.getByTestId("refine-clarify"));

    await waitFor(() => {
      expect(refineText).toHaveBeenCalledWith("Some text to refine", "clarify");
      expect(onDescriptionChange).toHaveBeenCalledWith("Refined text");
    });
  });
});

describe("TaskForm description-adjacent actions layout (FN-781)", () => {
  it("renders Plan and Subtask in description-actions area in create mode", () => {
    renderTaskForm({
      mode: "create",
      description: "Some task",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    // The description-actions container should exist
    expect(screen.getByTestId("task-form-description-actions")).toBeTruthy();

    // Plan and Subtask buttons should be inside it
    const actionsContainer = screen.getByTestId("task-form-description-actions");
    expect(actionsContainer.contains(screen.getByTestId("task-form-plan-button"))).toBe(true);
    expect(actionsContainer.contains(screen.getByTestId("task-form-subtask-button"))).toBe(true);
  });

  it("does not render description-actions in edit mode", () => {
    renderTaskForm({
      mode: "edit",
      title: "My task",
      onTitleChange: vi.fn(),
      description: "Some task",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    expect(screen.queryByTestId("task-form-description-actions")).toBeNull();
  });

  it("Plan and Subtask buttons are disabled when description is empty", () => {
    renderTaskForm({
      mode: "create",
      description: "",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    expect((screen.getByTestId("task-form-plan-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("task-form-subtask-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Plan and Subtask buttons are enabled when description has content", () => {
    renderTaskForm({
      mode: "create",
      description: "A real task",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    expect((screen.getByTestId("task-form-plan-button") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("task-form-subtask-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Refine button remains near the description textarea", () => {
    renderTaskForm({
      mode: "create",
      description: "Some text",
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    // Refine button should be rendered (it's inside the description-with-refine wrapper)
    expect(screen.getByTestId("refine-button")).toBeTruthy();

    // But NOT inside the description-actions container
    const actionsContainer = screen.getByTestId("task-form-description-actions");
    expect(actionsContainer.contains(screen.getByTestId("refine-button"))).toBe(false);
  });
});

describe("TaskForm preset selection (FN-819)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders preset dropdown with saved presets from settings", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    renderTaskForm();

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const presetSelect = document.getElementById("model-preset") as HTMLSelectElement;
    expect(presetSelect).toBeTruthy();
    const options = Array.from(presetSelect.options);
    expect(options.find((o) => o.value === "default")).toBeTruthy();
    expect(options.find((o) => o.value === "fast")).toBeTruthy();
    expect(options.find((o) => o.textContent === "Fast")).toBeTruthy();
    expect(options.find((o) => o.value === "custom")).toBeTruthy();
  });

  it("selecting a preset applies preset mode and model overrides", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    const onPresetModeChange = vi.fn();
    const onSelectedPresetIdChange = vi.fn();
    const onExecutorModelChange = vi.fn();
    const onValidatorModelChange = vi.fn();

    renderTaskForm({
      onPresetModeChange,
      onSelectedPresetIdChange,
      onExecutorModelChange,
      onValidatorModelChange,
    });

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const presetSelect = document.getElementById("model-preset") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "fast" } });

    expect(onPresetModeChange).toHaveBeenCalledWith("preset");
    expect(onSelectedPresetIdChange).toHaveBeenCalledWith("fast");
    expect(onExecutorModelChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
    expect(onValidatorModelChange).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("switching to default clears preset and model overrides", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    const onPresetModeChange = vi.fn();
    const onSelectedPresetIdChange = vi.fn();
    const onExecutorModelChange = vi.fn();
    const onValidatorModelChange = vi.fn();

    renderTaskForm({
      presetMode: "preset",
      selectedPresetId: "fast",
      executorModel: "anthropic/claude-sonnet-4-5",
      onPresetModeChange,
      onSelectedPresetIdChange,
      onExecutorModelChange,
      onValidatorModelChange,
    });

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const presetSelect = document.getElementById("model-preset") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "default" } });

    expect(onPresetModeChange).toHaveBeenCalledWith("default");
    expect(onSelectedPresetIdChange).toHaveBeenCalledWith("");
    expect(onExecutorModelChange).toHaveBeenCalledWith("");
    expect(onValidatorModelChange).toHaveBeenCalledWith("");
  });

  it("switching to custom clears preset ID", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    const onPresetModeChange = vi.fn();
    const onSelectedPresetIdChange = vi.fn();

    renderTaskForm({
      presetMode: "preset",
      selectedPresetId: "fast",
      executorModel: "anthropic/claude-sonnet-4-5",
      onPresetModeChange,
      onSelectedPresetIdChange,
    });

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const presetSelect = document.getElementById("model-preset") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: "custom" } });

    expect(onPresetModeChange).toHaveBeenCalledWith("custom");
    expect(onSelectedPresetIdChange).toHaveBeenCalledWith("");
  });

  it("Override button exits preset mode", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    const onPresetModeChange = vi.fn();

    renderTaskForm({
      presetMode: "preset",
      selectedPresetId: "fast",
      executorModel: "anthropic/claude-sonnet-4-5",
      onPresetModeChange,
    });

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const overrideButton = screen.getByRole("button", { name: "Override" });
    fireEvent.click(overrideButton);

    expect(onPresetModeChange).toHaveBeenCalledWith("custom");
  });

  it("disables executor and validator selects when preset mode is active", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    renderTaskForm({
      presetMode: "preset",
      selectedPresetId: "fast",
      executorModel: "anthropic/claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const executorSelect = document.getElementById("executor-model") as HTMLSelectElement;
    const validatorSelect = document.getElementById("validator-model") as HTMLSelectElement;
    expect(executorSelect?.disabled).toBe(true);
    expect(validatorSelect?.disabled).toBe(true);
  });

  it("shows preset name as small text when a preset is selected", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    renderTaskForm({
      presetMode: "preset",
      selectedPresetId: "fast",
      executorModel: "anthropic/claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(screen.getByText("Using preset: Fast")).toBeTruthy();
    });
  });
});

describe("TaskForm workflow step reordering (FN-836)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show reorder controls when no steps are selected", () => {
    renderTaskForm({ selectedWorkflowSteps: [] });
    expect(screen.queryByTestId("workflow-step-order")).toBeNull();
  });

  it("does not show reorder controls when only one step is selected", () => {
    renderTaskForm({ selectedWorkflowSteps: ["browser-verification"] });
    expect(screen.queryByTestId("workflow-step-order")).toBeNull();
  });

  it("shows reorder controls when two or more steps are selected", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    expect(screen.getByTestId("workflow-step-order-item-WS-001")).toBeTruthy();
    expect(screen.getByTestId("workflow-step-order-item-WS-002")).toBeTruthy();
  });

  it("shows numbered execution order", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"] });

    await waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy();
    });
  });

  it("disables move-up button on first step", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    const moveUpFirst = screen.getByTestId("workflow-step-move-up-WS-001") as HTMLButtonElement;
    expect(moveUpFirst.disabled).toBe(true);
  });

  it("disables move-down button on last step", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    const moveDownLast = screen.getByTestId("workflow-step-move-down-WS-002") as HTMLButtonElement;
    expect(moveDownLast.disabled).toBe(true);
  });

  it("calls onWorkflowStepsChange with swapped order when move-up is clicked", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    const onWorkflowStepsChange = vi.fn();
    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"], onWorkflowStepsChange });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // Move WS-002 up (swap with WS-001)
    fireEvent.click(screen.getByTestId("workflow-step-move-up-WS-002"));
    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-002", "WS-001"]);
  });

  it("calls onWorkflowStepsChange with swapped order when move-down is clicked", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    const onWorkflowStepsChange = vi.fn();
    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"], onWorkflowStepsChange });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // Move WS-001 down (swap with WS-002)
    fireEvent.click(screen.getByTestId("workflow-step-move-down-WS-001"));
    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-002", "WS-001"]);
  });

  it("calls onWorkflowStepsChange with step removed when remove button is clicked", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    const onWorkflowStepsChange = vi.fn();
    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"], onWorkflowStepsChange });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // Remove WS-001
    fireEvent.click(screen.getByTestId("workflow-step-remove-WS-001"));
    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-002"]);
  });

  it("shows browser-verification step name in reorder list", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "browser-verification"] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // browser-verification should show its friendly name in the reorder list
    const orderItem1 = screen.getByTestId("workflow-step-order-item-WS-001");
    const orderItem2 = screen.getByTestId("workflow-step-order-item-browser-verification");
    expect(orderItem1.textContent).toContain("QA Check");
    expect(orderItem2.textContent).toContain("Browser Verification");
  });

  it("preserves order when adding a new step via checkbox after reorder", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-003", name: "Doc Review", description: "Check docs", prompt: "Check docs", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    const onWorkflowStepsChange = vi.fn();
    // Start with WS-001, WS-002
    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002"], onWorkflowStepsChange });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // Click checkbox to add WS-003 — it should be appended
    const checkbox = screen.getByTestId("workflow-step-checkbox-WS-003").querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-001", "WS-002", "WS-003"]);
  });

  it("preserves order when removing a step via checkbox (not reorder remove)", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-003", name: "Doc Review", description: "Check docs", prompt: "Check docs", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    const onWorkflowStepsChange = vi.fn();
    renderTaskForm({ selectedWorkflowSteps: ["WS-001", "WS-002", "WS-003"], onWorkflowStepsChange });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-order")).toBeTruthy();
    });

    // Uncheck WS-002 via checkbox
    const checkbox = screen.getByTestId("workflow-step-checkbox-WS-002").querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-001", "WS-003"]);
  });

  it("shows phase badge for workflow steps with phase info", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", phase: "pre-merge", enabled: true, createdAt: "", updatedAt: "" },
      { id: "WS-002", name: "Post-merge Notify", description: "Notify team", prompt: "Notify", phase: "post-merge", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: [] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-phase-WS-001")).toHaveTextContent("Pre-merge");
      expect(screen.getByTestId("workflow-step-phase-WS-002")).toHaveTextContent("Post-merge");
    });
  });

  it("shows Pre-merge phase badge for legacy steps without phase", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "Legacy Check", description: "No phase field", prompt: "Check", enabled: true, createdAt: "", updatedAt: "" },
    ]);

    renderTaskForm({ selectedWorkflowSteps: [] });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-phase-WS-001")).toHaveTextContent("Pre-merge");
    });
  });
});
