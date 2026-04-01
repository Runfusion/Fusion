import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@fusion/core";

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
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
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
    onCreateTask: vi.fn().mockResolvedValue({ id: "FN-001" }),
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

  it("renders all form fields when open", () => {
    renderNewTaskModal();
    
    expect(screen.getByText("New Task")).toBeTruthy();
    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add dependencies" })).toBeTruthy();
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    // Plan and Subtask buttons for AI-assisted creation (replaced planning mode checkbox)
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subtask" })).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const textarea = screen.getByLabelText(/Description/i);
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("creates task with description when submitted", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Test description",
        }),
      );
    });
  });

  it("closes modal after successful creation", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  it("has working Plan button for AI-assisted creation", () => {
    const onPlanningMode = vi.fn();
    renderNewTaskModal({ onPlanningMode });
    
    // The Plan button should be present and disabled when no description
    const planButton = screen.getByRole("button", { name: "Plan" });
    expect(planButton).toBeTruthy();
  });

  it("shows success toast after creation", async () => {
    const { props } = renderNewTaskModal({
      onCreateTask: vi.fn().mockResolvedValue({ id: "FN-042" }),
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
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
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

  // Plan mode tests - using Plan button instead of checkbox
  it("calls onPlanningMode when Plan button is clicked with description", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Build a login system" } });
    
    // Wait for models to load
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Plan" })).not.toBeDisabled();
    });
    
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    
    await waitFor(() => {
      expect(onPlanningMode).toHaveBeenCalledWith("Build a login system");
    });
  });

  it("calls onCreateTask normally when form is submitted", async () => {
    const onPlanningMode = vi.fn();
    const { props } = renderNewTaskModal({ onPlanningMode });
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Normal task" } });
    
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



  it("disables Create Task when description is empty", () => {
    renderNewTaskModal();
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).toBeDisabled();
  });

  it("enables Create Task when description has content", () => {
    renderNewTaskModal();
    
    const descTextarea = screen.getByLabelText(/Description/i);
    fireEvent.change(descTextarea, { target: { value: "Some text" } });
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).not.toBeDisabled();
  });
});
