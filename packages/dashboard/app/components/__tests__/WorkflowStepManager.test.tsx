import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowStepManager } from "../WorkflowStepManager";
import type { WorkflowStep } from "@fusion/core";

const mockSteps: WorkflowStep[] = [
  {
    id: "WS-001",
    name: "Documentation Review",
    description: "Verify all public APIs have documentation",
    mode: "prompt",
    prompt: "Review the task changes and verify docs.",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "WS-002",
    name: "QA Check",
    description: "Run tests and verify they pass",
    mode: "prompt",
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
    mode: "prompt",
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
  fetchScripts: vi.fn(() => Promise.resolve({ test: "pnpm test", lint: "pnpm lint" })),
  fetchModels: vi.fn(() => Promise.resolve({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  })),
}));

// Mock CustomModelDropdown - renders a simple test-friendly control
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    disabled?: boolean;
    models?: unknown[];
    placeholder?: string;
    id?: string;
    favoriteProviders?: string[];
    onToggleFavorite?: (provider: string) => void;
    favoriteModels?: string[];
    onToggleModelFavorite?: (modelId: string) => void;
  }) => (
    <div data-testid={`custom-model-dropdown-${label}`}>
      <span data-testid={`dropdown-value-${label}`}>{value || "none"}</span>
      <button
        data-testid={`dropdown-select-${label}`}
        onClick={() => onChange("anthropic/claude-sonnet-4-5")}
        disabled={disabled}
      >
        Select {label}
      </button>
      <button
        data-testid={`dropdown-clear-${label}`}
        onClick={() => onChange("")}
      >
        Clear {label}
      </button>
    </div>
  ),
}));

