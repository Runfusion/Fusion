import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TaskForm } from "../TaskForm";
import type { Task, Column } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Sparkles: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  Paperclip: () => null,
  Flag: () => null,
  Zap: () => null,
  Brain: () => null,
  Server: () => null,
  Cpu: () => null,
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
  // U6/R3: TaskForm now fetches whole workflows (not steps) for the picker.
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  refineText: vi.fn().mockResolvedValue("Refined text"),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchGitBranches: vi.fn().mockResolvedValue([]),
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
    selectedWorkflowId: undefined,
    onWorkflowIdChange: vi.fn(),
    pendingImages: [],
    onImagesChange: vi.fn(),
    tasks: [],
    addToast: vi.fn(),
    isActive: true,
    reviewLevel: undefined,
    onReviewLevelChange: vi.fn(),
  };
  const mergedProps = { ...defaultProps, ...props };
  const result = render(<TaskForm {...mergedProps} />);
  return { ...result, props: mergedProps };
}

async function openWorkflowDropdown() {
  const trigger = await screen.findByTestId("task-workflow-dropdown-trigger");
  fireEvent.click(trigger);
  return screen.getByTestId("task-workflow-dropdown-menu");
}

function renderTaskFormWithDescriptionState(props: Partial<React.ComponentProps<typeof TaskForm>> = {}) {
  const defaultProps: React.ComponentProps<typeof TaskForm> = {
    mode: "edit",
    title: "Task",
    onTitleChange: vi.fn(),
    description: "",
    onDescriptionChange: vi.fn(),
    dependencies: [],
    onDependenciesChange: vi.fn(),
    executorModel: "",
    onExecutorModelChange: vi.fn(),
    validatorModel: "",
    onValidatorModelChange: vi.fn(),
    presetMode: "default",
    onPresetModeChange: vi.fn(),
    selectedPresetId: "",
    onSelectedPresetIdChange: vi.fn(),
    pendingImages: [],
    onImagesChange: vi.fn(),
    tasks: [],
    addToast: vi.fn(),
    isActive: true,
    reviewLevel: undefined,
    onReviewLevelChange: vi.fn(),
  };

  const mergedProps = { ...defaultProps, ...props };

  function ControlledTaskForm() {
    const [description, setDescription] = useState(mergedProps.description);
    return (
      <TaskForm
        {...mergedProps}
        description={description}
        onDescriptionChange={setDescription}
      />
    );
  }

  return render(<ControlledTaskForm />);
}

// Mock URL.createObjectURL / revokeObjectURL
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-url");
globalThis.URL.revokeObjectURL = vi.fn();

