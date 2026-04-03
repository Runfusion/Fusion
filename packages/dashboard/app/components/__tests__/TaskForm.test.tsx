import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskForm } from "../TaskForm";
import type { Task, Column } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Sparkles: () => null,
  Globe: () => null,
}));

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ], favoriteProviders: [] }),
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
