import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Sparkles: () => null,
  Globe: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  X: () => null,
  Bot: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
}));

// Mock the api module
vi.mock("../../api", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({}),
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
  fetchAgents: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
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

function renderNewTaskModal(props = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    tasks: [] as Task[],
    onCreateTask: vi.fn().mockResolvedValue({ id: "FN-001" }),
    addToast: vi.fn(),
    onPlanningMode: vi.fn(),
    onSubtaskBreakdown: vi.fn(),
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
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subtask" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    expect(screen.getByRole("button", { name: "Add dependencies" })).toBeTruthy();
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows More options toggle and reveals advanced fields when clicked", () => {
    renderNewTaskModal();

    const toggle = screen.getByTestId("task-form-more-options-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add dependencies" })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Add dependencies" })).toBeTruthy();
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
  });

  it("renders attachments before dependencies in form order", () => {
    renderNewTaskModal();

    const attachmentsLabel = screen.getByText("Attachments");
    const dependenciesLabel = screen.getByText("Dependencies");

    expect(
      attachmentsLabel.compareDocumentPosition(dependenciesLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const textarea = screen.getByRole('textbox');
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("creates task with description when submitted", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Created FN-042", "success");
    });
  });

  it("confirms before closing with dirty state", () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
    fireEvent.change(descTextarea, { target: { value: "Some text" } });
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).not.toBeDisabled();
  });

  // Preset selection tests (FN-819)
  describe("model preset selection payload", () => {
    it("omits modelPresetId from payload when in default mode", async () => {
      const { props } = renderNewTaskModal();

      const descTextarea = screen.getByRole('textbox');
      fireEvent.change(descTextarea, { target: { value: "Default mode task" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: undefined,
          }),
        );
      });
    });

    it("includes modelPresetId and model overrides in payload when preset is selected", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValue({
        modelPresets: [
          { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5", validatorProvider: "openai", validatorModelId: "gpt-4o" },
        ],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
      });

      const { props } = renderNewTaskModal();

      // Wait for settings to load and preset dropdown to populate
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(select).toBeTruthy();
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Preset task" } });

      // Select the preset
      const select = document.getElementById("model-preset") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "fast" } });

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: "fast",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            validatorModelProvider: "openai",
            validatorModelId: "gpt-4o",
          }),
        );
      });
    });

    it("omits modelPresetId from payload when switching from preset to custom", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValue({
        modelPresets: [
          { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
        ],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
      });

      const { props } = renderNewTaskModal();

      // Wait for settings to load
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Custom task" } });

      // Select a preset first
      const select = document.getElementById("model-preset") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "fast" } });

      // Now switch to custom
      fireEvent.change(select, { target: { value: "custom" } });

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            modelPresetId: undefined,
          }),
        );
      });
    });
  });

  // Workflow step ordering tests (FN-836)
  describe("workflow step ordering", () => {
    it("sends selected enabledWorkflowSteps in create payload", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Task with workflow step" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: ["WS-001"],
          }),
        );
      });
    });

    it("sends ordered enabledWorkflowSteps in create payload when steps are selected in order", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
        { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      // Select WS-001, then WS-002 — order should be preserved
      const checkbox1 = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox1);

      const checkbox2 = screen.getByTestId("workflow-step-checkbox-WS-002").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox2);

      // Type description and submit
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Ordered task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: ["WS-001", "WS-002"],
          }),
        );
      });
    });

    it("sends reordered enabledWorkflowSteps after user reorders steps", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
        { id: "WS-002", name: "Security Audit", description: "Check security", prompt: "Check security", enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      // Select WS-001, then WS-002
      const checkbox1 = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox1);

      const checkbox2 = screen.getByTestId("workflow-step-checkbox-WS-002").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox2);

      // Now reorder: move WS-002 up
      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-move-up-WS-002")).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId("workflow-step-move-up-WS-002"));

      // Type description and submit
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Reordered task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: ["WS-002", "WS-001"],
          }),
        );
      });
    });

  });

  // DefaultOn workflow step handling (FN-883)
  describe("defaultOn workflow step handling", () => {
    it("sends undefined enabledWorkflowSteps when no defaultOn steps and user hasn't interacted", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      // Don't interact with workflow steps at all
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "No interaction task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: undefined,
          }),
        );
      });
    });

    it("sends empty array when user explicitly deselects all defaultOn steps", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, defaultOn: true, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      // Wait for auto-selection to happen
      await waitFor(() => {
        const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
      });

      // User explicitly deselects the auto-selected step
      const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Deselected task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: [],
          }),
        );
      });
    });

    it("sends defaultOn step IDs when user doesn't modify the auto-selected steps", async () => {
      const { fetchWorkflowSteps } = await import("../../api");
      vi.mocked(fetchWorkflowSteps).mockResolvedValueOnce([
        { id: "WS-001", name: "QA Check", description: "Run tests", prompt: "Check tests", enabled: true, defaultOn: true, createdAt: "", updatedAt: "" },
        { id: "WS-002", name: "Security", description: "Check security", prompt: "Check", enabled: true, defaultOn: false, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("workflow-step-checkbox-WS-001")).toBeTruthy();
      });

      // Wait for auto-selection to happen
      await waitFor(() => {
        const checkbox = screen.getByTestId("workflow-step-checkbox-WS-001").querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
      });

      // Don't modify the selection — just submit.
      // Since user hasn't explicitly changed steps, the explicitlySet flag is false,
      // so the modal sends undefined (backend applies its own defaults)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Auto-selected task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: undefined,
          }),
        );
      });
    });
  });

  // Agent assignment tests (FN-1483)
  describe("agent assignment", () => {
    it("renders agent picker button", () => {
      renderNewTaskModal();
      expect(screen.getByTestId("new-task-agent-button")).toBeTruthy();
      expect(screen.getByText("Assign agent")).toBeTruthy();
    });

    it("shows dropdown when agent button is clicked", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeTruthy();
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });
    });

    it("excludes terminated agents from picker", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Active Agent", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
        { id: "agent-2", name: "Terminated Agent", role: "executor", state: "terminated" as const, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Active Agent")).toBeTruthy();
        expect(screen.queryByText("Terminated Agent")).toBeNull();
      });
    });

    it("shows selected agent name in button", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      await waitFor(() => {
        expect(screen.getByTestId("new-task-agent-button")).toHaveTextContent("Executor Bot");
      });
    });

    it("includes assignedAgentId in payload when agent is selected", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            assignedAgentId: "agent-1",
          }),
        );
      });
    });

    it("omits assignedAgentId from payload when no agent is selected", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Task without agent" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({
            assignedAgentId: expect.anything(),
          }),
        );
      });
    });

    it("omits assignedAgentId from payload after clearing selection", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Open picker again and clear selection
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Clear selection")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Clear selection"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({
            assignedAgentId: expect.anything(),
          }),
        );
      });
    });

    it("triggers dirty state when agent is selected", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Mock confirm to return true (confirm discard)
      const originalConfirm = window.confirm;
      window.confirm = vi.fn().mockReturnValue(true);

      // Try to close - should show confirm
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(window.confirm).toHaveBeenCalledWith("You have unsaved changes. Discard them?");

      window.confirm = originalConfirm;
    });

    it("resets agent selection after successful task creation", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByRole('textbox'), { target: { value: "Task with agent" } });

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Submit
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(screen.getByTestId("new-task-agent-button")).toHaveTextContent("Assign agent");
      });
    });
  });
});