describe("TaskForm", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { fetchGitBranches } = await import("../../api");
    vi.mocked(fetchGitBranches).mockResolvedValue([]);
  });

  it("renders xhigh in the shared thinking-level selector", async () => {
    renderTaskForm({
      thinkingLevel: "",
      onThinkingLevelChange: vi.fn(),
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    fireEvent.click(await screen.findByRole("button", { name: "Executor Model" }));

    const thinkingSelect = await screen.findByTestId("custom-model-dropdown-thinking");
    expect(thinkingSelect).toBeTruthy();
    expect(screen.getByRole("option", { name: /Very High/i })).toHaveAttribute("value", "xhigh");
  });

  // FNXC:PlannerOversight 2026-07-04-00:00: per-task override selector must render Inherit + the four BUILTIN_OVERSIGHT_SETTINGS levels and fire onPlannerOversightLevelChange on selection.
  it("renders the planner oversight selector with Inherit + four levels and fires onPlannerOversightLevelChange", async () => {
    const onPlannerOversightLevelChange = vi.fn();
    renderTaskForm({
      plannerOversightLevel: "",
      onPlannerOversightLevelChange,
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    const select = await screen.findByTestId("planner-oversight-level-select");
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: /Inherit from workflow/i })).toHaveAttribute("value", "");
    expect(screen.getByRole("option", { name: /^Off$/i })).toHaveAttribute("value", "off");
    expect(screen.getByRole("option", { name: /^Observe$/i })).toHaveAttribute("value", "observe");
    expect(screen.getByRole("option", { name: /^Steer$/i })).toHaveAttribute("value", "steer");
    expect(screen.getByRole("option", { name: /Autonomous recovery/i })).toHaveAttribute("value", "autonomous");

    fireEvent.change(select, { target: { value: "steer" } });
    expect(onPlannerOversightLevelChange).toHaveBeenCalledWith("steer");
  });

  it("does not render the planner oversight selector when onPlannerOversightLevelChange is not provided", () => {
    renderTaskForm({});
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    expect(screen.queryByTestId("planner-oversight-level-select")).toBeNull();
  });

  it("renders description field with AI refine button when text is present", () => {
    renderTaskForm({ description: "Some text" });

    expect(screen.getByRole("textbox", { name: /Description/i })).toBeTruthy();
    expect(screen.getByTestId("refine-button")).toBeTruthy();
  });

  it("does not show refine button when description is empty", () => {
    renderTaskForm({ description: "" });

    expect(screen.getByRole("textbox", { name: /Description/i })).toBeTruthy();
    expect(screen.queryByTestId("refine-button")).toBeNull();
  });

  it("renders dependency selector and can toggle dependencies", () => {
    const onDependenciesChange = vi.fn();
    const tasks = [makeTask("FN-001"), makeTask("FN-002")];

    renderTaskForm({ tasks, onDependenciesChange });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

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

  it("renders execution mode selector only when execution mode props are provided", () => {
    const { rerender, props } = renderTaskForm();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    expect(screen.queryByTestId("task-form-execution-mode-select")).toBeNull();

    rerender(
      <TaskForm
        {...props}
        executionMode="standard"
        onExecutionModeChange={vi.fn()}
      />,
    );

    const executionModeSelect = screen.getByTestId("task-form-execution-mode-select") as HTMLSelectElement;
    expect(executionModeSelect).toBeTruthy();

    const options = Array.from(executionModeSelect.options).map((option) => option.value);
    expect(options).toEqual(["standard", "fast"]);
  });

  it("clears optional workflow steps when inline Fast or execution-mode select enters fast mode", async () => {
    const { fetchWorkflowOptionalSteps } = await import("../../api");
    vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([
      { templateId: "code-review", name: "Code Review", phase: "pre-merge", defaultOn: true },
      { templateId: "browser-verification", name: "Browser Verification", phase: "pre-merge", defaultOn: false },
    ] as any);
    const onExecutionModeChange = vi.fn();
    const onEnabledWorkflowStepsChange = vi.fn();

    const { rerender, props } = renderTaskForm({
      executionMode: "standard",
      onExecutionModeChange,
      enabledWorkflowSteps: ["code-review"],
      onEnabledWorkflowStepsChange,
    });

    const trigger = await screen.findByTestId("task-form-inline-optional-steps");
    expect(trigger).toHaveTextContent("Steps: 1 selected");
    fireEvent.click(screen.getByTestId("task-form-inline-fast"));
    expect(onExecutionModeChange).toHaveBeenCalledWith("fast");
    expect(onEnabledWorkflowStepsChange).toHaveBeenCalledWith([], expect.objectContaining({ optionalStepsAvailable: true }));

    rerender(
      <TaskForm
        {...props}
        executionMode="fast"
        enabledWorkflowSteps={[]}
        onExecutionModeChange={onExecutionModeChange}
        onEnabledWorkflowStepsChange={onEnabledWorkflowStepsChange}
      />,
    );
    expect(screen.getByTestId("task-form-inline-optional-steps")).toHaveTextContent("Steps: none");
    fireEvent.click(screen.getByTestId("task-form-inline-optional-steps"));
    fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));
    expect(onEnabledWorkflowStepsChange).toHaveBeenLastCalledWith(["browser-verification"], expect.objectContaining({ optionalStepsAvailable: true }));

    onExecutionModeChange.mockClear();
    onEnabledWorkflowStepsChange.mockClear();
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });
    expect(onExecutionModeChange).toHaveBeenCalledWith("fast");
    expect(onEnabledWorkflowStepsChange).toHaveBeenCalledWith([], expect.objectContaining({ optionalStepsAvailable: true }));
  });

  it("seeds no optional steps when loading resolves after Fast is selected", async () => {
    const { fetchWorkflowOptionalSteps } = await import("../../api");
    let resolveOptionalSteps: (steps: Array<{ templateId: string; name: string; phase: string; defaultOn: boolean }>) => void = () => {};
    vi.mocked(fetchWorkflowOptionalSteps).mockReturnValue(new Promise((resolve) => {
      resolveOptionalSteps = resolve;
    }) as any);
    const onExecutionModeChange = vi.fn();
    const onEnabledWorkflowStepsChange = vi.fn();

    const { rerender, props } = renderTaskForm({
      executionMode: "standard",
      onExecutionModeChange,
      enabledWorkflowSteps: [],
      onEnabledWorkflowStepsChange,
      selectedWorkflowId: "wf-explicit",
    });
    await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-explicit", undefined));
    fireEvent.click(screen.getByTestId("task-form-inline-fast"));
    expect(onExecutionModeChange).toHaveBeenCalledWith("fast");

    rerender(
      <TaskForm
        {...props}
        executionMode="fast"
        enabledWorkflowSteps={[]}
        onExecutionModeChange={onExecutionModeChange}
        onEnabledWorkflowStepsChange={onEnabledWorkflowStepsChange}
      />,
    );

    await act(async () => {
      resolveOptionalSteps([{ templateId: "code-review", name: "Code Review", phase: "pre-merge", defaultOn: true }]);
    });

    const trigger = await screen.findByTestId("task-form-inline-optional-steps");
    await waitFor(() => expect(trigger).toHaveTextContent("Steps: none"));
    expect(onEnabledWorkflowStepsChange).toHaveBeenLastCalledWith([], expect.objectContaining({ optionalStepsAvailable: true }));
  });

  it("renders edit-mode workflow steps without clobbering existing task selection", async () => {
    const { fetchWorkflowOptionalSteps } = await import("../../api");
    vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([
      { templateId: "code-review", name: "Code Review", phase: "pre-merge", defaultOn: true },
      { templateId: "browser-verification", name: "Browser Verification", phase: "pre-merge", defaultOn: false },
    ] as any);
    const onEnabledWorkflowStepsChange = vi.fn();

    renderTaskForm({
      mode: "edit",
      onWorkflowIdChange: undefined,
      selectedWorkflowId: undefined,
      optionalStepsWorkflowId: "wf-edit",
      enabledWorkflowSteps: ["browser-verification"],
      onEnabledWorkflowStepsChange,
    });

    await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-edit", undefined));
    const trigger = await screen.findByTestId("task-form-edit-optional-steps");
    expect(trigger).toHaveTextContent("Steps: 1 selected");
    expect(onEnabledWorkflowStepsChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-code-review"));
    expect(onEnabledWorkflowStepsChange).toHaveBeenCalledWith(
      ["browser-verification", "code-review"],
      expect.objectContaining({ optionalStepsAvailable: true }),
    );
    expect(screen.queryByTestId("task-form-inline-optional-steps")).toBeNull();
  });

  it("renders no edit-mode workflow steps shell when the workflow has no optional steps", async () => {
    const { fetchWorkflowOptionalSteps } = await import("../../api");
    vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([] as any);

    renderTaskForm({
      mode: "edit",
      onWorkflowIdChange: undefined,
      selectedWorkflowId: undefined,
      optionalStepsWorkflowId: "wf-empty",
      enabledWorkflowSteps: [],
      onEnabledWorkflowStepsChange: vi.fn(),
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-empty", undefined));
    await waitFor(() => expect(screen.queryByTestId("task-edit-optional-steps-loading")).toBeNull());
    expect(screen.queryByTestId("task-form-edit-workflow-steps-group")).toBeNull();
    expect(screen.queryByTestId("task-form-edit-optional-steps")).toBeNull();
  });

  it("calls onExecutionModeChange when execution mode selection changes", () => {
    const onExecutionModeChange = vi.fn();

    renderTaskForm({
      executionMode: "standard",
      onExecutionModeChange,
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });

    expect(onExecutionModeChange).toHaveBeenCalledWith("fast");
  });

  it("renders priority select with default normal value when enabled", () => {
    renderTaskForm({ onPriorityChange: vi.fn() });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    expect(screen.getByTestId("task-priority-select")).toHaveValue("normal");
  });

  it("calls onPriorityChange when priority selection changes", () => {
    const onPriorityChange = vi.fn();
    renderTaskForm({ onPriorityChange });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    fireEvent.change(screen.getByTestId("task-priority-select"), { target: { value: "urgent" } });

    expect(onPriorityChange).toHaveBeenCalledWith("urgent");
  });

  it("renders working branch input and base branch custom input when no branch options are available", () => {
    renderTaskForm({
      branch: "feature/fn-3422",
      baseBranch: "main",
      onBranchChange: vi.fn(),
      onBaseBranchChange: vi.fn(),
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    expect(screen.getByLabelText("Working branch")).toHaveValue("feature/fn-3422");
    expect(screen.getByTestId("task-base-branch-custom-input")).toHaveValue("main");
  });

  it("calls branch change handlers and supports explicit clearing", () => {
    const onBranchChange = vi.fn();
    const onBaseBranchChange = vi.fn();

    renderTaskForm({
      branch: "feature/fn-3422",
      baseBranch: "develop",
      onBranchChange,
      onBaseBranchChange,
    });

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    fireEvent.change(screen.getByLabelText("Working branch"), { target: { value: "feature/new" } });
    fireEvent.change(screen.getByTestId("task-base-branch-custom-input"), { target: { value: "" } });

    expect(onBranchChange).toHaveBeenCalledWith("feature/new");
    expect(onBaseBranchChange).toHaveBeenCalledWith("");
  });

  it("auto-expands more options when branch fields are prefilled", () => {
    renderTaskForm({
      branch: "feature/fn-3422",
      baseBranch: "main",
      onBranchChange: vi.fn(),
      onBaseBranchChange: vi.fn(),
    });

    expect(screen.getByTestId("task-form-more-options-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("auto-expands more options when priority is non-default", () => {
    renderTaskForm({ priority: "high", onPriorityChange: vi.fn() });

    expect(screen.getByTestId("task-form-more-options-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("renders base branch dropdown options sorted with common integration branches first", async () => {
    const { fetchGitBranches } = await import("../../api");
    vi.mocked(fetchGitBranches).mockResolvedValueOnce([
      { name: "release" },
      { name: "develop" },
      { name: "feature/foo" },
      { name: "main" },
      { name: "main" },
      { name: "trunk" },
    ] as any);

    const onBaseBranchChange = vi.fn();
    renderTaskForm({ onBaseBranchChange });
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    const select = await screen.findByTestId("task-base-branch-select");
    const optionValues = Array.from((select as HTMLSelectElement).options).map((option) => option.value);
    expect(optionValues).toEqual(["", "main", "trunk", "develop", "feature/foo", "release", "__fusion-custom__"]);

    fireEvent.change(select, { target: { value: "develop" } });
    expect(onBaseBranchChange).toHaveBeenCalledWith("develop");

    fireEvent.change(select, { target: { value: "__fusion-custom__" } });
    expect(screen.getByTestId("task-base-branch-custom-input")).toBeTruthy();
  });

  it("defaults to custom mode for unknown base branch and supports switching back to dropdown", async () => {
    const { fetchGitBranches } = await import("../../api");
    vi.mocked(fetchGitBranches).mockResolvedValueOnce([{ name: "main" }, { name: "develop" }] as any);

    const onBaseBranchChange = vi.fn();
    renderTaskForm({
      baseBranch: "release/candidate",
      onBaseBranchChange,
    });
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    expect(await screen.findByTestId("task-base-branch-custom-input")).toHaveValue("release/candidate");
    fireEvent.click(screen.getByTestId("task-base-branch-use-dropdown"));

    expect(onBaseBranchChange).toHaveBeenCalledWith("");
  });

  it("keeps base branch entry available when branch loading fails", async () => {
    const { fetchGitBranches } = await import("../../api");
    vi.mocked(fetchGitBranches).mockRejectedValueOnce(new Error("boom"));

    renderTaskForm({ onBaseBranchChange: vi.fn() });
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("task-base-branch-custom-input")).toBeTruthy();
    });
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

  it("does not render a hardcoded browser verification checkbox", () => {
    renderTaskForm();

    expect(screen.queryByTestId("browser-verification-checkbox")).toBeNull();
    expect(screen.queryByText("Browser Verification")).toBeNull();
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

  it("renders description expand button in edit mode and toggles fullscreen", () => {
    const { container } = renderTaskForm({
      mode: "edit",
      title: "My task",
      onTitleChange: vi.fn(),
      description: "Long task description",
    });

    const expandButton = screen.getByRole("button", { name: "Expand description" });
    expect(expandButton).toBeTruthy();

    fireEvent.click(expandButton);
    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse description" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse description" }));
    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeNull();
  });

  it("collapses fullscreen description editor on Escape", () => {
    const { container } = renderTaskForm({
      mode: "edit",
      title: "My task",
      onTitleChange: vi.fn(),
      description: "Long task description",
    });

    fireEvent.click(screen.getByRole("button", { name: "Expand description" }));
    const textarea = screen.getByRole("textbox", { name: /Description/i });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeNull();
  });

  it("uses 8 rows for description textarea in edit mode", () => {
    renderTaskForm({
      mode: "edit",
      title: "My task",
      onTitleChange: vi.fn(),
      description: "Edit mode description",
    });

    const textarea = screen.getByRole("textbox", { name: /Description/i }) as HTMLTextAreaElement;
    expect(textarea.getAttribute("rows")).toBe("8");
  });

  it("uses 5 rows for description textarea in create mode", () => {
    renderTaskForm({
      mode: "create",
      description: "Create mode description",
    });

    const textarea = screen.getByRole("textbox", { name: /Description/i }) as HTMLTextAreaElement;
    expect(textarea.getAttribute("rows")).toBe("5");
  });

  it("renders expand button in create mode and toggles fullscreen", () => {
    const { container } = renderTaskForm({
      mode: "create",
      description: "Some description to expand",
    });

    const expandButton = screen.getByRole("button", { name: "Expand description" });
    expect(expandButton).toBeTruthy();

    fireEvent.click(expandButton);
    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse description" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse description" }));
    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeNull();
  });

  it("expand button uses flush placement when description is empty (no refine button)", () => {
    const { container } = renderTaskForm({
      mode: "create",
      description: "",
    });

    const expandButton = screen.getByRole("button", { name: "Expand description" });
    expect(expandButton).toBeTruthy();

    // Expand button should have flush placement when refine is absent
    expect(container.querySelector(".description-expand-btn--flush")).toBeTruthy();
    expect(container.querySelector(".description-expand-btn--offset")).toBeNull();

    // Refine button should NOT be rendered when description is empty
    expect(screen.queryByTestId("refine-button")).toBeNull();
  });

  it("expand button uses offset placement when description has content (refine visible)", () => {
    const { container } = renderTaskForm({
      mode: "create",
      description: "Some task description",
    });

    const expandButton = screen.getByRole("button", { name: "Expand description" });
    expect(expandButton).toBeTruthy();

    // Expand button should have offset placement when refine is visible
    expect(container.querySelector(".description-expand-btn--offset")).toBeTruthy();
    expect(container.querySelector(".description-expand-btn--flush")).toBeNull();

    // Refine button should be rendered when description is non-empty
    expect(screen.getByTestId("refine-button")).toBeTruthy();
  });

  it("collapses fullscreen description editor on Escape in create mode", () => {
    const { container } = renderTaskForm({
      mode: "create",
      description: "Some description",
    });

    fireEvent.click(screen.getByRole("button", { name: "Expand description" }));
    const textarea = screen.getByRole("textbox", { name: /Description/i });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(container.querySelector(".description-with-refine.description--fullscreen")).toBeNull();
  });

  it("debounces auto-save in edit mode and calls onAutoSaveDescription after 1.5s", async () => {
    vi.useFakeTimers();
    try {
      const onAutoSaveDescription = vi.fn().mockResolvedValue(undefined);

      renderTaskFormWithDescriptionState({
        mode: "edit",
        title: "My task",
        onTitleChange: vi.fn(),
        description: "Initial description",
        onAutoSaveDescription,
      });

      fireEvent.change(screen.getByRole("textbox", { name: /Description/i }), {
        target: { value: "Updated description" },
      });

      vi.advanceTimersByTime(1499);
      expect(onAutoSaveDescription).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await vi.runOnlyPendingTimersAsync();
      expect(onAutoSaveDescription).toHaveBeenCalledWith("Updated description");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-save in create mode", () => {
    vi.useFakeTimers();
    try {
      const onAutoSaveDescription = vi.fn().mockResolvedValue(undefined);

      renderTaskFormWithDescriptionState({
        mode: "create",
        description: "",
        onAutoSaveDescription,
      });

      fireEvent.change(screen.getByRole("textbox", { name: /Description/i }), {
        target: { value: "Create mode text" },
      });

      vi.advanceTimersByTime(1600);
      expect(onAutoSaveDescription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-save when onAutoSaveDescription is not provided", () => {
    vi.useFakeTimers();
    try {
      renderTaskFormWithDescriptionState({
        mode: "edit",
        title: "My task",
        onTitleChange: vi.fn(),
        description: "Initial",
        onAutoSaveDescription: undefined,
      });

      fireEvent.change(screen.getByRole("textbox", { name: /Description/i }), {
        target: { value: "Updated" },
      });

      vi.advanceTimersByTime(1600);
      expect(screen.queryByText("Saved")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets debounce timer on rapid typing and only auto-saves once", async () => {
    vi.useFakeTimers();
    try {
      const onAutoSaveDescription = vi.fn().mockResolvedValue(undefined);

      renderTaskFormWithDescriptionState({
        mode: "edit",
        title: "My task",
        onTitleChange: vi.fn(),
        description: "",
        onAutoSaveDescription,
      });

      const textarea = screen.getByRole("textbox", { name: /Description/i });
      fireEvent.change(textarea, { target: { value: "A" } });
      vi.advanceTimersByTime(500);
      fireEvent.change(textarea, { target: { value: "AB" } });
      vi.advanceTimersByTime(500);
      fireEvent.change(textarea, { target: { value: "ABC" } });

      vi.advanceTimersByTime(1499);
      expect(onAutoSaveDescription).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await vi.runOnlyPendingTimersAsync();
      expect(onAutoSaveDescription).toHaveBeenCalledTimes(1);
      expect(onAutoSaveDescription).toHaveBeenCalledWith("ABC");
    } finally {
      vi.useRealTimers();
    }
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

  it("renders a fetched workflow as a dropdown option (U6/R3)", async () => {
    const { fetchWorkflows } = await import("../../api");
    vi.mocked(fetchWorkflows).mockResolvedValueOnce([
      {
        id: "WF-1",
        name: "Browser Verification",
        description: "Verify in browser",
        kind: "workflow",
        ir: { version: "v1", name: "Browser Verification", nodes: [], edges: [] },
        layout: {},
        createdAt: "",
        updatedAt: "",
      },
    ] as any);

    const onWorkflowIdChange = vi.fn();
    renderTaskForm({ onWorkflowIdChange });

    await openWorkflowDropdown();

    fireEvent.click(screen.getByTestId("task-workflow-option-WF-1"));
    expect(onWorkflowIdChange).toHaveBeenCalledWith("WF-1");
    expect(screen.queryByTestId("task-workflow-select")).toBeNull();
  });

  it("disables all inputs when disabled prop is true", () => {
    renderTaskForm({
      disabled: true,
      description: "Some text",
      dependencies: ["FN-001"],
    });

    const textarea = screen.getByRole("textbox", { name: /Description/i }) as HTMLTextAreaElement;
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
      // projectId is undefined in this test context
      expect(refineText).toHaveBeenCalledWith("Some text to refine", "clarify", undefined);
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
    expect(screen.queryByTestId("task-form-inline-optional-steps")).toBeNull();
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
    } as any);

    renderTaskForm();

    await waitFor(() => {
      expect(fetchSettings).toHaveBeenCalled();
    });

    const presetSelect = await waitFor(() => {
      const element = document.getElementById("model-preset") as HTMLSelectElement | null;
      expect(element).toBeTruthy();
      return element as HTMLSelectElement;
    });
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
    } as any);

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

    const presetSelect = await waitFor(() => {
      const element = document.getElementById("model-preset") as HTMLSelectElement | null;
      expect(element).toBeTruthy();
      return element as HTMLSelectElement;
    });
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
    } as any);

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

    const presetSelect = await waitFor(() => {
      const element = document.getElementById("model-preset") as HTMLSelectElement | null;
      expect(element).toBeTruthy();
      return element as HTMLSelectElement;
    });
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
    } as any);

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

    const presetSelect = (await screen.findByLabelText("Preset")) as HTMLSelectElement;
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
    } as any);

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

    const overrideButton = await screen.findByRole("button", { name: "Override" });
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
    } as any);

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
    } as any);

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

