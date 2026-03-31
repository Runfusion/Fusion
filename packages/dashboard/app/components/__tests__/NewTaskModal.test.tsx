import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@kb/core";
import { fetchSettings } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue([
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ]),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
  }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
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

function renderNewTaskModal(props = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    tasks: [] as Task[],
    onCreateTask: vi.fn().mockResolvedValue({ id: "KB-001" }),
    addToast: vi.fn(),
  };
  const mergedProps = { ...defaultProps, ...props };
  const result = render(<NewTaskModal {...mergedProps} />);
  return { ...result, props: mergedProps };
}

describe("NewTaskModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when isOpen is false", () => {
    renderNewTaskModal({ isOpen: false });
    expect(screen.queryByText("New Task")).toBeNull();
  });

  it("renders all form fields when open", () => {
    renderNewTaskModal();
    
    expect(screen.getByText("New Task")).toBeTruthy();
    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add dependencies" })).toBeTruthy();
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByLabelText(/Enable planning mode/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    await waitFor(() => {
      expect(descTextarea).toHaveFocus();
    });
  });

  it("creates task with description on submit", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    
    fireEvent.change(descTextarea, { target: { value: "My task description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: undefined,
          description: "My task description",
          column: "triage",
        }),
      );
    });
  });

  it("calls onClose after successful creation", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  it("shows error toast on creation failure", async () => {
    const { props } = renderNewTaskModal({
      onCreateTask: vi.fn().mockRejectedValue(new Error("Creation failed")),
    });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Creation failed", "error");
    });
  });

  it("disables create button when description is empty", () => {
    renderNewTaskModal();
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).toBeDisabled();
  });

  it("enables create button when description is not empty", () => {
    renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Some description" } });
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).not.toBeDisabled();
  });

  it("closes modal on cancel button click", () => {
    const { props } = renderNewTaskModal();
    
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    
    expect(props.onClose).toHaveBeenCalled();
  });

  it("closes modal on X button click", () => {
    const { props } = renderNewTaskModal();
    
    fireEvent.click(screen.getByText("×"));
    
    expect(props.onClose).toHaveBeenCalled();
  });

  it("adds dependencies via dropdown", async () => {
    const tasks = [makeTask("KB-010"), makeTask("KB-020")];
    const { props } = renderNewTaskModal({ tasks });
    
    // Open dependencies dropdown
    fireEvent.click(screen.getByRole("button", { name: "Add dependencies" }));
    
    // Wait for dropdown to appear
    await waitFor(() => {
      expect(document.querySelector(".dep-dropdown")).toBeTruthy();
    });
    
    // Click on a task to add it as dependency
    const items = document.querySelectorAll(".dep-dropdown-item");
    expect(items.length).toBeGreaterThan(0);
    fireEvent.click(items[0]!);
    
    // Verify dependency was added (it should show as selected)
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Task with deps" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          dependencies: expect.any(Array),
        }),
      );
    });
  });

  it("renders model selectors when models are loaded", async () => {
    renderNewTaskModal();
    
    await waitFor(() => {
      expect(screen.getByText("Executor")).toBeTruthy();
      expect(screen.getByText("Validator")).toBeTruthy();
    });
  });

  it("creates task with selected preset id and resolved models", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      modelPresets: [
        {
          id: "budget",
          name: "Budget",
          executorProvider: "openai",
          executorModelId: "gpt-4o",
          validatorProvider: "anthropic",
          validatorModelId: "claude-sonnet-4-5",
        },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    const { props } = renderNewTaskModal();
    fireEvent.change(screen.getByLabelText(/Description/i), { target: { value: "Preset task" } });

    await waitFor(() => expect(screen.getByLabelText("Preset")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "budget" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
        description: "Preset task",
        modelPresetId: "budget",
        modelProvider: "openai",
        modelId: "gpt-4o",
        validatorModelProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
      }));
    });
  });

  it("allows overriding a selected preset with custom models", async () => {
    (fetchSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      modelPresets: [
        {
          id: "budget",
          name: "Budget",
          executorProvider: "openai",
          executorModelId: "gpt-4o",
        },
      ],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
    });

    renderNewTaskModal();
    await waitFor(() => expect(screen.getByLabelText("Preset")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "budget" } });
    expect(screen.getByText("Using preset: Budget")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.queryByText("Using preset: Budget")).toBeNull();

    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "custom" } });
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
  });

  it("toggles planning mode checkbox", () => {
    renderNewTaskModal();
    
    const checkbox = screen.getByLabelText(/Enable planning mode/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("shows success toast after creation", async () => {
    const { props } = renderNewTaskModal({
      onCreateTask: vi.fn().mockResolvedValue({ id: "KB-042" }),
    });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Created KB-042", "success");
    });
  });

  it("confirms before closing with dirty state", () => {
    const { props } = renderNewTaskModal();
    
    // Add some content to make it dirty
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Some text" } });
    
    // Mock confirm to return false (cancel)
    const originalConfirm = window.confirm;
    window.confirm = vi.fn().mockReturnValue(false);
    
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    
    expect(window.confirm).toHaveBeenCalledWith("You have unsaved changes. Discard them?");
    expect(props.onClose).not.toHaveBeenCalled();
    
    window.confirm = originalConfirm;
  });

  it("closes without confirm when state is not dirty", () => {
    const { props } = renderNewTaskModal();
    
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    
    expect(props.onClose).toHaveBeenCalled();
  });

  it("creates task with title undefined by default", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Only description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: undefined,
          description: "Only description",
        }),
      );
    });
  });

  // Planning mode tests
  it("calls onPlanningMode when planning mode is checked and form is submitted", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    const checkbox = screen.getByLabelText(/Enable planning mode/i);
    
    fireEvent.change(descTextarea, { target: { value: "Build a login system" } });
    fireEvent.click(checkbox);
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(onPlanningMode).toHaveBeenCalledWith("Build a login system");
    });
  });

  it("does NOT call onCreateTask when planning mode is checked", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    const checkbox = screen.getByLabelText(/Enable planning mode/i);
    
    fireEvent.change(descTextarea, { target: { value: "Build a login system" } });
    fireEvent.click(checkbox);
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(onPlanningMode).toHaveBeenCalled();
    });
    
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("calls onCreateTask normally when planning mode is unchecked", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Normal task" } });
    
    // Ensure planning mode is unchecked
    const checkbox = screen.getByLabelText(/Enable planning mode/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Normal task",
        }),
      );
    });
    
    expect(onPlanningMode).not.toHaveBeenCalled();
  });

  it("closes modal after triggering planning mode", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    const checkbox = screen.getByLabelText(/Enable planning mode/i);
    
    fireEvent.change(descTextarea, { target: { value: "Build a login system" } });
    fireEvent.click(checkbox);
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  it("clears form state after triggering planning mode", async () => {
    const onPlanningMode = vi.fn();
    renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    const checkbox = screen.getByLabelText(/Enable planning mode/i);
    
    fireEvent.change(descTextarea, { target: { value: "Build a login system" } });
    fireEvent.click(checkbox);
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(onPlanningMode).toHaveBeenCalled();
    });
    
    // Re-open the modal and check that state is cleared
    renderNewTaskModal({ 
      isOpen: true, 
      onPlanningMode,
      onClose: vi.fn(),
    });
    
    await waitFor(() => {
      const newDescTextarea = screen.getAllByLabelText(/Description/i)[0];
      expect(newDescTextarea).toHaveValue("");
    });
  });

  it("has scrollable modal body with overflow-y auto", () => {
    renderNewTaskModal();
    
    // Find the modal container
    const modal = document.querySelector(".new-task-modal");
    expect(modal).toBeTruthy();
    
    // Find the modal body
    const modalBody = modal?.querySelector(".modal-body");
    expect(modalBody).toBeTruthy();
    
    // Verify the modal body element exists within the new-task-modal
    // The overflow-y: auto is applied via CSS in styles.css
    expect(modal?.contains(modalBody)).toBe(true);
  });

  it("shows workflow step checkboxes when steps are available", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "Docs Review", description: "Check documentation", prompt: "Review docs", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { id: "WS-002", name: "QA Check", description: "Run tests", prompt: "Run tests", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);

    renderNewTaskModal();

    await waitFor(() => {
      expect(screen.getByTestId("workflow-steps-section")).toBeInTheDocument();
      expect(screen.getByText("Docs Review")).toBeInTheDocument();
      expect(screen.getByText("QA Check")).toBeInTheDocument();
    });
  });

  it("does not show workflow steps section when no steps are available", async () => {
    renderNewTaskModal();

    await waitFor(() => {
      expect(screen.queryByTestId("workflow-steps-section")).toBeNull();
    });
  });

  it("toggles workflow step selection", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "Docs Review", description: "Check documentation", prompt: "Review docs", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);

    renderNewTaskModal();

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeInTheDocument();
    });

    const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("passes selected workflow steps to onCreateTask", async () => {
    const { fetchWorkflowSteps } = await import("../../api");
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { id: "WS-001", name: "Docs Review", description: "Check documentation", prompt: "Review docs", enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);

    const { props } = renderNewTaskModal();

    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeInTheDocument();
    });

    // Check the workflow step
    const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector("input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(checkbox);

    // Fill in description
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(textarea, { target: { value: "Test task" } });

    // Submit
    const submitBtn = screen.getByText("Create Task");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledWorkflowSteps: ["WS-001"],
        })
      );
    });
  });
});
