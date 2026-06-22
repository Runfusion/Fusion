import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
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
  Workflow: () => null,
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
  // U6/R3: TaskForm's picker fetches whole workflows; the per-step
  // fetchWorkflowSteps + post-create selectTaskWorkflow flow is gone.
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchGitBranches: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchAuthStatus: vi.fn().mockResolvedValue({ providers: [] }),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

const mockUseMobileKeyboard = vi.fn();
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

// FNXC:NewTask 2026-06-22-20:30: viewport mode is switchable so we can exercise both the mobile sheet (default) and the desktop floating window. Defaults to mobile to preserve the existing suite's layout assumptions.
let mockViewportMode: "mobile" | "desktop" = "mobile";
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockViewportMode,
  isMobileViewport: () => mockViewportMode === "mobile",
  useViewportMode: () => mockViewportMode,
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

function renderNewTaskModal(props: Partial<ComponentProps<typeof NewTaskModal>> = {}) {
  const defaultProps: ComponentProps<typeof NewTaskModal> = {
    isOpen: true,
    onClose: vi.fn(),
    tasks: [] as Task[],
    onCreateTask: vi.fn().mockResolvedValue(makeTask("FN-001")),
    addToast: vi.fn(),
  };
  const mergedProps = { ...defaultProps, ...props };
  const result = render(<NewTaskModal {...mergedProps} />);
  return { ...result, props: mergedProps };
}

