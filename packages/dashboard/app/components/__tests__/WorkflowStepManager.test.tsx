import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowStepManager } from "../WorkflowStepManager";
import type { WorkflowStep } from "@kb/core";

const mockSteps: WorkflowStep[] = [
  {
    id: "WS-001",
    name: "Documentation Review",
    description: "Verify all public APIs have documentation",
    prompt: "Review the task changes and verify docs.",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "WS-002",
    name: "QA Check",
    description: "Run tests and verify they pass",
    prompt: "Execute the test suite.",
    enabled: false,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

vi.mock("../../api", () => ({
  fetchWorkflowSteps: vi.fn(() => Promise.resolve([])),
  createWorkflowStep: vi.fn(() => Promise.resolve({
    id: "WS-003",
    name: "New Step",
    description: "New description",
    prompt: "",
    enabled: true,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
  })),
  updateWorkflowStep: vi.fn((id: string, updates: Record<string, unknown>) => Promise.resolve({
    ...mockSteps.find((s) => s.id === id),
    ...updates,
    updatedAt: "2026-01-03T00:00:00.000Z",
  })),
  deleteWorkflowStep: vi.fn(() => Promise.resolve()),
  refineWorkflowStepPrompt: vi.fn(() => Promise.resolve({
    prompt: "AI-generated detailed prompt",
    workflowStep: { ...mockSteps[0], prompt: "AI-generated detailed prompt" },
  })),
}));

import {
  fetchWorkflowSteps,
  createWorkflowStep,
  updateWorkflowStep,
  deleteWorkflowStep,
  refineWorkflowStepPrompt,
} from "../../api";

const onClose = vi.fn();
const addToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowStepManager", () => {
  it("does not render when closed", () => {
    const { container } = render(
      <WorkflowStepManager isOpen={false} onClose={onClose} addToast={addToast} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders list of workflow steps", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
      expect(screen.getByText("QA Check")).toBeInTheDocument();
    });
  });

  it("shows empty state when no steps exist", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
      expect(screen.getByText(/No workflow steps defined/)).toBeInTheDocument();
    });
  });

  it("opens create form when Add button is clicked", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(screen.getByTestId("workflow-step-form")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-step-name")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-step-description")).toBeInTheDocument();
  });

  it("submits new workflow step", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    const nameInput = screen.getByTestId("workflow-step-name");
    const descInput = screen.getByTestId("workflow-step-description");

    fireEvent.change(nameInput, { target: { value: "New Step" } });
    fireEvent.change(descInput, { target: { value: "New description" } });

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(createWorkflowStep).toHaveBeenCalledWith({
        name: "New Step",
        description: "New description",
        prompt: undefined,
        enabled: true,
      });
      expect(addToast).toHaveBeenCalledWith("Workflow step created", "success");
    });
  });

  it("edits existing workflow step", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(mockSteps)
      .mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    // Click edit button for the first step
    const editBtn = screen.getByLabelText("Edit Documentation Review");
    fireEvent.click(editBtn);

    // Form should be pre-populated
    expect(screen.getByTestId("workflow-step-form")).toBeInTheDocument();
    const nameInput = screen.getByTestId("workflow-step-name") as HTMLInputElement;
    expect(nameInput.value).toBe("Documentation Review");

    // Change the name
    fireEvent.change(nameInput, { target: { value: "Updated Name" } });
    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({
        name: "Updated Name",
      }));
      expect(addToast).toHaveBeenCalledWith("Workflow step updated", "success");
    });
  });

  it("deletes workflow step with confirmation", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(mockSteps)
      .mockResolvedValueOnce([mockSteps[1]]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    // Click delete (first shows confirm dialog)
    const deleteBtn = screen.getByLabelText("Delete Documentation Review");
    fireEvent.click(deleteBtn);

    // Confirm delete
    const confirmBtn = screen.getByLabelText("Confirm delete Documentation Review");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteWorkflowStep).toHaveBeenCalledWith("WS-001");
      expect(addToast).toHaveBeenCalledWith("Workflow step deleted", "success");
    });
  });

  it("calls refine API and updates prompt", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(mockSteps)
      .mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    // Edit first step
    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Click refine button
    const refineBtn = screen.getByTestId("refine-btn");
    fireEvent.click(refineBtn);

    await waitFor(() => {
      expect(refineWorkflowStepPrompt).toHaveBeenCalledWith("WS-001");
      expect(addToast).toHaveBeenCalledWith("Prompt refined with AI", "success");
    });
  });

  it("handles API errors gracefully", async () => {
    vi.mocked(fetchWorkflowSteps).mockRejectedValueOnce(new Error("Network error"));

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Network error", "error");
    });
  });

  it("shows enabled/disabled badges", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Enabled")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });
});