import {
  fetchWorkflowSteps,
  createWorkflowStep,
  updateWorkflowStep,
  deleteWorkflowStep,
  refineWorkflowStepPrompt,
  fetchModels,
} from "../../api";
import { fetchScripts } from "../../api";

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
        mode: "prompt",
        phase: "pre-merge",
        prompt: undefined,
        scriptName: undefined,
        enabled: true,
        defaultOn: undefined,
      }, undefined);
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
      }), undefined);
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
      expect(deleteWorkflowStep).toHaveBeenCalledWith("WS-001", undefined);
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
      expect(refineWorkflowStepPrompt).toHaveBeenCalledWith("WS-001", undefined);
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

  it("shows AI Prompt mode badge and Pre-merge phase badge for legacy prompt steps", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(mockSteps);
    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);
    await waitFor(() => {
      expect(screen.getAllByText("AI Prompt")).toHaveLength(2);
      // Legacy steps without phase default to Pre-merge
      expect(screen.queryAllByText("Pre-merge")).toHaveLength(2);
    });
  });

  it("shows Script mode badge for script steps", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { ...mockSteps[0], mode: "script" as const, scriptName: "test", prompt: "", phase: "pre-merge" },
    ]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Script")).toBeInTheDocument();
    });
  });

  it("shows Pre-merge and Post-merge phase badges for steps with explicit phases", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
      { ...mockSteps[0], phase: "pre-merge" as const },
      { ...mockSteps[1], phase: "post-merge" as const },
    ]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Pre-merge")).toBeInTheDocument();
      expect(screen.getByText("Post-merge")).toBeInTheDocument();
    });
  });

  it("shows mode selector when creating a new step", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(screen.getByTestId("workflow-step-mode-selector")).toBeInTheDocument();
    expect(screen.getByTestId("mode-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("mode-script")).toBeInTheDocument();
  });

  it("shows prompt field in prompt mode and script select in script mode", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    // Default is prompt mode — should show prompt field
    expect(screen.getByTestId("workflow-step-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-step-script-select")).not.toBeInTheDocument();

    // Switch to script mode
    fireEvent.click(screen.getByTestId("mode-script"));

    expect(screen.queryByTestId("workflow-step-prompt")).not.toBeInTheDocument();
    expect(screen.getByTestId("workflow-step-script-select")).toBeInTheDocument();

    // Switch back to prompt mode
    fireEvent.click(screen.getByTestId("mode-prompt"));

    expect(screen.getByTestId("workflow-step-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-step-script-select")).not.toBeInTheDocument();
  });

  it("loads script name when editing a script-mode step", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce([{ ...mockSteps[0], mode: "script" as const, scriptName: "test", prompt: "" }])
      .mockResolvedValueOnce([{ ...mockSteps[0], mode: "script" as const, scriptName: "test", prompt: "" }]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Script mode should be selected
    const scriptSelect = screen.getByTestId("workflow-step-script-select") as HTMLSelectElement;
    expect(scriptSelect.value).toBe("test");
  });

  it("disables save when script mode is selected without a script name", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    const nameInput = screen.getByTestId("workflow-step-name");
    const descInput = screen.getByTestId("workflow-step-description");

    fireEvent.change(nameInput, { target: { value: "Test" } });
    fireEvent.change(descInput, { target: { value: "Test desc" } });

    // Switch to script mode
    fireEvent.click(screen.getByTestId("mode-script"));

    // Save should be disabled (no script selected)
    const saveBtn = screen.getByTestId("save-workflow-step") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it("submits new workflow step with post-merge phase", async () => {
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

    fireEvent.change(nameInput, { target: { value: "Post Step" } });
    fireEvent.change(descInput, { target: { value: "Post desc" } });

    // Default phase is pre-merge; switch to post-merge
    fireEvent.click(screen.getByTestId("phase-post-merge"));

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(createWorkflowStep).toHaveBeenCalledWith({
        name: "Post Step",
        description: "Post desc",
        mode: "prompt",
        phase: "post-merge",
        prompt: undefined,
        scriptName: undefined,
        enabled: true,
        defaultOn: undefined,
      }, undefined);
      expect(addToast).toHaveBeenCalledWith("Workflow step created", "success");
    });
  });

  it("edits existing workflow step phase from pre-merge to post-merge", async () => {
    vi.mocked(fetchWorkflowSteps).mockReset();
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(mockSteps)
      .mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    // Wait for steps to render (not just the fetch call)
    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    // Click edit button for the first step
    const editBtn = screen.getByLabelText("Edit Documentation Review");
    fireEvent.click(editBtn);

    expect(screen.getByTestId("workflow-step-form")).toBeInTheDocument();

    // Switch phase to post-merge
    fireEvent.click(screen.getByTestId("phase-post-merge"));

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(updateWorkflowStep).toHaveBeenCalledWith("WS-001", expect.objectContaining({
        phase: "post-merge",
      }), undefined);
      expect(addToast).toHaveBeenCalledWith("Workflow step updated", "success");
    });
  });

  it("shows defaultOn checkbox in create form", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    const defaultOnCheckbox = screen.getByTestId("workflow-step-default-on") as HTMLInputElement;
    expect(defaultOnCheckbox).toBeInTheDocument();
    expect(defaultOnCheckbox.checked).toBe(false);
  });

  it("creates workflow step with defaultOn true", async () => {
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
    fireEvent.change(nameInput, { target: { value: "Auto Step" } });
    fireEvent.change(descInput, { target: { value: "Auto-enabled" } });

    // Check the defaultOn checkbox
    const defaultOnCheckbox = screen.getByTestId("workflow-step-default-on");
    fireEvent.click(defaultOnCheckbox);

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(createWorkflowStep).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Auto Step",
          defaultOn: true,
        }),
        undefined,
      );
    });
  });

  it("prefills defaultOn when editing a step with defaultOn true", async () => {
    const stepsWithDefaultOn: WorkflowStep[] = [
      { ...mockSteps[0], defaultOn: true },
    ];
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(stepsWithDefaultOn);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    const defaultOnCheckbox = screen.getByTestId("workflow-step-default-on") as HTMLInputElement;
    expect(defaultOnCheckbox.checked).toBe(true);
  });

  it("shows default-on badge for steps with defaultOn true", async () => {
    const stepsWithDefaultOn: WorkflowStep[] = [
      { ...mockSteps[0], defaultOn: true },
      { ...mockSteps[1], defaultOn: false },
    ];
    vi.mocked(fetchWorkflowSteps).mockReset();
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(stepsWithDefaultOn);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
      expect(screen.getByText("QA Check")).toBeInTheDocument();
    });

    // Only the first step should have the "Default on" badge
    const badges = screen.getAllByText("Default on");
    expect(badges).toHaveLength(1);
  });

  it("does not show default-on badge when defaultOn is false or undefined", async () => {
    vi.mocked(fetchWorkflowSteps).mockReset();
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    expect(screen.queryByText("Default on")).not.toBeInTheDocument();
  });
});

