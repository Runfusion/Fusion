import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { NewTaskModal } from "../NewTaskModal";
import type { Task, Column } from "@fusion/core";
import { apiFetchGitHubIssues, apiFetchGitHubPulls, checkDuplicateTasks, fetchBoardWorkflows, fetchGitRemotes, fetchWorkflows, type BoardWorkflowsPayload } from "../../api";
import { __test_clearCache as clearSetupReadinessCache } from "../../hooks/useSetupReadiness";

/*
FNXC:NewTaskWorkflowStart 2026-09-15-09:12:
FN-411 symptom: in the New Task dialog Cmd/Ctrl+Enter did nothing at all — no keyboard path submitted the form,
so an operator had to reach for the Create/Start buttons. Both NewTaskModal presentations (the desktop floating
window and the mobile portal overlay) render the same TaskForm description field, so these cases drive the real
field on both breakpoints, with both modifier keys, across the atomic Start column path, the create-then-move
promotion path, the empty-description guard, and the create-only fallback for a Start-ineligible workflow.
*/

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
  Paperclip: () => null,
  ArrowDown: () => null,
  ArrowUp: () => null,
  Flag: () => <svg />,
  TriangleAlert: () => null,
  Zap: () => <svg />,
  UserCheck: () => <svg />,
  Lock: () => <svg />,
  ShieldCheck: () => null,
  Brain: () => null,
  Server: () => null,
  Cpu: () => null,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

vi.mock("../../api", () => ({
  uploadAttachment: vi.fn().mockResolvedValue({}),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchGitRemotes: vi.fn().mockResolvedValue([]),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "builtin:coding", workflows: [], taskWorkflowIds: {} }),
  apiFetchGitHubIssues: vi.fn().mockResolvedValue([]),
  apiFetchGitHubPulls: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [] }),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
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

let mockViewportMode: "mobile" | "tablet" | "desktop" = "mobile";
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => mockViewportMode,
  isMobileViewport: () => mockViewportMode === "mobile",
  isTabletTouchViewport: () => mockViewportMode === "tablet",
  useViewportMode: () => mockViewportMode,
}));

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column: "todo" as Column,
    steps: [],
    currentStep: 0,
    dependencies: [],
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const CODING_IDEAS_PAYLOAD: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{
    id: "builtin:coding-ideas",
    name: "Coding (Ideas)",
    columns: [
      { id: "ideas", name: "Ideas", flags: { intake: true, hold: true, manualIntake: true } },
      { id: "todo", name: "Todo", flags: {} },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  }],
  taskWorkflowIds: {},
};

const MANUAL_INTAKE_PAYLOAD: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{
    id: "WF-MANUAL",
    name: "Manual intake",
    columns: [
      { id: "waiting", name: "Waiting", flags: { intake: true, manualIntake: true } },
      { id: "building", name: "Building", flags: {} },
    ],
  }],
  taskWorkflowIds: {},
};

const INELIGIBLE_PAYLOAD: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{
    id: "builtin:coding",
    name: "Coding",
    columns: [
      { id: "planning", name: "Planning", flags: { intake: true, hold: true } },
      { id: "todo", name: "Todo", flags: {} },
    ],
  }],
  taskWorkflowIds: {},
};

function mockWorkflowPickerEntry(id: string, name: string) {
  vi.mocked(fetchWorkflows).mockResolvedValueOnce([{
    id,
    name,
    description: "",
    kind: "workflow",
    ir: { version: "v1", name, nodes: [], edges: [] },
    layout: {},
    createdAt: "",
    updatedAt: "",
  }] as never);
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

async function chooseWorkflowOption(value: string) {
  const trigger = await screen.findByTestId("task-workflow-dropdown-trigger");
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId(`task-workflow-option-${value}`));
}

function describeField() {
  return screen.getByPlaceholderText("What needs to be done?");
}

function pressAccelerator(modifier: "ctrlKey" | "metaKey") {
  fireEvent.keyDown(describeField(), { key: "Enter", [modifier]: true });
}

