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

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => "mobile",
  isMobileViewport: () => true,
  useViewportMode: () => "mobile",
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

    const { container } = renderNewTaskModal();
    const modal = container.querySelector(".new-task-modal");

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
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Subtask" })).toBeNull();
    expect(screen.queryByTestId("task-form-description-actions")).toBeNull();

    // Dependencies and agent are in quick-fields — visible by default (no toggle needed)
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

    await waitFor(() => {
      expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
      expect(screen.getByText(/Attachments/i)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows More options toggle and reveals advanced fields when clicked", async () => {
    renderNewTaskModal();

    const toggle = screen.getByTestId("task-form-more-options-toggle");
    const moreOptions = screen.getByTestId("task-form-more-options");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(moreOptions).toHaveAttribute("hidden");
    // Dependencies are now in quick-fields (visible by default), so the dep-trigger is present
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(moreOptions).not.toHaveAttribute("hidden");
    });
    // Model Configuration, Attachments, and the Workflow picker are revealed
    expect(screen.getByText(/Model Configuration/i)).toBeTruthy();
    expect(screen.getByText(/Attachments/i)).toBeTruthy();
    expect(screen.getByText("Workflow")).toBeTruthy();
  });

  it("shows dependencies and agent picker by default without expanding More options", () => {
    renderNewTaskModal();

    // Both dep-trigger and agent button should be visible by default
    expect(screen.getByTestId("dep-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("new-task-agent-button")).toBeInTheDocument();
    // More options should be collapsed
    expect(screen.getByTestId("task-form-more-options-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("renders dependencies before attachments in form order (quick-fields before More options)", () => {
    renderNewTaskModal();

    const dependenciesLabel = screen.getByText("Dependencies");
    // Attachments is inside the collapsed "More options" section, so we need to expand first
    const toggle = screen.getByTestId("task-form-more-options-toggle");
    fireEvent.click(toggle);

    const attachmentsLabel = screen.getByText("Attachments");

    // Dependencies (in quick-fields) appears before Attachments (in More options)
    expect(
      dependenciesLabel.compareDocumentPosition(attachmentsLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("focuses description textarea when modal opens", async () => {
    renderNewTaskModal();
    
    const textarea = screen.getByRole('textbox');
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("seeds the description when opened with an initial description", () => {
    renderNewTaskModal({ initialDescription: "File: README.md\n\nComment:\nFollow up" });

    expect(screen.getByRole("textbox")).toHaveValue("File: README.md\n\nComment:\nFollow up");
    expect(screen.getByRole("button", { name: "Create Task" })).not.toBeDisabled();
  });

  it("does not clobber user edits when initialDescription changes while open", () => {
    const { rerender, props } = renderNewTaskModal({ initialDescription: "Seeded description" });
    const descTextarea = screen.getByRole("textbox");

    fireEvent.change(descTextarea, { target: { value: "User edited text" } });
    rerender(<NewTaskModal {...props} initialDescription="Different seed" />);

    expect(screen.getByRole("textbox")).toHaveValue("User edited text");
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
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "custom-new" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits custom-new branch selection when branch name exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with custom new" } });
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
    fireEvent.change(screen.getByLabelText("Branch strategy"), { target: { value: "shared-group" } });

    expect(screen.getByRole("button", { name: "Create Task" })).toBeDisabled();
    expect(screen.getByText("Branch name is required for this branch strategy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    expect(props.onCreateTask).not.toHaveBeenCalled();
  });

  it("submits shared-group branch selection when shared branch exists", async () => {
    const { props } = renderNewTaskModal();

    fireEvent.change(screen.getByPlaceholderText("What needs to be done?"), { target: { value: "Task with shared group" } });
    fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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

    const descTextarea = screen.getByRole("textbox");
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
    
    const descTextarea = screen.getByRole('textbox');
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
    
    const descTextarea = screen.getByRole('textbox');
    fireEvent.change(descTextarea, { target: { value: "Test description" } });
    
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    
    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Created FN-042", "success");
    });
  });

  it("confirms before closing with dirty state", async () => {
    const { props } = renderNewTaskModal();

    const descTextarea = screen.getByRole('textbox');
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

  it("calls onCreateTask when form is submitted", async () => {
    const { props } = renderNewTaskModal();

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
      } as any);

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
      } as any);

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

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Inherit default" } });
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
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Pick a workflow" } });
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
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "No workflow task" } });
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

      const descTextarea = screen.getByRole('textbox');
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
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

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
      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

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

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Task default auto-merge" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledWith(
          expect.not.objectContaining({ autoMerge: expect.anything() }),
        );
      });
    });

    it("includes autoMerge true when Enabled is selected", async () => {
      const { props } = renderNewTaskModal();

      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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

      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Task with default priority" } });
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

      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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

      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));
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
        { id: "agent-1", name: "Executor Bot", role: "executor", state: "active" as const, metadata: {}, createdAt: "", updatedAt: "" },
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

  describe("GitHub tracking", () => {
    it("renders GitHub tracking after the Workflow picker in more options", async () => {
      renderNewTaskModal();

      fireEvent.click(screen.getByTestId("task-form-more-options-toggle"));

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
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Task with tracking" } });

      const toggle = await screen.findByLabelText("Enable GitHub issue tracking for this task");
      fireEvent.click(toggle);

      fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), { target: { value: "acme/repo" } });
      fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

      await waitFor(() => {
        expect(props.onCreateTask).toHaveBeenCalledTimes(1);
      });
    });
  });
});