describe("WorkflowStepManager theme class structure", () => {
  it("uses wfm-body class for modal body", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(container.querySelector(".wfm-body")).toBeInTheDocument();
    });
  });

  it("uses wfm-tab-row and wfm-tab-btn classes for tab navigation", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("tab-my-steps")).toBeInTheDocument();
    });

    expect(container.querySelector(".wfm-tab-row")).toBeInTheDocument();
    expect(container.querySelectorAll(".wfm-tab-btn")).toHaveLength(2);
  });

  it("uses wfm-empty class for empty state", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    expect(container.querySelector(".wfm-empty")).toBeInTheDocument();
  });

  it("uses wfm-step-card and badge classes for step list items", async () => {
    vi.mocked(fetchWorkflowSteps).mockReset();
    vi.mocked(fetchWorkflowSteps).mockResolvedValue(mockSteps);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await screen.findByText("Documentation Review");

    // Step cards use class-based styling
    expect(container.querySelectorAll(".wfm-step-card")).toHaveLength(2);
    expect(container.querySelectorAll(".wfm-step-card-name")).toHaveLength(2);
    expect(container.querySelectorAll(".wfm-step-card-desc")).toHaveLength(2);

    // Badges use class-based styling
    expect(container.querySelector(".wfm-badge-enabled")).toBeInTheDocument();
    expect(container.querySelector(".wfm-badge-disabled")).toBeInTheDocument();
    expect(container.querySelectorAll(".wfm-badge-prompt")).toHaveLength(2);
  });

  it("uses wfm-step-card with script badge for script-mode steps", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValue([
      { ...mockSteps[0], mode: "script" as const, scriptName: "test", prompt: "" },
    ]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await screen.findByText("Script");

    expect(container.querySelector(".wfm-badge-script")).toBeInTheDocument();
  });

  it("uses wfm-form and wfm-field classes for the edit/create form", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(container.querySelector(".wfm-form")).toBeInTheDocument();
    expect(container.querySelector(".wfm-form-title")).toBeInTheDocument();
    expect(container.querySelector(".wfm-form-fields")).toBeInTheDocument();
    expect(container.querySelectorAll(".wfm-field").length).toBeGreaterThanOrEqual(3); // name, description, mode
  });

  it("uses wfm-mode-selector and wfm-mode-btn classes for mode toggle", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(container.querySelector(".wfm-mode-selector")).toBeInTheDocument();
    expect(container.querySelectorAll(".wfm-mode-btn")).toHaveLength(4); // 2 mode + 2 phase
  });

  it("uses wfm-prompt-textarea class for the prompt textarea", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(container.querySelector(".wfm-prompt-textarea")).toBeInTheDocument();
    expect(container.querySelector(".wfm-prompt-header")).toBeInTheDocument();
    expect(container.querySelector(".wfm-refine-btn")).toBeInTheDocument();
  });

  it("uses wfm-checkbox-label class for enabled toggle", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(container.querySelector(".wfm-checkbox-label")).toBeInTheDocument();
  });

  it("uses wfm-form-actions class for form action buttons", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    expect(container.querySelector(".wfm-form-actions")).toBeInTheDocument();
  });

  it("uses wfm-footer and wfm-footer-add-btn classes for footer", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    expect(container.querySelector(".wfm-footer")).toBeInTheDocument();
    expect(container.querySelector(".wfm-footer-add-btn")).toBeInTheDocument();
  });

  it("uses wfm-no-scripts class when script mode has no scripts", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    const { container } = render(
      <WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));
    fireEvent.click(screen.getByTestId("mode-script"));

    expect(container.querySelector(".wfm-no-scripts")).toBeInTheDocument();
  });
});