describe("NewTaskModal Cmd/Ctrl+Enter create-and-start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSetupReadinessCache();
    mockViewportMode = "mobile";
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    vi.mocked(checkDuplicateTasks).mockResolvedValue([]);
    vi.mocked(fetchGitRemotes).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubIssues).mockResolvedValue([]);
    vi.mocked(apiFetchGitHubPulls).mockResolvedValue([]);
    window.localStorage.clear();
    mockUseMobileKeyboard.mockReturnValue({ keyboardOpen: false, keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 });
  });

  it.each([
    ["desktop floating window", "desktop" as const, "ctrlKey" as const],
    ["desktop floating window", "desktop" as const, "metaKey" as const],
    ["mobile portal overlay", "mobile" as const, "ctrlKey" as const],
    ["mobile portal overlay", "mobile" as const, "metaKey" as const],
  ])("creates and starts in the proven Start column from the %s (%s)", async (_label, viewportMode, modifier) => {
    mockViewportMode = viewportMode;
    mockWorkflowPickerEntry("builtin:coding-ideas", "Coding (Ideas)");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce(CODING_IDEAS_PAYLOAD);
    const onCreateTask = vi.fn().mockResolvedValue({ ...makeTask("FN-START"), column: "todo", workflowId: "builtin:coding-ideas" });
    renderNewTaskModal({ onCreateTask });

    await chooseWorkflowOption("builtin:coding-ideas");
    fireEvent.change(describeField(), { target: { value: "Start this idea" } });
    await screen.findByTestId("task-form-inline-start");
    if (viewportMode === "mobile") expect(screen.getByTestId("new-task-modal-overlay")).toBeInTheDocument();

    pressAccelerator(modifier);

    await waitFor(() => expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "builtin:coding-ideas",
      column: "todo",
      description: "Start this idea",
    })));
  });

  it("promotes a manual-intake workflow with a follow-up move", async () => {
    mockWorkflowPickerEntry("WF-MANUAL", "Manual intake");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce(MANUAL_INTAKE_PAYLOAD);
    const onCreateTask = vi.fn().mockResolvedValue({ ...makeTask("FN-CUSTOM"), column: "waiting", workflowId: "WF-MANUAL" });
    const onMoveTask = vi.fn().mockResolvedValue({ ...makeTask("FN-CUSTOM"), column: "building", workflowId: "WF-MANUAL" });
    renderNewTaskModal({ onCreateTask, onMoveTask });

    await chooseWorkflowOption("WF-MANUAL");
    fireEvent.change(describeField(), { target: { value: "Start custom intake" } });
    await screen.findByTestId("task-form-inline-start");

    pressAccelerator("ctrlKey");

    await waitFor(() => expect(onMoveTask).toHaveBeenCalledWith("FN-CUSTOM", "building"));
    expect(onCreateTask).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "WF-MANUAL" }));
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("never creates or starts for a %s description", async (_label, value) => {
    mockWorkflowPickerEntry("builtin:coding-ideas", "Coding (Ideas)");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce(CODING_IDEAS_PAYLOAD);
    const onCreateTask = vi.fn().mockResolvedValue(makeTask("FN-NONE"));
    const onMoveTask = vi.fn();
    renderNewTaskModal({ onCreateTask, onMoveTask });

    await chooseWorkflowOption("builtin:coding-ideas");
    if (value) fireEvent.change(describeField(), { target: { value } });
    await screen.findByTestId("task-form-inline-start");

    pressAccelerator("ctrlKey");
    pressAccelerator("metaKey");
    await Promise.resolve();

    expect(onCreateTask).not.toHaveBeenCalled();
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("falls back to create-only when the workflow exposes no Start", async () => {
    mockWorkflowPickerEntry("builtin:coding", "Coding");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce(INELIGIBLE_PAYLOAD);
    const onCreateTask = vi.fn().mockResolvedValue(makeTask("FN-PLAIN"));
    const onMoveTask = vi.fn();
    renderNewTaskModal({ onCreateTask, onMoveTask });

    await chooseWorkflowOption("builtin:coding");
    fireEvent.change(describeField(), { target: { value: "Create only" } });
    await waitFor(() => expect(screen.queryByTestId("task-form-inline-start")).toBeNull());

    pressAccelerator("metaKey");

    await waitFor(() => expect(onCreateTask).toHaveBeenCalledTimes(1));
    expect(onCreateTask.mock.calls[0]![0]).not.toHaveProperty("column");
    expect(onMoveTask).not.toHaveBeenCalled();
  });

  it("leaves plain Enter and Shift+Cmd/Ctrl+Enter as ordinary newlines", async () => {
    mockWorkflowPickerEntry("builtin:coding-ideas", "Coding (Ideas)");
    vi.mocked(fetchBoardWorkflows).mockResolvedValueOnce(CODING_IDEAS_PAYLOAD);
    const onCreateTask = vi.fn().mockResolvedValue(makeTask("FN-NEWLINE"));
    renderNewTaskModal({ onCreateTask });

    await chooseWorkflowOption("builtin:coding-ideas");
    fireEvent.change(describeField(), { target: { value: "Multi line" } });
    await screen.findByTestId("task-form-inline-start");

    fireEvent.keyDown(describeField(), { key: "Enter" });
    fireEvent.keyDown(describeField(), { key: "Enter", shiftKey: true, ctrlKey: true });
    await Promise.resolve();

    expect(onCreateTask).not.toHaveBeenCalled();
    expect(describeField()).toHaveValue("Multi line");
  });
});