describe("TaskForm workflow picker (U6/R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mockWorkflows(defs: Array<{ id: string; name: string; kind?: "workflow" | "fragment"; icon?: string }>) {
    const { fetchWorkflows } = await import("../../api");
    vi.mocked(fetchWorkflows).mockResolvedValueOnce(
      defs.map((d) => ({
        id: d.id,
        name: d.name,
        icon: d.icon,
        description: "",
        kind: d.kind ?? "workflow",
        ir: { version: "v1", name: d.name, nodes: [], edges: [] },
        layout: {},
        createdAt: "",
        updatedAt: "",
      })) as any,
    );
  }

  it("renders the dropdown with 'No workflow' first and the help text", async () => {
    await mockWorkflows([{ id: "WF-1", name: "QA" }]);
    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    const menu = await openWorkflowDropdown();
    expect(menu.querySelector('[data-testid="task-workflow-option-none"]')).toBeTruthy();
    expect(Array.from(menu.querySelectorAll('[role="option"]'))[0]).toHaveAttribute("data-testid", "task-workflow-option-none");
    expect(screen.getByTestId("task-workflow-help")).toBeTruthy();
    expect(screen.queryByTestId("task-workflow-select")).toBeNull();
  });

  it("badges the project default workflow with (default)", async () => {
    const { fetchSettings } = await import("../../api");
    vi.mocked(fetchSettings).mockResolvedValueOnce({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      defaultWorkflowId: "WF-1",
    } as any);
    await mockWorkflows([
      { id: "WF-1", name: "QA" },
      { id: "WF-2", name: "Docs" },
    ]);

    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    await waitFor(() => {
      expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
    });
    expect(screen.getByTestId("task-workflow-dropdown-trigger")).toHaveTextContent("QA");
    expect(screen.getByTestId("task-workflow-dropdown-trigger")).toHaveTextContent("(default)");
    await openWorkflowDropdown();
    expect(screen.getByTestId("task-workflow-option-WF-1")).toHaveTextContent("(default)");
  });

  it("renders built-in and custom icons without empty custom shells", async () => {
    await mockWorkflows([
      { id: "builtin:coding", name: "Coding" },
      { id: "WF-CUSTOM", name: "Custom", icon: "🧪" },
      { id: "WF-PLAIN", name: "Plain" },
    ]);
    renderTaskForm({ onWorkflowIdChange: vi.fn(), selectedWorkflowId: "builtin:coding" });

    await openWorkflowDropdown();
    const builtin = screen.getByTestId("task-workflow-option-builtin:coding");
    const custom = screen.getByTestId("task-workflow-option-WF-CUSTOM");
    const plain = screen.getByTestId("task-workflow-option-WF-PLAIN");
    expect(builtin.querySelector(".workflow-icon--builtin")).toBeTruthy();
    expect(custom.querySelector(".workflow-icon--custom")).toHaveTextContent("🧪");
    expect(plain.querySelector(".workflow-icon")).toBeNull();
    expect(screen.getByTestId("task-workflow-dropdown-trigger").querySelector(".workflow-icon--builtin")).toBeTruthy();
  });

  it("shows inherited builtin workflow instead of selecting No workflow when project default is unset", async () => {
    await mockWorkflows([
      { id: "builtin:coding", name: "Coding" },
      { id: "WF-1", name: "QA" },
    ]);
    renderTaskForm({ onWorkflowIdChange: vi.fn(), selectedWorkflowId: undefined });

    await waitFor(() => {
      expect(screen.getByTestId("task-workflow-dropdown-trigger")).toHaveTextContent("Coding");
    });
    expect(screen.getByTestId("task-workflow-dropdown-trigger").querySelector(".workflow-icon--builtin")).toBeTruthy();
    await openWorkflowDropdown();
    expect(screen.getByTestId("task-workflow-option-none")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("task-workflow-option-builtin:coding")).toHaveAttribute("aria-selected", "true");
  });

  it("disambiguates duplicate workflow names by id in aria text and subtitle", async () => {
    await mockWorkflows([
      { id: "WF-A", name: "Review" },
      { id: "WF-B", name: "Review" },
    ]);
    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    await openWorkflowDropdown();
    expect(screen.getByTestId("task-workflow-option-WF-A")).toHaveAttribute("aria-label", "Review (WF-A)");
    expect(screen.getByTestId("task-workflow-option-WF-A")).toHaveTextContent("WF-A");
    expect(screen.getByTestId("task-workflow-option-WF-B")).toHaveTextContent("WF-B");
  });

  it("excludes fragments from the dropdown", async () => {
    await mockWorkflows([
      { id: "WF-1", name: "QA", kind: "workflow" },
      { id: "FRAG-1", name: "Doc Fragment", kind: "fragment" },
    ]);
    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    await openWorkflowDropdown();
    expect(screen.getByText("QA")).toBeTruthy();
    expect(screen.queryByText("Doc Fragment")).toBeNull();
  });

  it("passes the chosen workflow id via onWorkflowIdChange", async () => {
    await mockWorkflows([{ id: "WF-1", name: "QA" }]);
    const onWorkflowIdChange = vi.fn();
    renderTaskForm({ onWorkflowIdChange });

    await openWorkflowDropdown();
    fireEvent.click(screen.getByTestId("task-workflow-option-WF-1"));
    expect(onWorkflowIdChange).toHaveBeenCalledWith("WF-1");
  });

  it("maps 'No workflow' to null", async () => {
    await mockWorkflows([{ id: "WF-1", name: "QA" }]);
    const onWorkflowIdChange = vi.fn();
    renderTaskForm({ onWorkflowIdChange, selectedWorkflowId: "WF-1" });

    await openWorkflowDropdown();
    fireEvent.click(screen.getByTestId("task-workflow-option-none"));
    expect(onWorkflowIdChange).toHaveBeenCalledWith(null);
  });

  it("closes the dropdown on Escape and outside click", async () => {
    await mockWorkflows([{ id: "WF-1", name: "QA" }]);
    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    const trigger = await screen.findByTestId("task-workflow-dropdown-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("task-workflow-dropdown-menu")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByTestId("task-workflow-dropdown-menu")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId("task-workflow-dropdown-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("task-workflow-dropdown-menu")).toBeNull();
  });

  it("shows a loading placeholder while workflows load", async () => {
    const { fetchWorkflows } = await import("../../api");
    let resolveFn: (v: unknown) => void = () => {};
    vi.mocked(fetchWorkflows).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as any,
    );
    renderTaskForm({ onWorkflowIdChange: vi.fn() });

    expect(screen.getByTestId("task-workflow-loading")).toBeTruthy();
    resolveFn([{ id: "WF-1", name: "QA" }]);

    await waitFor(() => {
      expect(screen.queryByTestId("task-workflow-loading")).toBeNull();
    });
    await openWorkflowDropdown();
    expect(screen.getByTestId("task-workflow-option-WF-1")).toBeTruthy();
  });

  it.each([
    ["create", { mode: "create" as const }],
    ["edit", { mode: "edit" as const, title: "Existing task", onTitleChange: vi.fn() }],
  ])(
    "regression: no per-step checkboxes and no fetchWorkflowSteps usage (%s mode)",
    async (_label, modeProps) => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      renderTaskForm({ onWorkflowIdChange: vi.fn(), ...modeProps });

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-dropdown-trigger")).toBeTruthy();
      });
      // The old per-step checkbox UI and execution-order controls are gone on
      // every TaskForm surface (create and edit).
      expect(screen.queryByTestId("workflow-step-order")).toBeNull();
      expect(document.querySelector('[data-testid^="workflow-step-checkbox-"]')).toBeNull();
      // The api mock no longer needs a fetchWorkflowSteps export — TaskForm never
      // calls it. (If it still did, rendering above would have thrown on the
      // missing mock export, so reaching this point is itself the regression proof.)
    },
  );
});