describe("WorkflowStepManager model override", () => {
  it("shows model override field in prompt mode", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    // Model override field should be visible in prompt mode
    expect(screen.getByTestId("workflow-step-model-field")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-step-model-select")).toBeInTheDocument();
  });

  it("does not show model override field in script mode", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));
    fireEvent.click(screen.getByTestId("mode-script"));

    // Model override field should NOT be visible in script mode
    expect(screen.queryByTestId("workflow-step-model-field")).not.toBeInTheDocument();
  });

  it("clears model override when switching from prompt to script mode", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    // Select a model via the mock dropdown
    const selectBtn = screen.getByTestId("dropdown-select-Model override for this workflow step");
    fireEvent.click(selectBtn);

    // Verify hint shows the selected model
    await waitFor(() => {
      expect(screen.getByText("Using anthropic/claude-sonnet-4-5")).toBeInTheDocument();
    });

    // Switch to script mode
    fireEvent.click(screen.getByTestId("mode-script"));

    // Switch back to prompt mode — model should be cleared
    fireEvent.click(screen.getByTestId("mode-prompt"));
    await waitFor(() => {
      expect(screen.getByText("Using global default model")).toBeInTheDocument();
    });
  });

  it("sends model override when creating a prompt-mode step with model selected", async () => {
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
    fireEvent.change(nameInput, { target: { value: "Security Scan" } });
    fireEvent.change(descInput, { target: { value: "Run security audit" } });

    // Select a model via the mock dropdown
    const selectBtn = screen.getByTestId("dropdown-select-Model override for this workflow step");
    fireEvent.click(selectBtn);

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(createWorkflowStep).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Security Scan",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        }),
        undefined,
      );
    });
  });

  it("sends undefined model fields when creating without model selection", async () => {
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
    fireEvent.change(nameInput, { target: { value: "QA Check" } });
    fireEvent.change(descInput, { target: { value: "Run tests" } });

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(createWorkflowStep).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "QA Check",
          modelProvider: undefined,
          modelId: undefined,
        }),
        undefined,
      );
    });
  });

  it("populates model fields when editing a step with model override", async () => {
    const stepWithModel: WorkflowStep[] = [
      {
        ...mockSteps[0],
        modelProvider: "openai",
        modelId: "gpt-4o",
      },
    ];
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(stepWithModel)
      .mockResolvedValueOnce(stepWithModel);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Model dropdown should show the existing override
    await waitFor(() => {
      expect(screen.getByText("Using openai/gpt-4o")).toBeInTheDocument();
    });
  });

  it("shows use-default hint when editing a step without model override", async () => {
    vi.mocked(fetchWorkflowSteps).mockReset().mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Wait for the form to render with the model field
    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-model-field")).toBeInTheDocument();
    });
    expect(screen.getByText("Using global default model")).toBeInTheDocument();
  });

  it("sends model override when updating a step", async () => {
    vi.mocked(fetchWorkflowSteps)
      .mockResolvedValueOnce(mockSteps)
      .mockResolvedValueOnce(mockSteps);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Select a model via the mock dropdown
    const selectBtn = screen.getByTestId("dropdown-select-Model override for this workflow step");
    fireEvent.click(selectBtn);

    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(updateWorkflowStep).toHaveBeenCalledWith(
        "WS-001",
        expect.objectContaining({
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        }),
        undefined,
      );
    });
  });

  it("clears model override via clear button", async () => {
    const stepWithModel: WorkflowStep[] = [
      {
        ...mockSteps[0],
        modelProvider: "openai",
        modelId: "gpt-4o",
      },
    ];
    vi.mocked(fetchWorkflowSteps)
      .mockReset()
      .mockResolvedValueOnce(stepWithModel)
      .mockResolvedValueOnce(stepWithModel);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Edit Documentation Review"));

    // Wait for the form to render with the model field
    await waitFor(() => {
      expect(screen.getByTestId("workflow-step-model-field")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Using openai/gpt-4o")).toBeInTheDocument();
    });

    // Click the clear button
    const clearBtn = screen.getByTestId("clear-model-override");
    fireEvent.click(clearBtn);

    // Should now show default hint
    expect(screen.getByText("Using global default model")).toBeInTheDocument();

    // Save should send undefined model fields
    fireEvent.click(screen.getByTestId("save-workflow-step"));

    await waitFor(() => {
      expect(updateWorkflowStep).toHaveBeenCalledWith(
        "WS-001",
        expect.objectContaining({
          modelProvider: undefined,
          modelId: undefined,
        }),
        undefined,
      );
    });
  });

  it("shows clear button only when model override is set", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow-step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("add-workflow-step"));

    // No model selected — clear button should NOT be visible
    expect(screen.queryByTestId("clear-model-override")).not.toBeInTheDocument();

    // Select a model
    const selectBtn = screen.getByTestId("dropdown-select-Model override for this workflow step");
    fireEvent.click(selectBtn);

    // Now clear button should be visible
    await waitFor(() => {
      expect(screen.getByTestId("clear-model-override")).toBeInTheDocument();
    });
  });

  it("loads models via fetchModels on open", async () => {
    vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([]);

    render(<WorkflowStepManager isOpen={true} onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalled();
    });
  });
});