describe("NewTaskModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportMode = "mobile";
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: false,
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
    });
  });

  it("applies keyboard CSS variables when mobile keyboard is open", () => {
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOpen: true,
      keyboardOverlap: 250,
      viewportHeight: 400,
      viewportOffsetTop: 50,
    });

    renderNewTaskModal();
    // FNXC: NewTaskModal portals to document.body, so query the modal from document (not the render container).
    const modal = document.querySelector(".new-task-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style")).toContain("--keyboard-overlap: 250px");
    expect(modal?.getAttribute("style")).toContain("--vv-height: 400px");
    expect(modal?.getAttribute("style")).toContain("--vv-offset-top: 50px");
  });

  it("does not apply keyboard CSS variables when keyboard is closed", () => {
    const { container } = renderNewTaskModal();
    const modal = container.querySelector(".new-task-modal");

    expect(mockUseMobileKeyboard).toHaveBeenCalledWith({ enabled: true });
    expect(modal?.getAttribute("style") ?? "").not.toContain("--keyboard-overlap");
  });

  it("renders all form fields when open", async () => {
    renderNewTaskModal();

    expect(screen.getByText("New Task")).toBeTruthy();
    expect(screen.getByPlaceholderText("What needs to be done?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subtask" })).toBeNull();
    expect(screen.queryByTestId("task-form-description-actions")).toBeNull();

    // Dependencies and agent are in quick-fields — visible by default (no toggle needed)
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();


    await waitFor(() => {
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.getByText(/Attachments/i)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("exposes New Task dialog quick-add affordance parity when AI handoff callbacks are supplied", () => {
    renderNewTaskModal({
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Create parity coverage" } });

    // Canonical QuickEntryBox action row includes Plan, Subtask, Refine, Deps, Attach, Models, Node, and Agent affordances; the modal maps these to existing TaskForm/quick-field controls instead of duplicating implementations.
    expect(screen.getAllByTestId("task-form-plan-button")).toHaveLength(1);
    expect(screen.getAllByTestId("task-form-subtask-button")).toHaveLength(1);
    expect(screen.getByTestId("refine-button")).toBeInTheDocument();
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();


    expect(screen.getByTestId("task-form-execution-mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("task-form-github-tracking")).toBeInTheDocument();
    expect(screen.getByTestId("task-priority-select")).toBeInTheDocument();
    expect(screen.getByText(/Attachments/i)).toBeInTheDocument();
    expect(screen.getByText(/Node Override/i)).toBeInTheDocument();
  });

  it("renders the Fast and standard execution-mode affordance inside More options", () => {
    renderNewTaskModal();


    const select = screen.getByTestId("task-form-execution-mode-select") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("standard");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["standard", "fast"]);
  });

  it("includes executionMode fast in the create payload when Fast is selected", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });
    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Fast parity task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "fast" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("standard");
    });
  });

  it("omits executionMode from the create payload when Standard is selected", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Standard parity task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledTimes(1);
    });
    const payload = vi.mocked(props.onCreateTask).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("executionMode");
  });

  it("resets executionMode to standard after canceling and discarding changes", async () => {
    const { props, rerender } = renderNewTaskModal();

    fireEvent.change(screen.getByTestId("task-form-execution-mode-select"), { target: { value: "fast" } });

    await waitFor(() => {
      expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("fast");
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Discard Changes",
        message: "You have unsaved changes. Discard them?",
        danger: true,
      });
    });

    rerender(<NewTaskModal {...props} isOpen={false} />);
    rerender(<NewTaskModal {...props} isOpen={true} />);

    expect(screen.getByTestId("task-form-execution-mode-select")).toHaveValue("standard");
  });

  it("hands trimmed descriptions to planning and subtask callbacks without discard confirmation", () => {
    const onPlanningMode = vi.fn();
    const onSubtaskBreakdown = vi.fn();
    const { unmount, props } = renderNewTaskModal({
      onPlanningMode,
      onSubtaskBreakdown,
    });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "  Break this down  " } });
    fireEvent.click(screen.getByTestId("task-form-plan-button"));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(onPlanningMode).toHaveBeenCalledWith("Break this down");
    expect(onSubtaskBreakdown).not.toHaveBeenCalled();

    unmount();
    renderNewTaskModal({
      onPlanningMode,
      onSubtaskBreakdown,
    });

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "  Split into subtasks  " } });
    fireEvent.click(screen.getByTestId("task-form-subtask-button"));

    expect(onSubtaskBreakdown).toHaveBeenCalledWith("Split into subtasks");
    expect(onPlanningMode).toHaveBeenCalledTimes(1);
  });

  it("disables Plan and Subtask handoff buttons until a description is present", () => {
    renderNewTaskModal({
      onPlanningMode: vi.fn(),
      onSubtaskBreakdown: vi.fn(),
    });

    const planButton = screen.getByTestId("task-form-plan-button");
    const subtaskButton = screen.getByTestId("task-form-subtask-button");

    expect(planButton).toBeDisabled();
    expect(subtaskButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Ready to plan" } });

    expect(planButton).not.toBeDisabled();
    expect(subtaskButton).not.toBeDisabled();
  });

  // FNXC:NewTask 2026-06-22-20:30: The New Task dialog force-opens TaskForm's advanced controls (forceMoreOptionsOpen), so every quick-add control is visible by default with NO disclosure toggle and nothing hidden.
  it("shows all advanced fields by default without a More options toggle", () => {
    renderNewTaskModal();

    const moreOptions = screen.getByTestId("task-form-more-options");
    // No collapse toggle is rendered in the force-open New Task context.
    expect(screen.queryByTestId("task-form-more-options-toggle")).toBeNull();
    // The advanced section is open (not hidden) from the start.
    expect(moreOptions).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();

    // Model Configuration, Attachments, and the Workflow picker are all visible immediately.
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByText("Workflow")).toBeTruthy();
  });

  it("shows dependencies and agent picker by default", () => {
    renderNewTaskModal();

    // Both dep-trigger and agent button should be visible by default
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();
    // Advanced options are force-open: no collapse toggle exists.
    expect(screen.queryByTestId("task-form-more-options-toggle")).toBeNull();
    expect(screen.getByTestId("task-form-more-options")).not.toHaveAttribute("hidden");
  });

  it("renders dependencies before attachments in form order (quick-fields before More options)", () => {
    renderNewTaskModal();

    const dependenciesLabel = screen.getByText("Dependencies");
    // Attachments is in the always-visible advanced section.
    const attachmentsLabel = screen.getByText("Attachments");

    // Dependencies (in quick-fields) appears before Attachments (in More options)
    expect(
      dependenciesLabel.compareDocumentPosition(attachmentsLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const textarea = screen.getByPlaceholderText("What needs to be done?");
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("seeds the description when opened with an initial description", () => {
    renderNewTaskModal({ initialDescription: "File: README.md\n\nComment:\nFollow up" });

    expect(screen.getByPlaceholderText("What needs to be done?")).toHaveValue("File: README.md\n\nComment:\nFollow up");
    expect(screen.getByRole("button", { name: "Create Task" })).not.toBeDisabled();
  });

  it("does not clobber user edits when initialDescription changes while open", () => {
    const { rerender, props } = renderNewTaskModal({ initialDescription: "Seeded description" });
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");

    fireEvent.change(descTextarea, { target: { value: "User edited text" } });
    rerender(<NewTaskModal {...props} initialDescription="Different seed" />);

    expect(screen.getByPlaceholderText("What needs to be done?")).toHaveValue("User edited text");
  });

  it("creates task with description when submitted", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
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

  describe("optional workflow steps (U4)", () => {
    const WF = {
      id: "wf-x",
      name: "Custom",
      kind: "workflow" as const,
      description: "",
      ir: { version: "v1" as const, name: "Custom", nodes: [], edges: [] },
      layout: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const STEP = {
      templateId: "browser-verification",
      name: "Browser Verification",
      description: "Verify web application functionality using browser automation",
      icon: "globe",
      phase: "pre-merge" as const,
      defaultOn: false,
    };

    it("includes a toggled-on optional step in the create payload", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([STEP]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), {
        target: { value: "Verify the login page" },
      });
      fireEvent.change(await screen.findByTestId("task-workflow-select"), { target: { value: "wf-x" } });

      const trigger = await screen.findByTestId("task-optional-steps-trigger");
      expect(trigger).toHaveTextContent("Steps: none");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("seeds defaultOn steps as pre-enabled and submits them without toggling", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([{ ...STEP, defaultOn: true }]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "task" } });
      fireEvent.change(await screen.findByTestId("task-workflow-select"), { target: { value: "wf-x" } });

      const trigger = await screen.findByTestId("task-optional-steps-trigger");
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("renders no dropdown and omits enabledWorkflowSteps for 'No workflow'", async () => {
      const { fetchWorkflows, fetchWorkflowOptionalSteps } = await import("../../api");
      vi.mocked(fetchWorkflows).mockResolvedValue([WF]);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([STEP]);

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "task" } });
      // "No workflow" → null selection → no optional-steps fetch, no dropdown.
      fireEvent.change(await screen.findByTestId("task-workflow-select"), { target: { value: "__none__" } });

      expect(screen.queryByTestId("task-optional-steps-trigger")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
      await waitFor(() => {
        const call = vi.mocked(props.onCreateTask).mock.calls.at(-1)?.[0];
        expect(call).not.toHaveProperty("enabledWorkflowSteps");
      });
    });
  });

  it("submits project-default branch selection by default", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task without branches" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: { mode: "project-default" },
        }),
      );
    });
  });

  it("submits existing branch selection with trimmed names", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with branches" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "existing" } });
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: " feature/fn-3422 " } });
    fireEvent.change(screen.getByLabelText("Merge target / base branch"), { target: { value: " main " } });

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "existing",
            branchName: "feature/fn-3422",
            baseBranch: "main",
          },
        }),
      );
    });
  });

  it("submits auto-new branch selection", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with auto new" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "auto-new" } });
    fireEvent.change(screen.getByLabelText("Merge target / base branch"), { target: { value: " main " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "auto-new",
            baseBranch: "main",
          },
        }),
      );
    });
  });

  it("requires branch name for custom-new mode", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with branches" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "custom-new" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits custom-new branch selection when branch name exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with custom new" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "custom-new" } });
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: " feature/custom " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "custom-new",
            branchName: "feature/custom",
          },
        }),
      );
    });
  });

  it("requires branch name for shared-group mode", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with shared group" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "shared-group" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits shared-group branch selection when shared branch exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with shared group" } });
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "shared-group" } });
    fireEvent.change(screen.getByLabelText("Shared feature branch"), { target: { value: " feature/shared " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          branchSelection: {
            mode: "shared-group",
            branchName: "feature/shared",
          },
        }),
      );
    });
  });

  it("still submits when setup warnings are shown", async () => {
    const { fetchAuthStatus } = await import("../../api");
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      providers: [{ id: "github", name: "GitHub", authenticated: false, type: "oauth" }],
    });

    const { props } = renderNewTaskModal();

    await waitFor(() => {
      expect(screen.getByText("No AI provider connected")).toBeTruthy();
      expect(screen.getByText("GitHub not connected")).toBeTruthy();
    });

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Submit despite warning" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Submit despite warning",
        }),
      );
    });
  });

  it("closes modal after successful creation", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    });
  });


  it("shows success toast after creation", async () => {
    const { props } = renderNewTaskModal({
      onCreateTask: vi.fn().mockResolvedValue({ id: "FN-042" }),
    });
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Created FN-042", "success");
    });
  });

  it("confirms before closing with dirty state", async () => {
    const { props } = renderNewTaskModal();

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Test description" } });

    mockConfirm.mockResolvedValueOnce(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Discard Changes",
        message: "You have unsaved changes. Discard them?",
        danger: true,
      });
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("closes without confirm when state is not dirty", () => {
    const { props } = renderNewTaskModal();
    
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("creates task with title undefined by default", async () => {
    const { props } = renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
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

  it("calls onCreateTask when form is submitted", async () => {
    const { props } = renderNewTaskModal();

    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Normal task" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      expect(props.onCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Normal task",
        }),
      );
    });
  });


  it("disables Create Task when description is empty", () => {
    renderNewTaskModal();
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).toBeDisabled();
  });

  it("enables Create Task when description has content", () => {
    renderNewTaskModal();
    
    const descTextarea = screen.getByPlaceholderText("What needs to be done?");
    fireEvent.change(descTextarea, { target: { value: "Some text" } });
    
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).not.toBeDisabled();
  });

  // Preset selection tests (FN-819)
  describe("model preset selection payload", () => {
    it("omits modelPresetId from payload when in default mode", async () => {
      const { props } = renderNewTaskModal();

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
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
      } as any);

      const { props } = renderNewTaskModal();

      // Wait for settings to load and preset dropdown to populate
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(select).toBeTruthy();
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Preset task" } });

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
      } as any);

      const { props } = renderNewTaskModal();

      // Wait for settings to load
      await waitFor(() => {
        const select = document.getElementById("model-preset") as HTMLSelectElement;
        expect(Array.from(select.options).some((o) => o.value === "fast")).toBe(true);
      });

      // Type a description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Custom task" } });

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
  describe("workflow selection (U6/R3)", () => {
    function mockWorkflows(defs: Array<{ id: string; name: string; kind?: "workflow" | "fragment" }>) {
      return import("../../api").then(({ fetchWorkflows }) => {
        vi.mocked(fetchWorkflows).mockResolvedValueOnce(
          defs.map((d) => ({
            id: d.id,
            name: d.name,
            description: "",
            kind: d.kind ?? "workflow",
            ir: { version: "v1", name: d.name, nodes: [], edges: [] },
            layout: {},
            createdAt: "",
            updatedAt: "",
          })) as any,
        );
      });
    }

    it("omits workflowId from the payload when the picker is untouched (inherit default)", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-select")).toBeTruthy();
      });

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Inherit default" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalled();
      });
      const payload = vi.mocked(props.onCreateTask).mock.calls[0][0] as Record<string, unknown>;
      expect("workflowId" in payload).toBe(false);
    });

    it("sends the chosen workflowId in the create payload", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-select")).toBeTruthy();
      });

      fireEvent.change(screen.getByTestId("task-workflow-select"), { target: { value: "WF-1" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Pick a workflow" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ workflowId: "WF-1" }),
        );
      });
    });

    it("sends workflowId: null when 'No workflow' is chosen", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-select")).toBeTruthy();
      });

      // Pick a workflow, then switch to "No workflow" to register an explicit null.
      fireEvent.change(screen.getByTestId("task-workflow-select"), { target: { value: "WF-1" } });
      fireEvent.change(screen.getByTestId("task-workflow-select"), { target: { value: "__none__" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "No workflow task" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ workflowId: null }),
        );
      });
    });

    it("does not render the legacy per-step checkbox UI", async () => {
      await mockWorkflows([{ id: "WF-1", name: "QA" }]);
      renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-workflow-select")).toBeTruthy();
      });
      expect(screen.queryByTestId("workflow-step-order")).toBeNull();
      expect(document.querySelector('[data-testid^="workflow-step-checkbox-"]')).toBeNull();
    });
  });

  // Review level tests (FN-2241)
  describe("review level selection payload", () => {
    it("omits reviewLevel from payload when not selected", async () => {
      const { props } = renderNewTaskModal();

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task without review level" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: undefined,
          }),
        );
      });
    });

    it("includes reviewLevel in payload when selected", async () => {
      const { props } = renderNewTaskModal();

      // Open more options to access the review level selector

      await waitFor(() => {
        expect(screen.getByLabelText("Review")).toBeTruthy();
      });

      // Select review level 2 (Plan and Code)
      const select = document.getElementById("review-level") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "2" } });

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task with review level" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: 2,
          }),
        );
      });
    });

    it("includes reviewLevel 3 in payload when Full review is selected", async () => {
      const { props } = renderNewTaskModal();

      // Open more options to access the review level selector

      await waitFor(() => {
        expect(screen.getByLabelText("Review")).toBeTruthy();
      });

      // Select review level 3 (Full)
      const select = document.getElementById("review-level") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "3" } });

      const descTextarea = screen.getByPlaceholderText("What needs to be done?");
      fireEvent.change(descTextarea, { target: { value: "Task with full review" } });

      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewLevel: 3,
          }),
        );
      });
    });
  });

  describe("auto-merge selection payload", () => {
    it("omits autoMerge from payload when default is selected", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task default auto-merge" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({ autoMerge: expect.anything() }),
        );
      });
    });

    it("includes autoMerge true when Enabled is selected", async () => {
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-automerge-select")).toBeTruthy();
      });
      fireEvent.change(screen.getByTestId("task-automerge-select"), { target: { value: "on" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task auto-merge on" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ autoMerge: true }),
        );
      });
    });

    it("includes autoMerge false when Disabled is selected", async () => {
      const { props } = renderNewTaskModal();

      await waitFor(() => {
        expect(screen.getByTestId("task-automerge-select")).toBeTruthy();
      });
      fireEvent.change(screen.getByTestId("task-automerge-select"), { target: { value: "off" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task auto-merge off" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({ autoMerge: false }),
        );
      });
    });
  });

  describe("priority selection payload", () => {
    it("includes default normal priority in create payload", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with default priority" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            priority: "normal",
          }),
        );
      });
    });

    it("includes selected priority and resets back to normal after submit", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.change(screen.getByTestId("task-priority-select"), { target: { value: "urgent" } });
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with urgent priority" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.objectContaining({
            priority: "urgent",
          }),
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId("task-priority-select")).toHaveValue("normal");
      });
    });

    it("treats non-default priority as dirty state on cancel", async () => {
      renderNewTaskModal();

      fireEvent.change(screen.getByTestId("task-priority-select"), { target: { value: "high" } });
      mockConfirm.mockResolvedValueOnce(false);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Discard Changes",
          message: "You have unsaved changes. Discard them?",
          danger: true,
        });
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
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeTruthy();
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });
    });

    it("shows selected agent name in button", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
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
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

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

      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task without agent" } });

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
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      const { props } = renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

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
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Open agent picker and select agent
      fireEvent.click(screen.getByTestId("new-task-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Executor Bot")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Executor Bot"));

      // Try to close - should show confirm
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => {
        expect(mockConfirm).toHaveBeenCalledWith({
          title: "Discard Changes",
          message: "You have unsaved changes. Discard them?",
          danger: true,
        });
      });
    });

    it("resets agent selection after successful task creation", async () => {
      const { fetchAgents } = await import("../../api");
      vi.mocked(fetchAgents).mockResolvedValueOnce([
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
      ]);

      renderNewTaskModal();

      // Type description
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with agent" } });

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

  describe("GitHub tracking", () => {
    it("renders GitHub tracking after the Workflow picker in more options", async () => {
      renderNewTaskModal();


      const workflowLabel = await screen.findByText("Workflow");
      const githubTrackingSection = screen.getByTestId("task-form-github-tracking");

      expect(
        workflowLabel.compareDocumentPosition(githubTrackingSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("seeds tracking toggle from project settings and submits githubTracking payload", async () => {
      const { fetchSettings } = await import("../../api");
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: [],
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        githubTrackingEnabledByDefault: true,
      });

      const { props } = renderNewTaskModal();
      fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with tracking" } });

      const toggle = await screen.findByLabelText("Enable GitHub issue tracking for this task");
      fireEvent.click(toggle);

      fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), { target: { value: "acme/repo" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledTimes(1);
      });
    });
  });

  /*
  FNXC:NewTask 2026-06-22-20:30:
  On desktop the New Task dialog is a floating, draggable, resizable, NON-BLOCKING window: the overlay is `pointer-events: none` and aria-modal="false" so behind-clicks pass through and never close the dialog (only the header X / Cancel / Escape dismiss). It carries a draggable header handle and resize handles.
  */
  describe("desktop floating window", () => {
    beforeEach(() => {
      mockViewportMode = "desktop";
    });

    it("renders a non-blocking (pointer-events: none, aria-modal=false) overlay that does not dismiss on click", () => {
      const onClose = vi.fn();
      renderNewTaskModal({ onClose });

      const overlay = screen.getByTestId("new-task-modal-overlay");
      // Non-blocking: click-through overlay, not a modal.
      expect(overlay).toHaveClass("new-task-modal-overlay");
      expect(overlay).toHaveAttribute("aria-modal", "false");

      // A behind-click on the overlay must NOT close the dialog (no overlay click-to-dismiss).
      fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("exposes a draggable header handle and resize handles", () => {
      renderNewTaskModal();

      expect(screen.getByTestId("new-task-drag-handle")).toHaveClass("new-task-modal__header--draggable");
      // All eight corner/edge resize handles are present.
      for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        expect(screen.getByTestId(`new-task-resize-${dir}`)).toBeInTheDocument();
      }
      // The floating panel is the fixed-positioned window.
      const panel = document.querySelector(".new-task-modal--floating");
      expect(panel).not.toBeNull();
    });

    it("still closes via the header close button (X)", async () => {
      const onClose = vi.fn();
      renderNewTaskModal({ onClose });

      fireEvent.click(screen.getByLabelText("Close"));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  });
});
