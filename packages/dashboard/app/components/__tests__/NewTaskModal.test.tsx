import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@kb/core";

// Mock the api module
vi.mock("../../api", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue([
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ]),
  updateTask: vi.fn().mockResolvedValue({}),
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
    expect(screen.getByLabelText(/Title/i)).toBeTruthy();
    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add dependencies" })).toBeTruthy();
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByLabelText(/Enable planning mode/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("creates task with all provided data on submit", async () => {
    const { props } = renderNewTaskModal();
    
    const titleInput = screen.getByLabelText(/Title/i);
    const descTextarea = screen.getByLabelText(/Description/i);
    
    fireEvent.change(titleInput, { target: { value: "My Task Title" } });
    fireEvent.change(descTextarea, { target: { value: "My task description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "My Task Title",
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

  it("creates task without title when title is empty", async () => {
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
});