describe("TaskForm focus behavior (FN-1459)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-focuses description textarea in create mode on mount", async () => {
    renderTaskForm({ mode: "create" });

    const textarea = screen.getByRole("textbox", { name: /Description/i });
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("auto-focuses description textarea in create mode even with initial description", async () => {
    renderTaskForm({ mode: "create", description: "Pre-filled task" });

    const textarea = screen.getByRole("textbox", { name: /Description/i });
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("auto-focuses title input in edit mode on mount", async () => {
    renderTaskForm({
      mode: "edit",
      title: "Existing task",
      onTitleChange: vi.fn(),
    });

    const titleInput = screen.getByLabelText(/Title/i) as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput);
    });
  });

  it("selects title input text in edit mode on mount", async () => {
    renderTaskForm({
      mode: "edit",
      title: "Existing task",
      onTitleChange: vi.fn(),
    });

    const titleInput = screen.getByLabelText(/Title/i) as HTMLInputElement;
    // SelectionStart and SelectionEnd are set when the text is selected
    await waitFor(() => {
      // When text is selected, selectionStart should be 0 and selectionEnd should equal the text length
      expect(titleInput.selectionStart).toBe(0);
      expect(titleInput.selectionEnd).toBe(titleInput.value.length);
    });
  });

  it("does not auto-focus description textarea in edit mode", async () => {
    renderTaskForm({
      mode: "edit",
      title: "Existing task",
      onTitleChange: vi.fn(),
    });

    const textarea = screen.getByRole("textbox", { name: /Description/i });
    // In edit mode, description should NOT be focused (title input is focused instead)
    await waitFor(() => {
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  // renderBelowPrimary and hideDependencies slot tests
  describe("renderBelowPrimary and hideDependencies", () => {
    it("renders renderBelowPrimary content between primary section and More options toggle", () => {
      renderTaskForm({
        renderBelowPrimary: <div data-testid="injected">Custom content</div>,
      });

      const injected = screen.getByTestId("injected");
      const toggle = screen.getByTestId("task-form-more-options-toggle");
      const descriptionArea = screen.getByRole("textbox", { name: /Description/i });

      expect(injected).toBeInTheDocument();
      // Injected element should appear AFTER the primary section (description area)
      expect(
        descriptionArea.compareDocumentPosition(injected) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      // Injected element should appear BEFORE the more-options toggle
      expect(
        injected.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("renders renderBelowModelConfiguration content below model section in More options", async () => {
      renderTaskForm({
        renderBelowModelConfiguration: <div data-testid="injected-below-model">Bottom slot content</div>,
        githubTrackingEnabled: false,
        onGithubTrackingEnabledChange: vi.fn(),
        githubRepoOverride: "",
        onGithubRepoOverrideChange: vi.fn(),
      });

      const toggle = screen.getByTestId("task-form-more-options-toggle");
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(toggle).toHaveAttribute("aria-expanded", "true");
      });

      const modelLabel = screen.getByText("Model Configuration");
      // U6/R3: the per-step "Workflow Steps" section is now the "Workflow" picker.
      const workflowLabel = screen.getByText("Workflow");
      const injectedBottom = screen.getByTestId("injected-below-model");
      const githubTrackingSection = screen.getByTestId("task-form-github-tracking");

      expect(
        modelLabel.compareDocumentPosition(injectedBottom) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        injectedBottom.compareDocumentPosition(workflowLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(
        workflowLabel.compareDocumentPosition(githubTrackingSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("hides dependencies section when hideDependencies is true", async () => {
      renderTaskForm({ hideDependencies: true });

      // Expand "More options"
      const toggle = screen.getByTestId("task-form-more-options-toggle");
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(toggle).toHaveAttribute("aria-expanded", "true");
      });

      // Dependencies label and dep-trigger should not be in the document
      expect(screen.queryByText("Dependencies")).toBeNull();
      expect(screen.queryByRole("button", { name: /Add dependencies/i })).toBeNull();
      // The dependency "N selected" count must be absent (avoid matching the
      // workflow picker's help copy, which also contains the word "selected").
      expect(screen.queryByText(/\d+ selected/i)).toBeNull();
    });

    it("does not auto-expand More options for dependency selections when hideDependencies is true", async () => {
      renderTaskForm({
        hideDependencies: true,
        dependencies: ["FN-001"],
      });

      const toggle = screen.getByTestId("task-form-more-options-toggle");
      await waitFor(() => {
        expect(toggle).toHaveAttribute("aria-expanded", "false");
      });
    });

    it("renders nothing when renderBelowPrimary is not provided", () => {
      renderTaskForm({});
      // Should not have any unexpected elements - just verify normal rendering works
      expect(screen.getByRole("textbox", { name: /Description/i })).toBeInTheDocument();
      expect(screen.getByTestId("task-form-more-options-toggle")).toBeInTheDocument();
    });
  });

  describe("GitHub tracking controls", () => {
    it("seeds tracking toggle from project settings default", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        githubTrackingEnabledByDefault: true,
      });

      const onGithubTrackingEnabledChange = vi.fn();
      renderTaskForm({
        githubTrackingEnabled: false,
        onGithubTrackingEnabledChange,
      });

      await waitFor(() => {
        expect(onGithubTrackingEnabledChange).toHaveBeenCalledWith(true);
      });
    });

    it("renders tracking controls and propagates changes", async () => {
      const onGithubTrackingEnabledChange = vi.fn();
      const onGithubRepoOverrideChange = vi.fn();

      renderTaskForm({
        githubTrackingEnabled: false,
        onGithubTrackingEnabledChange,
        githubRepoOverride: "",
        onGithubRepoOverrideChange,
      });

      const toggle = await screen.findByLabelText("Enable GitHub issue tracking for this task");
      fireEvent.click(toggle);
      expect(onGithubTrackingEnabledChange).toHaveBeenCalledWith(true);

      const input = screen.getByLabelText("Repository (owner/repo)");
      fireEvent.change(input, { target: { value: "owner/repo" } });
      expect(onGithubRepoOverrideChange).toHaveBeenCalledWith("owner/repo");
    });

    it("shows validation error for invalid repo override", () => {
      renderTaskForm({
        githubTrackingEnabled: true,
        onGithubTrackingEnabledChange: vi.fn(),
        githubRepoOverride: "invalid repo",
        onGithubRepoOverrideChange: vi.fn(),
      });

      expect(screen.getByText("Repository must be in owner/repo format.")).toBeInTheDocument();
    });
  });
});
