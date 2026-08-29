import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WorkflowResultsTab } from "../WorkflowResultsTab";
import * as api from "../../api";
import { useAgentLogs } from "../../hooks/useAgentLogs";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import type { Agent, AgentLogEntry, Settings, Task, WorkflowDefinition, WorkflowStep, WorkflowStepResult } from "@fusion/core";
import { resolveEffectiveExecutor, resolveEffectivePlanning, resolveEffectiveValidator } from "../effective-model-resolution";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ nodes = [], edges = [] }: { nodes?: unknown[]; edges?: unknown[] }) => (
    <div data-testid="react-flow-mock">nodes:{nodes.length};edges:{edges.length}</div>
  ),
  ReactFlowProvider: ({ children }: { children: unknown }) => <>{children}</>,
  Handle: () => <span data-testid="react-flow-handle" />,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(),
}));

const mockedFetchWorkflowSteps = vi.spyOn(api, "fetchWorkflowSteps");
const mockedFetchTaskWorkflow = vi.spyOn(api, "fetchTaskWorkflow");
const mockedFetchWorkflow = vi.spyOn(api, "fetchWorkflow");
const mockedFetchWorkflows = vi.spyOn(api, "fetchWorkflows");
const mockedFetchBoardWorkflows = vi.spyOn(api, "fetchBoardWorkflows");
const mockedFetchWorkflowOptionalSteps = vi.spyOn(api, "fetchWorkflowOptionalSteps");
const mockedSelectTaskWorkflow = vi.spyOn(api, "selectTaskWorkflow");
const mockedSubmitTaskWorkflowInput = vi.spyOn(api, "submitTaskWorkflowInput");
const mockedApproveTaskWorkflowCli = vi.spyOn(api, "approveTaskWorkflowCli");
const mockedUseAgentLogs = vi.mocked(useAgentLogs);

function mockWorkflowLiveLogGeometry(container: HTMLDivElement, initialScrollTop = 0) {
  let scrollTop = initialScrollTop;
  let scrollHeight = 1000;
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Number(value); },
    },
  });
  return {
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = value; },
    get scrollHeight() { return scrollHeight; },
    set scrollHeight(value: number) { scrollHeight = value; },
  };
}

function mockWorkflowViewport(isMobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: isMobile ? 375 : 1280 });
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: isMobile && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe("WorkflowResultsTab", () => {
  const mockWorkflowSteps: WorkflowStep[] = [
    {
      id: "WS-101",
      name: "QA Check",
      description: "Run test suite",
      mode: "prompt",
      phase: "pre-merge",
      prompt: "Run QA checks",
      enabled: true,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: "WS-102",
      name: "Docs Review",
      description: "Review docs",
      mode: "prompt",
      phase: "post-merge",
      prompt: "Review docs",
      enabled: true,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: "WS-103",
      name: "Browser Verification",
      description: "Verify web application functionality using browser automation",
      mode: "prompt",
      phase: "pre-merge",
      prompt: "Verify browser flows",
      enabled: true,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
      templateId: "browser-verification",
    },
  ];

  const defaultWorkflow: WorkflowDefinition = {
    id: "builtin:coding",
    name: "Built-in Coding Workflow",
    description: "Default workflow",
    ir: {
      version: 1,
      nodes: [
        { id: "start", kind: "start", config: {} },
        { id: "execute", kind: "prompt", config: { name: "Execute task" } },
        { id: "end", kind: "end", config: {} },
      ],
      edges: [
        { from: "start", to: "execute" },
        { from: "execute", to: "end" },
      ],
    },
  } as WorkflowDefinition;

  const selectedWorkflow: WorkflowDefinition = {
    id: "WF-001",
    name: "Custom Delivery Workflow",
    description: "Custom workflow",
    ir: {
      version: 1,
      nodes: [
        { id: "start", kind: "start", config: {} },
        { id: "prompt-1", kind: "prompt", config: { name: "Run checks" } },
        { id: "end", kind: "end", config: {} },
      ],
      edges: [
        { from: "start", to: "prompt-1" },
        { from: "prompt-1", to: "end" },
      ],
    },
  } as WorkflowDefinition;

  const baseTask: Task = {
    id: "FN-001",
    title: "Task",
    status: "todo",
    column: "todo",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    modelProvider: "openai",
    modelId: "gpt-4.1",
    validatorModelProvider: "anthropic",
    validatorModelId: "claude-3-7-sonnet",
    planningModelProvider: "google",
    planningModelId: "gemini-2.5-pro",
    thinkingLevel: "high",
    dependencies: [],
    outputBranch: null,
    prompt: "",
    baseBranch: null,
    assignee: null,
    labels: [],
    priority: "normal",
    autoMerge: false,
    autoMergeMode: "squash",
    paused: false,
    userPaused: false,
  } as Task;

  const mockSettings: Settings = {
    modelProvider: "openai",
    model: "gpt-4.1-mini",
    validatorModelProvider: "anthropic",
    validatorModel: "claude-3-5-haiku",
    planningModelProvider: "google",
    planningModel: "gemini-2.5-flash",
  } as Settings;

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockedFetchWorkflowSteps.mockReset();
    mockedFetchWorkflowSteps.mockResolvedValue(mockWorkflowSteps);
    mockedFetchTaskWorkflow.mockReset();
    mockedFetchTaskWorkflow.mockResolvedValue({ workflowId: "WF-001" });
    mockedFetchWorkflow.mockReset();
    mockedFetchWorkflow.mockImplementation((workflowId) => Promise.resolve(workflowId === "builtin:coding" ? defaultWorkflow : selectedWorkflow));
    mockedFetchWorkflows.mockReset();
    mockedFetchWorkflows.mockResolvedValue([defaultWorkflow, selectedWorkflow]);
    mockedFetchBoardWorkflows.mockReset();
    mockedFetchBoardWorkflows.mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Built-in Coding Workflow", columns: [] },
        { id: "WF-001", name: "Custom Delivery Workflow", columns: [] },
      ],
      taskWorkflowIds: {},
    });
    mockedFetchWorkflowOptionalSteps.mockReset();
    mockedFetchWorkflowOptionalSteps.mockResolvedValue([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "Verify browser flows",
        icon: "globe",
        phase: "pre-merge",
        defaultOn: false,
      },
    ]);
    mockedSelectTaskWorkflow.mockReset();
    mockedSelectTaskWorkflow.mockResolvedValue({ workflowId: "WF-001", enabledWorkflowSteps: [] });
    mockedSubmitTaskWorkflowInput.mockReset();
    mockedSubmitTaskWorkflowInput.mockResolvedValue({ ok: true });
    mockedApproveTaskWorkflowCli.mockReset();
    mockedApproveTaskWorkflowCli.mockResolvedValue({ approved: "ok" });
    mockedUseAgentLogs.mockReset();
    mockedUseAgentLogs.mockReturnValue({
      entries: [],
      loading: false,
      clear: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
      total: 0,
      loadingMore: false,
    });
  });

  const mockResults: WorkflowStepResult[] = [
    {
      workflowStepId: "WS-001",
      workflowStepName: "QA Check",
      phase: "pre-merge",
      status: "passed",
      output: "All tests passed successfully.",
      startedAt: "2026-03-31T10:00:00Z",
      completedAt: "2026-03-31T10:02:30Z",
    },
    {
      workflowStepId: "WS-002",
      workflowStepName: "Security Audit",
      phase: "pre-merge",
      status: "failed",
      output: "Found 2 security issues in auth.ts",
      startedAt: "2026-03-31T10:02:35Z",
      completedAt: "2026-03-31T10:03:15Z",
    },
    {
      workflowStepId: "WS-003",
      workflowStepName: "Documentation Review",
      phase: "post-merge",
      status: "skipped",
      output: undefined,
      startedAt: undefined,
      completedAt: undefined,
    },
    {
      workflowStepId: "WS-004",
      workflowStepName: "Performance Check",
      phase: "post-merge",
      status: "pending",
      output: undefined,
      startedAt: "2026-03-31T10:03:20Z",
      completedAt: undefined,
    },
  ];

  it("renders list of workflow step results", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} task={baseTask} settings={mockSettings} />);

    expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
    expect(screen.getByText("QA Check")).toBeInTheDocument();
    expect(screen.getByText("Security Audit")).toBeInTheDocument();
    expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    expect(screen.getByText("Performance Check")).toBeInTheDocument();
  });

  it("renders workflow state summary with workflow name and aggregate result", async () => {
    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Custom Delivery Workflow"));
    expect(screen.getByTestId("workflow-aggregate-badge-failed")).toHaveTextContent("Failed");
    expect(screen.getByTestId("workflow-state-summary-count")).toHaveTextContent("3 of 4 steps completed");
  });

  it.each([
    { name: "not started", task: { ...baseTask, status: "todo", column: "todo" } as Task, results: [] as WorkflowStepResult[], testId: "workflow-phase-badge-not-started", text: "Not started" },
    { name: "in progress", task: { ...baseTask, status: "in-progress", column: "in-progress" } as Task, results: [{ workflowStepId: "WS-004", workflowStepName: "Performance Check", phase: "pre-merge", status: "pending" }] as WorkflowStepResult[], testId: "workflow-phase-badge-pre-merge", text: "Pre-merge steps running" },
    { name: "paused", task: { ...baseTask, status: "paused", column: "in-progress" } as Task, results: [] as WorkflowStepResult[], testId: "workflow-phase-badge-paused", text: "Paused" },
    { name: "completed", task: { ...baseTask, status: "done", column: "done" } as Task, results: [{ workflowStepId: "WS-001", workflowStepName: "QA Check", phase: "pre-merge", status: "passed" }] as WorkflowStepResult[], testId: "workflow-phase-badge-completed", text: "Completed" },
  ])("shows correct workflow phase for $name", async ({ task, results, testId, text }) => {
    render(<WorkflowResultsTab taskId="FN-001" task={task} settings={mockSettings} results={results} taskStatus={task.status} />);
    await waitFor(() => expect(screen.getByTestId(testId)).toHaveTextContent(text));
  });

  it("uses failed aggregate priority over advisory", async () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={baseTask}
        settings={mockSettings}
        results={[
          { workflowStepId: "WS-001", workflowStepName: "QA Check", phase: "pre-merge", status: "advisory_failure" },
          { workflowStepId: "WS-002", workflowStepName: "Security Audit", phase: "pre-merge", status: "failed" },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("workflow-aggregate-badge-failed")).toBeInTheDocument());
    expect(screen.queryByTestId("workflow-aggregate-badge-advisory")).not.toBeInTheDocument();
  });

  it("keeps the graph collapsed by default and lazily fetches on expand", async () => {
    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} />);

    expect(screen.queryByTestId("react-flow-mock")).not.toBeInTheDocument();
    expect(mockedFetchWorkflow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("WF-001", undefined));
    expect(await screen.findByTestId("react-flow-mock")).toBeInTheDocument();
  });

  it("resolves a null task workflow selection through the board default and loads its graph", async () => {
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: null });

    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-default" />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Built-in Coding Workflow"));
    expect(screen.queryByText("No workflow assigned")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("builtin:coding", "project-default"));
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();
    expect(screen.getByTestId("react-flow-mock")).toHaveTextContent("nodes:");
  });

  it("keeps an explicit custom workflow ahead of the board default", async () => {
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: "WF-001" });

    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-custom" />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Custom Delivery Workflow"));

    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("WF-001", "project-custom"));
    expect(mockedFetchWorkflow).not.toHaveBeenCalledWith("builtin:coding", "project-custom");
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();
  });

  it("recomputes inherited workflow details after switching from an explicit task while selection fetch fails", async () => {
    mockedFetchTaskWorkflow
      .mockResolvedValueOnce({ workflowId: "WF-001" })
      .mockRejectedValueOnce(new Error("task workflow unavailable"));

    const { rerender } = render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={{ ...baseTask, id: "FN-001" }}
        settings={mockSettings}
        results={[]}
        enabledWorkflowSteps={["browser-verification"]}
        projectId="project-switch"
      />,
    );

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Custom Delivery Workflow"));

    rerender(
      <WorkflowResultsTab
        taskId="FN-002"
        task={{ ...baseTask, id: "FN-002" }}
        settings={mockSettings}
        results={[]}
        enabledWorkflowSteps={["browser-verification"]}
        projectId="project-switch"
      />,
    );

    await waitFor(() => expect(mockedFetchTaskWorkflow).toHaveBeenCalledWith("FN-002", "project-switch"));
    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Built-in Coding Workflow"));
    await waitFor(() => expect(screen.getByTestId("workflow-configured-step-browser-verification")).toHaveTextContent("Browser Verification"));
    expect(screen.getByTestId("workflow-configured-step-browser-verification")).not.toHaveTextContent("Step definition not found.");

    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("builtin:coding", "project-switch"));
    expect(mockedFetchWorkflow).not.toHaveBeenCalledWith("WF-001", "project-switch");
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();
  });

  it("returns to the effective default workflow when an explicit selection is cleared", async () => {
    mockedSelectTaskWorkflow.mockResolvedValueOnce({ workflowId: null, enabledWorkflowSteps: [] });

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={baseTask}
        settings={mockSettings}
        results={mockResults}
        canEdit
        projectId="project-cleared"
      />,
    );

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Custom Delivery Workflow"));
    fireEvent.change(await screen.findByLabelText("Custom workflow"), { target: { value: "" } });

    await waitFor(() => expect(mockedSelectTaskWorkflow).toHaveBeenCalledWith("FN-001", null, "project-cleared"));
    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Built-in Coding Workflow"));

    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("builtin:coding", "project-cleared"));
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();
  });

  it("shows graph unavailable without crashing for an unknown stale workflow id", async () => {
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: "WF-STALE" });
    mockedFetchWorkflows.mockResolvedValueOnce([defaultWorkflow, selectedWorkflow]);
    mockedFetchWorkflow.mockImplementation((workflowId) => {
      if (workflowId === "WF-STALE") return Promise.reject(new Error("missing workflow"));
      return Promise.resolve(workflowId === "builtin:coding" ? defaultWorkflow : selectedWorkflow);
    });

    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-stale" />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Custom workflow"));
    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("WF-STALE", "project-stale"));
    expect(await screen.findByTestId("workflow-graph-unavailable")).toHaveTextContent("Workflow graph unavailable");
    expect(screen.queryByTestId("workflow-graph-preview")).not.toBeInTheDocument();
  });

  it("shows graph unavailable when a fetched workflow has no mappable nodes", async () => {
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: "WF-EMPTY" });
    mockedFetchWorkflows.mockResolvedValue([{ id: "WF-EMPTY", name: "Empty Workflow", ir: { version: 1, nodes: [], edges: [] } } as WorkflowDefinition]);
    mockedFetchWorkflow.mockResolvedValueOnce({ id: "WF-EMPTY", name: "Empty Workflow", ir: { version: 1, nodes: [], edges: [] } } as WorkflowDefinition);

    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-empty" />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Empty Workflow"));
    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("WF-EMPTY", "project-empty"));
    expect(await screen.findByTestId("workflow-graph-unavailable")).toHaveTextContent("Workflow graph unavailable");
    expect(screen.queryByTestId("workflow-graph-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-graph-loading")).not.toBeInTheDocument();
  });

  it("keys graph cache by project and effective workflow id", async () => {
    mockedFetchTaskWorkflow.mockResolvedValue({ workflowId: null });
    const { rerender } = render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-a" />);

    await waitFor(() => expect(screen.getByTestId("workflow-state-summary-name")).toHaveTextContent("Built-in Coding Workflow"));
    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));
    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("builtin:coding", "project-a"));
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();

    rerender(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} projectId="project-b" />);

    await waitFor(() => expect(mockedFetchWorkflow).toHaveBeenCalledWith("builtin:coding", "project-b"));
    expect(await screen.findByTestId("workflow-graph-preview")).toBeInTheDocument();
  });

  it("shows no workflow assigned and avoids graph fetch when board workflows provide no usable effective id", async () => {
    mockedFetchWorkflows.mockResolvedValueOnce([]);
    mockedFetchBoardWorkflows.mockResolvedValueOnce({
      flagEnabled: false,
      defaultWorkflowId: "",
      workflows: [],
      taskWorkflowIds: {},
    });
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: null });

    render(<WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} />);
    fireEvent.click(screen.getByTestId("workflow-graph-toggle"));

    expect(await screen.findByTestId("workflow-graph-empty")).toHaveTextContent("No workflow assigned");
    expect(mockedFetchWorkflow).not.toHaveBeenCalled();
  });

  it("shows edit workflow affordance only when editable and workflow selected", async () => {
    const onEditWorkflow = vi.fn();
    const { rerender } = render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={baseTask}
        settings={mockSettings}
        results={mockResults}
        canEdit={false}
        onWorkflowStepsChange={vi.fn()}
        onEditWorkflow={onEditWorkflow}
      />,
    );

    expect(screen.queryByTestId("workflow-edit-button")).not.toBeInTheDocument();

    rerender(
      <WorkflowResultsTab
        taskId="FN-001"
        task={baseTask}
        settings={mockSettings}
        results={mockResults}
        canEdit
        onWorkflowStepsChange={vi.fn()}
        onEditWorkflow={onEditWorkflow}
      />,
    );

    const button = await screen.findByTestId("workflow-edit-button");
    fireEvent.click(button);
    expect(onEditWorkflow).toHaveBeenCalledTimes(1);
  });

  it("calls onWorkflowReconciled for preserved-column workflow switches", async () => {
    const onWorkflowReconciled = vi.fn();
    const onWorkflowStepsChange = vi.fn();
    const destinationWorkflow = { ...selectedWorkflow, id: "WF-002", name: "Preserved Column Workflow" };
    mockedFetchWorkflows.mockResolvedValueOnce([selectedWorkflow, destinationWorkflow]);
    mockedSelectTaskWorkflow.mockResolvedValueOnce({
      workflowId: "WF-002",
      enabledWorkflowSteps: ["WS-101"],
      reconciliation: { preserved: true, fromColumn: "todo", toColumn: "todo" },
    });

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={baseTask}
        settings={mockSettings}
        results={mockResults}
        canEdit
        onWorkflowStepsChange={onWorkflowStepsChange}
        onWorkflowReconciled={onWorkflowReconciled}
      />,
    );

    const selector = await screen.findByLabelText("Custom workflow");
    fireEvent.change(selector, { target: { value: "WF-002" } });

    await waitFor(() => expect(mockedSelectTaskWorkflow).toHaveBeenCalledWith("FN-001", "WF-002", undefined));
    expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-101"]);
    expect(onWorkflowReconciled).toHaveBeenCalledTimes(1);
  });

  it("shows Workflow model settings that match the Chat effective model resolver for runtime markers", async () => {
    const activeTask = {
      ...baseTask,
      status: "executing",
      column: "in-progress",
      modelProvider: "configured-executor",
      modelId: "configured-executor-model",
      validatorModelProvider: "configured-reviewer",
      validatorModelId: "configured-reviewer-model",
      planningModelProvider: null,
      planningModelId: null,
    } as Task;
    const agentLogEntries: AgentLogEntry[] = [
      {
        timestamp: "2026-06-25T00:00:00Z",
        taskId: "FN-001",
        agent: "executor",
        type: "text",
        text: "Executor using model: runtime-executor/runtime-executor-model (thinking effort: high)",
      },
      {
        timestamp: "2026-06-25T00:00:01Z",
        taskId: "FN-001",
        agent: "reviewer",
        type: "text",
        text: "Reviewer using model: runtime-reviewer/runtime-reviewer-model (thinking effort: medium)",
      },
      {
        timestamp: "2026-06-25T00:00:02Z",
        taskId: "FN-001",
        agent: "triage",
        type: "text",
        text: "Planning using model: runtime-planning/runtime-planning-model (thinking effort: low)",
      },
    ];
    const assignedAgent = {
      id: "agent-runtime",
      name: "Runtime Agent",
      role: "executor",
      state: "running",
      createdAt: "2026-06-25T00:00:00Z",
      updatedAt: "2026-06-25T00:00:00Z",
      metadata: {},
      runtimeConfig: { model: "assigned-provider/assigned-model" },
    } as Agent;

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        task={activeTask}
        settings={mockSettings}
        results={mockResults}
        agentLogEntries={agentLogEntries}
        assignedAgent={assignedAgent}
      />,
    );

    await screen.findByTestId("workflow-state-summary-name");
    fireEvent.click(screen.getByTestId("workflow-model-settings-toggle"));

    const chatExecutor = resolveEffectiveExecutor(activeTask, agentLogEntries, assignedAgent, mockSettings);
    const chatReviewer = resolveEffectiveValidator(activeTask, agentLogEntries, assignedAgent, mockSettings);
    const chatPlanning = resolveEffectivePlanning(activeTask, agentLogEntries, mockSettings);

    await waitFor(() => expect(screen.getByTestId("workflow-model-setting-executor")).toHaveTextContent(`${chatExecutor.provider}/${chatExecutor.modelId}`));
    expect(screen.getByTestId("workflow-model-setting-reviewer")).toHaveTextContent(`${chatReviewer.provider}/${chatReviewer.modelId}`);
    expect(screen.getByTestId("workflow-model-setting-planning")).toHaveTextContent(`${chatPlanning.provider}/${chatPlanning.modelId}`);
    expect(screen.getByTestId("workflow-model-setting-executor")).not.toHaveTextContent("configured-executor/configured-executor-model");
    expect(screen.getByTestId("workflow-model-setting-reviewer")).not.toHaveTextContent("configured-reviewer/configured-reviewer-model");
  });

  it("shows workflow-overlaid project model lanes when the task has no explicit overrides", async () => {
    const taskWithoutOverrides = {
      ...baseTask,
      modelProvider: null,
      modelId: null,
      validatorModelProvider: null,
      validatorModelId: null,
      planningModelProvider: null,
      planningModelId: null,
    } as Task;
    const workflowOverlaidSettings = {
      ...mockSettings,
      executionProvider: "workflow-executor",
      executionModelId: "workflow-executor-model",
      validatorProvider: "workflow-reviewer",
      validatorModelId: "workflow-reviewer-model",
      planningProvider: "workflow-planner",
      planningModelId: "workflow-planner-model",
    } as Settings;

    render(<WorkflowResultsTab taskId="FN-001" task={taskWithoutOverrides} settings={workflowOverlaidSettings} results={mockResults} />);

    await screen.findByTestId("workflow-state-summary-name");
    fireEvent.click(screen.getByTestId("workflow-model-settings-toggle"));

    await waitFor(() => expect(screen.getByTestId("workflow-model-setting-executor")).toHaveTextContent("workflow-executor/workflow-executor-model"));
    expect(screen.getByTestId("workflow-model-setting-reviewer")).toHaveTextContent("workflow-reviewer/workflow-reviewer-model");
    expect(screen.getByTestId("workflow-model-setting-planning")).toHaveTextContent("workflow-planner/workflow-planner-model");
    expect(screen.getByTestId("workflow-model-setting-executor")).not.toHaveTextContent("Default");
    expect(screen.getByTestId("workflow-model-setting-reviewer")).not.toHaveTextContent("Default");
    expect(screen.getByTestId("workflow-model-setting-planning")).not.toHaveTextContent("Default");
  });

  it("shows effective model settings and default fallbacks", async () => {
    const { rerender } = render(
      <WorkflowResultsTab taskId="FN-001" task={baseTask} settings={mockSettings} results={mockResults} />,
    );

    await screen.findByTestId("workflow-state-summary-name");
    fireEvent.click(screen.getByTestId("workflow-model-settings-toggle"));
    await waitFor(() => expect(screen.getByTestId("workflow-model-setting-executor")).toHaveTextContent("openai/gpt-4.1"));
    expect(screen.getByTestId("workflow-model-setting-reviewer")).toHaveTextContent("anthropic/claude-3-7-sonnet");
    expect(screen.getByTestId("workflow-model-setting-planning")).toHaveTextContent("google/gemini-2.5-pro");
    expect(screen.getByTestId("workflow-model-setting-thinking")).toHaveTextContent("high");

    rerender(
      <WorkflowResultsTab
        taskId="FN-001"
        task={{ ...baseTask, modelProvider: null, modelId: null, validatorModelProvider: null, validatorModelId: null, planningModelProvider: null, planningModelId: null, thinkingLevel: null } as Task}
        settings={undefined}
        results={mockResults}
      />,
    );

    await screen.findByTestId("workflow-state-summary-name");
    if (!screen.queryByTestId("workflow-model-setting-executor")) {
      fireEvent.click(screen.getByTestId("workflow-model-settings-toggle"));
    }
    await waitFor(() => expect(screen.getByTestId("workflow-model-setting-executor")).toHaveTextContent("Default"));
    expect(screen.getByTestId("workflow-model-setting-reviewer")).toHaveTextContent("Default");
    expect(screen.getByTestId("workflow-model-setting-planning")).toHaveTextContent("Default");
    expect(screen.getByTestId("workflow-model-setting-thinking")).toHaveTextContent("Default");
  });

  it("renders correct status badges for each result", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Passed badge
    const passedBadge = screen.getByTestId("workflow-result-badge-WS-001");
    expect(passedBadge).toHaveTextContent("Passed");
    expect(passedBadge).toHaveClass("workflow-result-badge");
    expect(passedBadge).toHaveClass("workflow-result-badge--passed");

    // Failed badge
    const failedBadge = screen.getByTestId("workflow-result-badge-WS-002");
    expect(failedBadge).toHaveTextContent("Failed");
    expect(failedBadge).toHaveClass("workflow-result-badge");
    expect(failedBadge).toHaveClass("workflow-result-badge--failed");

    // Skipped badge
    const skippedBadge = screen.getByTestId("workflow-result-badge-WS-003");
    expect(skippedBadge).toHaveTextContent("Skipped");
    expect(skippedBadge).toHaveClass("workflow-result-badge");
    expect(skippedBadge).toHaveClass("workflow-result-badge--skipped");

    // Pending badge
    const pendingBadge = screen.getByTestId("workflow-result-badge-WS-004");
    expect(pendingBadge).toHaveTextContent("Running…");
    expect(pendingBadge).toHaveClass("workflow-result-badge");
    expect(pendingBadge).toHaveClass("workflow-result-badge--pending");
  });

  it("FN-4214: shows waiting placeholder when pending-step entries are all stale", () => {
    const historicalEntries: AgentLogEntry[] = [
      {
        timestamp: "2026-03-31T10:03:00Z",
        taskId: "FN-001",
        text: "Earlier workflow output",
        type: "text",
      },
    ];
    mockedUseAgentLogs.mockReturnValue({
      entries: historicalEntries,
      loading: false,
      clear: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
      total: historicalEntries.length,
      loadingMore: false,
    });

    render(
      <WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />,
    );

    const liveLogPanel = screen.getByTestId("workflow-live-log-WS-004");
    expect(within(liveLogPanel).getByText("Waiting for agent output…")).toBeInTheDocument();
    expect(screen.queryByText("Earlier workflow output")).not.toBeInTheDocument();
  });

  it("FN-4214: hides waiting placeholder when current-step log entries exist", () => {
    const currentStepEntries: AgentLogEntry[] = [
      {
        timestamp: "2026-03-31T10:03:25Z",
        taskId: "FN-001",
        text: "Current workflow output",
        type: "text",
      },
    ];
    mockedUseAgentLogs.mockReturnValue({
      entries: currentStepEntries,
      loading: false,
      clear: vi.fn(),
      loadMore: vi.fn(),
      hasMore: false,
      total: currentStepEntries.length,
      loadingMore: false,
    });

    render(
      <WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />,
    );

    const liveLogPanel = screen.getByTestId("workflow-live-log-WS-004");
    expect(within(liveLogPanel).queryByText("Waiting for agent output…")).not.toBeInTheDocument();
    expect(within(liveLogPanel).getByText("Current workflow output")).toBeInTheDocument();
  });

  describe("FN-8345: live workflow log scroll following", () => {
    const initialEntries: AgentLogEntry[] = [{
      timestamp: "2026-03-31T10:03:25Z", taskId: "FN-001", text: "Streaming output", type: "text",
    }];
    const appendedEntries: AgentLogEntry[] = [...initialEntries, {
      timestamp: "2026-03-31T10:03:26Z", taskId: "FN-001", text: "More streaming output", type: "text",
    }];

    function renderLiveLog(entries: AgentLogEntry[]) {
      mockedUseAgentLogs.mockReturnValue({ entries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: entries.length, loadingMore: false });
      return render(<WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />);
    }

    it.each([{ name: "desktop", isMobile: false }, { name: "mobile", isMobile: true }])("does not override an unsnapped $name reader during appended streaming growth", ({ isMobile }) => {
      mockWorkflowViewport(isMobile);
      const view = renderLiveLog(initialEntries);
      const container = screen.getByTestId("workflow-live-log-WS-004") as HTMLDivElement;
      const geometry = mockWorkflowLiveLogGeometry(container, 800);

      geometry.scrollTop = 200;
      fireEvent.scroll(container);
      geometry.scrollHeight = 1200;
      mockedUseAgentLogs.mockReturnValue({ entries: appendedEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: appendedEntries.length, loadingMore: false });
      view.rerender(<WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />);

      expect(geometry.scrollTop).toBe(200);
    });

    it("follows appended streaming growth while pinned at the bottom", () => {
      const view = renderLiveLog(initialEntries);
      const container = screen.getByTestId("workflow-live-log-WS-004") as HTMLDivElement;
      const geometry = mockWorkflowLiveLogGeometry(container, 800);

      fireEvent.scroll(container);
      geometry.scrollHeight = 1200;
      mockedUseAgentLogs.mockReturnValue({ entries: appendedEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: appendedEntries.length, loadingMore: false });
      view.rerender(<WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />);

      expect(geometry.scrollTop).toBe(1200);
    });

    it.each([{ name: "desktop", isMobile: false }, { name: "mobile", isMobile: true }])("re-pins and follows later streaming growth on $name", ({ isMobile }) => {
      mockWorkflowViewport(isMobile);
      const view = renderLiveLog(initialEntries);
      const container = screen.getByTestId("workflow-live-log-WS-004") as HTMLDivElement;
      const geometry = mockWorkflowLiveLogGeometry(container, 800);

      geometry.scrollTop = 200;
      fireEvent.scroll(container);
      geometry.scrollTop = 960;
      fireEvent.scroll(container);
      geometry.scrollHeight = 1200;
      mockedUseAgentLogs.mockReturnValue({ entries: appendedEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: appendedEntries.length, loadingMore: false });
      view.rerender(<WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />);

      expect(geometry.scrollTop).toBe(1200);
    });

    it("anchors to the bottom when the live log first becomes scrollable", () => {
      const proto = HTMLElement.prototype;
      const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
      const originalClientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
      const originalScrollTop = Object.getOwnPropertyDescriptor(proto, "scrollTop");
      let scrollTop = 0;
      try {
        Object.defineProperties(proto, {
          scrollHeight: { configurable: true, get(this: HTMLElement) { return this.classList.contains("workflow-live-log") ? 1000 : originalScrollHeight?.get?.call(this) ?? 0; } },
          clientHeight: { configurable: true, get(this: HTMLElement) { return this.classList.contains("workflow-live-log") ? 200 : originalClientHeight?.get?.call(this) ?? 0; } },
          scrollTop: {
            configurable: true,
            get(this: HTMLElement) { return this.classList.contains("workflow-live-log") ? scrollTop : originalScrollTop?.get?.call(this) ?? 0; },
            set(this: HTMLElement, value: number) {
              if (this.classList.contains("workflow-live-log")) scrollTop = Number(value);
              else originalScrollTop?.set?.call(this, value);
            },
          },
        });
        renderLiveLog(initialEntries);
        expect(scrollTop).toBe(1000);
      } finally {
        if (originalScrollHeight) Object.defineProperty(proto, "scrollHeight", originalScrollHeight);
        else Reflect.deleteProperty(proto, "scrollHeight");
        if (originalClientHeight) Object.defineProperty(proto, "clientHeight", originalClientHeight);
        else Reflect.deleteProperty(proto, "clientHeight");
        if (originalScrollTop) Object.defineProperty(proto, "scrollTop", originalScrollTop);
        else Reflect.deleteProperty(proto, "scrollTop");
      }
    });

    it("follows in-place streamed text growth through the content ResizeObserver", () => {
      let resizeCallback: ResizeObserverCallback | undefined;
      vi.stubGlobal("ResizeObserver", class {
        observe() {}
        disconnect() {}
        constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      });
      const view = renderLiveLog(initialEntries);
      const container = screen.getByTestId("workflow-live-log-WS-004") as HTMLDivElement;
      const geometry = mockWorkflowLiveLogGeometry(container, 800);
      fireEvent.scroll(container);
      geometry.scrollHeight = 1200;
      const expandedEntry = [{ ...initialEntries[0], text: "Streaming output that grew in place" }];
      mockedUseAgentLogs.mockReturnValue({ entries: expandedEntry, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: expandedEntry.length, loadingMore: false });
      view.rerender(<WorkflowResultsTab taskId="FN-001" results={mockResults} isTaskInProgress />);
      act(() => resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver));

      expect(geometry.scrollTop).toBe(1200);
    });
  });

  it("renders advisory findings under Polish notes and keeps failure counts non-blocking", () => {
    const advisoryResults: WorkflowStepResult[] = [
      {
        workflowStepId: "WS-006",
        workflowStepName: "Frontend UX Design",
        phase: "pre-merge",
        status: "advisory_failure",
        notes: "Polish spacing in `packages/dashboard/app/components/TaskCard.tsx`."
      },
      {
        workflowStepId: "WS-001",
        workflowStepName: "QA Check",
        phase: "pre-merge",
        status: "passed",
        output: "All tests passed",
      },
    ];

    render(<WorkflowResultsTab taskId="FN-001" results={advisoryResults} />);

    expect(screen.getByTestId("workflow-result-badge-WS-006")).toHaveTextContent("Advisory");
    expect(screen.getByTestId("workflow-result-badge-WS-006")).toHaveClass("workflow-result-badge--advisory_failure");

    const polishNotes = screen.getByTestId("workflow-polish-notes");
    expect(polishNotes).toHaveTextContent("Polish notes");
    expect(polishNotes).toHaveTextContent("non-blocking improvements");
    expect(polishNotes).toHaveTextContent("Frontend UX Design");

    const summary = screen.getByTestId("workflow-results-summary");
    expect(summary).toHaveTextContent("1 advisory");
    expect(summary).not.toHaveTextContent("failed");
  });

  it("shows output content when toggle is clicked to expand", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Output should be hidden by default (collapsed)
    expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

    // Click "Show output" for WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

    // Now output should be visible
    expect(screen.getByTestId("workflow-result-output-WS-001")).toHaveTextContent(
      "All tests passed successfully."
    );

    // WS-002 should still be collapsed
    expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();
  });

  it("hides output when toggle is clicked again", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Expand WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
    expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();

    // Toggle text should say "Hide output"
    expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Hide output");

    // Collapse WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

    // Output should be hidden again
    expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();

    // Toggle text should say "Show output"
    expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Show output");
  });

  it("handles results without output gracefully", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // WS-003 and WS-004 have no output, so output section elements should not be rendered
    expect(screen.queryByTestId("workflow-result-toggle-WS-003")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-toggle-WS-004")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-003")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-004")).not.toBeInTheDocument();
  });

  it("shows empty state when no workflow steps are configured", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([]);

    render(<WorkflowResultsTab taskId="FN-001" results={[]} />);

    expect(screen.getByTestId("workflow-results-empty")).toBeInTheDocument();
    expect(screen.getByText("No workflow steps configured for this task.")).toBeInTheDocument();
    await waitFor(() => expect(mockedFetchWorkflowOptionalSteps).toHaveBeenCalled());
    expect(screen.queryByTestId("workflow-configured-steps")).not.toBeInTheDocument();
  });

  it("shows default-on optional steps for in-progress tasks without any explicit workflow step selection", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        canEdit={false}
        isTaskInProgress
      />,
    );

    const configuredSteps = await screen.findByTestId("workflow-configured-steps");
    expect(configuredSteps).toBeInTheDocument();
    expect(screen.getByTestId("workflow-configured-step-browser-verification")).toHaveTextContent("Browser Verification");
    expect(screen.getByTestId("workflow-configured-count")).toHaveTextContent("1 step");
    expect(screen.queryByTestId("workflow-results-empty")).not.toBeInTheDocument();
  });

  it("does not show default-on optional steps when workflow selection explicitly has no enabled steps", async () => {
    mockedFetchTaskWorkflow.mockResolvedValueOnce({ workflowId: "builtin:coding", enabledWorkflowSteps: [] });
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "plan-review",
        name: "Plan Review",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
      {
        templateId: "code-review",
        name: "Code Review",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        canEdit={false}
        isTaskInProgress
      />,
    );

    await waitFor(() => expect(mockedFetchWorkflowOptionalSteps).toHaveBeenCalled());
    expect(screen.queryByTestId("workflow-configured-step-plan-review")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-configured-step-code-review")).not.toBeInTheDocument();
    expect(screen.getByTestId("workflow-results-empty")).toBeInTheDocument();
  });

  it("de-duplicates persisted optional steps that are also default-on", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["browser-verification"]}
      />,
    );

    await screen.findByTestId("workflow-configured-step-browser-verification");
    expect(screen.getByTestId("workflow-configured-count")).toHaveTextContent("1 step");
    expect(document.querySelectorAll('[data-testid="workflow-configured-step-browser-verification"]')).toHaveLength(1);
  });

  it("de-duplicates default-on optional steps when persisted ids use materialized workflow step aliases", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-103"]}
      />,
    );

    await screen.findByTestId("workflow-configured-step-WS-103");
    expect(screen.getByTestId("workflow-configured-count")).toHaveTextContent("1 step");
    expect(screen.getByTestId("workflow-configured-step-WS-103")).toHaveTextContent("Browser Verification");
    expect(document.querySelectorAll('[data-testid^="workflow-configured-step-"]')).toHaveLength(1);
  });

  it("keeps result rendering authoritative when default-on optional steps exist", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "browser-verification",
        name: "Browser Verification",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[{ workflowStepId: "browser-verification", workflowStepName: "Browser Verification", phase: "pre-merge", status: "pending" }]}
        enabledWorkflowSteps={[]}
        isTaskInProgress
      />,
    );

    expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-result-item-browser-verification")).toBeInTheDocument();
    await waitFor(() => expect(mockedFetchWorkflowOptionalSteps).toHaveBeenCalled());
    expect(screen.queryByTestId("workflow-configured-steps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-results-empty")).not.toBeInTheDocument();
  });

  it("shows configured step details when enabledWorkflowSteps is non-empty and results are empty", async () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-101", "WS-102"]}
      />,
    );

    expect(screen.getByTestId("workflow-configured-steps")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-configured-header")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-configured-count")).toHaveTextContent("2 steps");

    const qaStep = await screen.findByTestId("workflow-configured-step-WS-101");
    const docsStep = await screen.findByTestId("workflow-configured-step-WS-102");

    expect(qaStep).toHaveTextContent("QA Check");
    expect(qaStep).toHaveTextContent("Run test suite");
    expect(screen.getByTestId("workflow-configured-phase-WS-101")).toHaveTextContent("Pre-merge");

    expect(docsStep).toHaveTextContent("Docs Review");
    expect(docsStep).toHaveTextContent("Review docs");
    expect(screen.getByTestId("workflow-configured-phase-WS-102")).toHaveTextContent("Post-merge");

    expect(screen.getByText("Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.")).toBeInTheDocument();
  });

  it("shows found optional-group steps with empty descriptions without the missing-definition fallback", async () => {
    mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
      {
        templateId: "code-review",
        name: "Code Review",
        description: "",
        phase: "pre-merge",
        defaultOn: true,
      },
    ]);

    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        canEdit
        enabledWorkflowSteps={["WS-101", "code-review"]}
      />,
    );

    const configuredStep = await screen.findByTestId("workflow-configured-step-code-review");
    await waitFor(() => expect(configuredStep).toHaveTextContent("Code Review"));
    expect(screen.getByTestId("workflow-configured-phase-code-review")).toHaveTextContent("Pre-merge");
    expect(within(configuredStep).queryByText("Step definition not found.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));

    const checkboxStep = await screen.findByTestId("workflow-step-checkbox-code-review");
    expect(checkboxStep).toHaveTextContent("Code Review");
    expect(within(checkboxStep).queryByText("Step definition not found.")).not.toBeInTheDocument();

    const orderStep = screen.getByTestId("workflow-step-order-item-code-review");
    expect(orderStep).toHaveTextContent("Code Review");
    expect(within(orderStep).queryByText("Step definition not found.")).not.toBeInTheDocument();
  });

  it("falls back to step ID and default description when definition is missing", () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-unknown"]}
      />,
    );

    const fallbackStep = screen.getByTestId("workflow-configured-step-WS-unknown");
    expect(fallbackStep).toHaveTextContent("WS-unknown");
    expect(fallbackStep).toHaveTextContent("Step definition not found.");
    expect(screen.getByTestId("workflow-configured-phase-WS-unknown")).toHaveTextContent("Pre-merge");
  });

  it("shows loading state when loading prop is true", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={[]} loading={true} />);

    expect(screen.getByTestId("workflow-results-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading workflow results…")).toBeInTheDocument();
  });

  it("displays execution timestamps when available", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Check that timestamps are displayed for results that have them
    const timestamps = screen.getAllByText(/Started:/);
    expect(timestamps.length).toBeGreaterThanOrEqual(3); // 3 results have startedAt
  });

  it("displays duration when start and end times are available", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // The first result has a 2m 30s duration
    expect(screen.getByText("2m 30s")).toBeInTheDocument();
  });

  it("handles results with missing timestamps gracefully", () => {
    const resultsWithoutTimestamps: WorkflowStepResult[] = [
      {
        workflowStepId: "WS-005",
        workflowStepName: "Simple Check",
        phase: "pre-merge",
        status: "passed",
        output: "Done",
      },
    ];

    render(<WorkflowResultsTab taskId="FN-001" results={resultsWithoutTimestamps} />);

    expect(screen.getByText("Simple Check")).toBeInTheDocument();
    // Should not crash without timestamps
  });

  it("displays phase badges for each result", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Pre-merge results (WS-001, WS-002)
    expect(screen.getByTestId("workflow-result-phase-WS-001")).toHaveTextContent("Pre-merge");
    expect(screen.getByTestId("workflow-result-phase-WS-002")).toHaveTextContent("Pre-merge");

    // Post-merge results (WS-003, WS-004)
    expect(screen.getByTestId("workflow-result-phase-WS-003")).toHaveTextContent("Post-merge");
    expect(screen.getByTestId("workflow-result-phase-WS-004")).toHaveTextContent("Post-merge");
  });

  it("defaults to Pre-merge phase badge when phase is undefined", () => {
    const resultsWithoutPhase: WorkflowStepResult[] = [
      {
        workflowStepId: "WS-005",
        workflowStepName: "Legacy Check",
        status: "passed",
        output: "Done",
      },
    ];

    render(<WorkflowResultsTab taskId="FN-001" results={resultsWithoutPhase} />);

    expect(screen.getByTestId("workflow-result-phase-WS-005")).toHaveTextContent("Pre-merge");
  });

  describe("summary bar", () => {
    it("renders summary bar with correct counts", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toBeInTheDocument();
      expect(summary).toHaveTextContent("4 steps");
      expect(summary).toHaveTextContent("1 passed");
      expect(summary).toHaveTextContent("1 failed");
      expect(summary).toHaveTextContent("1 skipped");
      expect(summary).toHaveTextContent("1 running");
    });

    it("shows plural 'step' for single result", () => {
      const singleResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          output: "Done",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={singleResult} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toHaveTextContent("1 step");
      expect(summary).toHaveTextContent("1 passed");
      // Should not include "0 failed" etc. for zero-count categories
      expect(summary).not.toHaveTextContent("0 failed");
    });

    it("omits zero-count categories from summary", () => {
      const allPassed: WorkflowStepResult[] = [
        { workflowStepId: "WS-001", workflowStepName: "Check 1", status: "passed" },
        { workflowStepId: "WS-002", workflowStepName: "Check 2", status: "passed" },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={allPassed} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toHaveTextContent("2 steps");
      expect(summary).toHaveTextContent("2 passed");
      expect(summary).not.toHaveTextContent("failed");
      expect(summary).not.toHaveTextContent("skipped");
      expect(summary).not.toHaveTextContent("running");
    });
  });

  describe("collapsible output", () => {
    it("output sections default to collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Outputs should not be rendered in DOM by default
      expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

      // Toggles should say "Show output"
      expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Show output");
      expect(screen.getByTestId("workflow-result-toggle-WS-002")).toHaveTextContent("Show output");
    });

    it("shows preview hint when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Preview should show for results with output
      expect(screen.getByTestId("workflow-result-preview-WS-001")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-preview-WS-002")).toBeInTheDocument();
    });

    it("shows line count in preview for multi-line output", () => {
      const multiLineResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-010",
          workflowStepName: "Multi Line Check",
          status: "passed",
          output: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={multiLineResult} />);

      expect(screen.getByTestId("workflow-result-preview-WS-010")).toHaveTextContent("5 lines");
    });

    it("shows output text as preview for single-line output", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // WS-001 output is "All tests passed successfully." — single line
      expect(screen.getByTestId("workflow-result-preview-WS-001")).toHaveTextContent(
        "All tests passed successfully."
      );
    });

    it("expands and collapses independently per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();
      expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

      // Expand WS-002 as well
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));
      expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-output-WS-002")).toBeInTheDocument();

      // Collapse WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-output-WS-002")).toBeInTheDocument();
    });
  });

  describe("markdown rendering toggle", () => {
    it("shows markdown mode toggle button when output is expanded", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Mode toggle should be visible
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toBeInTheDocument();
    });

    it("defaults to markdown mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Mode toggle should show "Markdown" (current mode)
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
    });

    it("toggles between markdown and plain mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Should start in markdown mode
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");

      // Toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");

      // Toggle back to markdown mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
    });

    it("mode toggle is independent per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand both WS-001 and WS-002
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));

      // Both should default to markdown mode
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-002")).toHaveTextContent("Markdown");

      // Toggle WS-001 to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));

      // WS-001 should be plain, WS-002 should still be markdown
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-002")).toHaveTextContent("Markdown");
    });

    it("FN-4209: header wraps when preview content is long", () => {
      const longToken = "X".repeat(520);
      const longOutputResults: WorkflowStepResult[] = [
        {
          ...mockResults[0],
          output: `Preview ${longToken}`,
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={longOutputResults} />);

      const outputHeader = document.querySelector(".workflow-result-output-header");
      expect(outputHeader).not.toBeNull();
      if (!outputHeader) {
        return;
      }

      expect(getComputedStyle(outputHeader).flexWrap).toBe("wrap");

      const preview = outputHeader.querySelector(".workflow-result-output-preview");
      expect(preview).not.toBeNull();

      const outputToggle = screen.getByTestId("workflow-result-toggle-WS-001");
      expect(outputToggle).toBeInTheDocument();
    });

    it("does not show mode toggle when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Mode toggle should not be visible when collapsed
      expect(screen.queryByTestId("workflow-result-mode-toggle-WS-001")).not.toBeInTheDocument();
    });

    it("renders markdown content when in markdown mode", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));

      // Should be in markdown mode (default)
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-MD")).toHaveTextContent("Markdown");

      // Check that the output container has markdown-body class
      const outputContainer = screen.getByTestId("workflow-result-output-WS-MD");
      expect(outputContainer).toHaveClass("workflow-result-output--markdown");
    });

    it("renders plain text when in plain mode", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));

      // Toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-MD"));

      // Output container should not have markdown class
      const outputContainer = screen.getByTestId("workflow-result-output-WS-MD");
      expect(outputContainer).not.toHaveClass("workflow-result-output--markdown");

      // Should show the raw markdown as preformatted text
      expect(outputContainer.textContent).toContain("# Header");
    });
  });

  describe("workflow step editing", () => {
    it("shows edit button when canEdit is true and configured steps are present", () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.getByTestId("workflow-steps-edit-toggle")).toBeInTheDocument();
    });

    it("does not show edit button when canEdit is false or undefined", () => {
      const { rerender } = render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit={false}
          enabledWorkflowSteps={["WS-101"]}
        />,
      );
      expect(screen.queryByTestId("workflow-steps-edit-toggle")).not.toBeInTheDocument();

      rerender(<WorkflowResultsTab taskId="FN-001" results={[]} enabledWorkflowSteps={["WS-101"]} />);
      expect(screen.queryByTestId("workflow-steps-edit-toggle")).not.toBeInTheDocument();
    });

    it("shows and hides workflow step checkboxes when edit is toggled", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.queryByTestId("workflow-steps-editor")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      expect(screen.getByTestId("workflow-steps-editor")).toBeInTheDocument();
      await screen.findByTestId("workflow-step-checkbox-WS-101");
      expect(screen.getByTestId("workflow-step-checkbox-WS-103")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      expect(screen.queryByTestId("workflow-steps-editor")).not.toBeInTheDocument();
    });

    it("does not synthesize default-on optional steps when persisted ids are explicit", async () => {
      mockedFetchWorkflowOptionalSteps.mockResolvedValueOnce([
        {
          templateId: "browser-verification",
          name: "Browser Verification",
          description: "",
          phase: "pre-merge",
          defaultOn: true,
        },
      ]);
      mockedFetchWorkflowSteps.mockResolvedValueOnce(mockWorkflowSteps.filter((step) => step.id !== "WS-103"));
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      await waitFor(() => expect(mockedFetchWorkflowOptionalSteps).toHaveBeenCalled());
      expect(screen.queryByTestId("workflow-configured-step-browser-verification")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));

      const defaultOnCheckbox = within(await screen.findByTestId("workflow-step-checkbox-browser-verification")).getByRole("checkbox") as HTMLInputElement;
      expect(defaultOnCheckbox.checked).toBe(false);
      fireEvent.click(defaultOnCheckbox);
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-101", "WS-102", "browser-verification"]);

      onWorkflowStepsChange.mockClear();
      fireEvent.click(screen.getByTestId("workflow-step-remove-WS-101"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102"]);
    });

    it("calls onWorkflowStepsChange when checking and unchecking steps", async () => {
      const onWorkflowStepsChange = vi.fn();

      const { rerender } = render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      const stepCheckbox = (await screen.findByTestId("workflow-step-checkbox-WS-101")).querySelector("input") as HTMLInputElement;
      fireEvent.click(stepCheckbox);

      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102", "WS-101"]);

      onWorkflowStepsChange.mockClear();
      rerender(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      if (!screen.queryByTestId("workflow-steps-editor")) {
        fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      }

      const selectedCheckbox = (await screen.findByTestId("workflow-step-checkbox-WS-101")).querySelector("input") as HTMLInputElement;
      expect(selectedCheckbox.checked).toBe(true);
      fireEvent.click(selectedCheckbox);

      expect(onWorkflowStepsChange).toHaveBeenCalledWith([]);
    });

    it("reorders selected workflow steps with move buttons", async () => {
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      await screen.findByTestId("workflow-step-order");

      fireEvent.click(screen.getByTestId("workflow-step-move-down-WS-101"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102", "WS-101"]);
    });

    it("removes a selected workflow step from execution order", async () => {
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      await screen.findByTestId("workflow-step-order");

      fireEvent.click(screen.getByTestId("workflow-step-remove-WS-101"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102"]);
    });

    it("shows both results and edit UI when editing with existing results", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={mockResults}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));

      expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-steps-editor")).toBeInTheDocument();
      await screen.findByTestId("workflow-step-checkbox-WS-101");
    });

    it("renders Browser Verification exactly once when fetched steps include the template-backed option", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-103"]}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      const editor = await screen.findByTestId("workflow-steps-editor");
      await screen.findByTestId("workflow-step-checkbox-WS-103");

      expect(screen.queryByTestId("browser-verification-checkbox")).not.toBeInTheDocument();
      expect(within(editor).getAllByText("Browser Verification")).toHaveLength(1);
    });

    it("renders workflow-declared optional steps when not materialized", async () => {
      mockedFetchWorkflowSteps.mockResolvedValueOnce(mockWorkflowSteps.filter((step) => step.id !== "WS-103"));
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={[]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(await screen.findByTestId("workflow-steps-edit-toggle"));
      const checkbox = await screen.findByTestId("workflow-step-checkbox-browser-verification");

      expect(within(checkbox).getByText("Browser Verification")).toBeInTheDocument();
      fireEvent.click(within(checkbox).getByRole("checkbox"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["browser-verification"]);
    });

    it("disabling a workflow-declared optional step removes its template id", async () => {
      mockedFetchWorkflowSteps.mockResolvedValueOnce(mockWorkflowSteps.filter((step) => step.id !== "WS-103"));
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "browser-verification"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(await screen.findByTestId("workflow-steps-edit-toggle"));
      const checkbox = await screen.findByTestId("workflow-step-checkbox-browser-verification");
      fireEvent.click(within(checkbox).getByRole("checkbox"));

      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-101"]);
    });

    it("fetches workflow step definitions when canEdit and projectId are provided", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          projectId="proj-123"
          enabledWorkflowSteps={[]}
        />,
      );

      await waitFor(() => {
        expect(mockedFetchWorkflowSteps).toHaveBeenCalledWith("proj-123");
      });
    });
  });

  describe("theming contract", () => {
    it("uses CSS classes for phase badges instead of inline styles", () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[
            {
              workflowStepId: "WS-001",
              workflowStepName: "Pre-merge Step",
              phase: "pre-merge",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Post-merge Step",
              phase: "post-merge",
              status: "passed",
            },
          ]}
        />,
      );

      // Pre-merge phase badge should use CSS class
      const preMergeBadge = screen.getByTestId("workflow-result-phase-WS-001");
      expect(preMergeBadge).toHaveClass("phase-badge");
      expect(preMergeBadge).toHaveClass("phase-badge--pre-merge");
      // Check that there are no rgba() values in inline styles
      expect(preMergeBadge.getAttribute("style") || "").not.toMatch(/rgba\(/);

      // Post-merge phase badge should use CSS class
      const postMergeBadge = screen.getByTestId("workflow-result-phase-WS-002");
      expect(postMergeBadge).toHaveClass("phase-badge");
      expect(postMergeBadge).toHaveClass("phase-badge--post-merge");
      expect(postMergeBadge.getAttribute("style") || "").not.toMatch(/rgba\(/);
    });

    it("uses CSS classes for status badges instead of inline styles", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      const passedBadge = screen.getByTestId("workflow-result-badge-WS-001");
      const failedBadge = screen.getByTestId("workflow-result-badge-WS-002");
      const skippedBadge = screen.getByTestId("workflow-result-badge-WS-003");
      const pendingBadge = screen.getByTestId("workflow-result-badge-WS-004");

      // All badges should have CSS class-based styling
      expect(passedBadge).toHaveClass("workflow-result-badge--passed");
      expect(failedBadge).toHaveClass("workflow-result-badge--failed");
      expect(skippedBadge).toHaveClass("workflow-result-badge--skipped");
      expect(pendingBadge).toHaveClass("workflow-result-badge--pending");

      // No inline background color styles with rgba values
      const passedStyle = passedBadge.getAttribute("style") || "";
      const failedStyle = failedBadge.getAttribute("style") || "";
      expect(passedStyle).not.toMatch(/rgba\(/);
      expect(failedStyle).not.toMatch(/rgba\(/);
    });

    it("prevents reintroduction of hardcoded phase colors in component source", () => {
      // Read the component source file
      const fs = require("fs");
      const path = require("path");
      const componentPath = path.join(__dirname, "..", "WorkflowResultsTab.tsx");
      const componentSource = fs.readFileSync(componentPath, "utf-8");

      // These hardcoded color patterns should NOT appear in the component
      // (they were the old inline style values)
      const forbiddenPatterns = [
        /rgba\(59,\s*130,\s*246,\s*0\.15\)/, // pre-merge background
        /rgba\(139,\s*92,\s*246,\s*0\.15\)/, // post-merge background
        /#[38]b82f6/, // pre-merge text (partial match for #3b82f6 or #8b5cf6)
        /#[89]b5cf6/, // post-merge text (partial match for #8b5cf6)
      ];

      for (const pattern of forbiddenPatterns) {
        expect(componentSource).not.toMatch(pattern);
      }
    });

    it("prevents reintroduction of getStatusColor function with hardcoded colors", () => {
      const fs = require("fs");
      const path = require("path");
      const componentPath = path.join(__dirname, "..", "WorkflowResultsTab.tsx");
      const componentSource = fs.readFileSync(componentPath, "utf-8");

      // The getStatusColor function should not exist (removed to use CSS classes)
      expect(componentSource).not.toMatch(/function getStatusColor/);
      expect(componentSource).not.toMatch(/getStatusColor\(/);
    });

    it("keeps workflow tab CSS selector blocks free of raw color literals", () => {
      const css = loadAllAppCssBaseOnly();
      const selectors = [
        ".workflow-result-badge--passed",
        ".workflow-result-badge--failed",
        ".workflow-result-badge--pending",
        ".phase-badge--pre-merge",
        ".phase-badge--post-merge",
        ".workflow-result-output",
        ".workflow-live-log-tool",
        ".workflow-live-log-tool-result",
        ".workflow-live-log-tool-error",
        ".workflow-output-modal-overlay",
      ];

      for (const selector of selectors) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
        expect(match?.[1] ?? "").not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
      }
    });

    it("wraps configured workflow names and modal headers to prevent long-name overflow", () => {
      const css = loadAllAppCssBaseOnly();

      expect(css).toMatch(/\.workflow-configured-title-row\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/);
      expect(css).toMatch(/\.workflow-configured-name\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/);
      expect(css).toMatch(/\.workflow-configured-name-text\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
      expect(css).toMatch(/\.workflow-output-modal-header\s*\{[^}]*flex-wrap:\s*wrap;/);
      expect(css).toMatch(/\.workflow-output-modal-title\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;/);
      expect(css).toMatch(/\.workflow-output-modal-name\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
    });

    it("keeps workflow output header actions visible without hardcoded badge sizing", () => {
      const baseCss = loadAllAppCssBaseOnly();
      const allCss = loadAllAppCss();

      expect(baseCss).toMatch(/\.phase-badge\s*\{[^}]*font-size:\s*calc\(var\(--space-sm\) \+ var\(--space-xs\) \* 0\.75\);/);
      expect(baseCss).toMatch(/\.workflow-result-output-header\s*\{[^}]*flex-wrap:\s*wrap;/);
      expect(baseCss).toMatch(/\.workflow-result-output-preview\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
      expect(allCss).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-result-output-preview\s*\{[^}]*flex-basis:\s*100%;[^}]*order:\s*3;/);
      expect(baseCss).toMatch(/\.workflow-result-mode-toggle\s*\{[^}]*margin-left:\s*auto;[^}]*flex-shrink:\s*0;/);
      expect(allCss).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-result-mode-toggle\s*\{[^}]*margin-left:\s*0;[^}]*min-width:\s*calc\(var\(--space-lg\) \* 2 \+ var\(--space-xs\)\);[^}]*min-height:\s*calc\(var\(--space-lg\) \* 2 \+ var\(--space-xs\)\);/);
    });


    it("keeps the workflow edit toggle on button primitives instead of fixed icon-button sizing", () => {
      const baseCss = loadAllAppCssBaseOnly();
      const editToggleRule = baseCss.match(/\.workflow-results-edit-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
      const buttonSmallRule = baseCss.match(/\.btn-sm\s*\{([^}]*)\}/)?.[1] ?? "";

      expect(editToggleRule).not.toMatch(/\bwidth\s*:\s*28px\s*;/);
      expect(editToggleRule).not.toMatch(/\bheight\s*:\s*28px\s*;/);
      expect(buttonSmallRule).toMatch(/padding\s*:\s*(?!0(?:\s+0){0,3})[^;]+;/);
    });

    it("allows workflow modal controls to wrap on mobile so the close button stays visible", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-output-modal-controls\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*space-between;/);
      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-configured-header \.workflow-results-edit-toggle\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*center;/);
    });

    it("stacks workflow summary cards on mobile", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/\.workflow-state-summary__grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-state-summary__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    });

    it("applies fullscreen modal dimensions on mobile", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-output-modal\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*border-radius:\s*0;/);
    });

    it("removes mobile modal overlay inset padding", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-output-modal-overlay\s*\{[^}]*padding:\s*0;/);
    });

    it("includes safe-area top padding for expanded output modal header on mobile", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-output-modal-header\s*\{[^}]*padding-top:\s*max\([^;]*env\(safe-area-inset-top/);
    });

    it("includes safe-area bottom padding for expanded output modal body on mobile", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{]*\(max-width: 768px\)[^{]*\{[\s\S]*?\.workflow-output-modal-body\s*\{[^}]*padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/);
    });
  });

  describe("expanded view modal", () => {
    it("opens expanded view when zoom button is clicked", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // First expand the output
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Then click the expand button
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal should be visible
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-output-modal-content")).toBeInTheDocument();
    });

    it("shows modal header with step name and phase badge", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Check header content - use more specific selector
      expect(screen.getByTestId("workflow-output-modal")).toHaveTextContent("QA Check");
      expect(screen.getByTestId("workflow-output-modal-phase-WS-001")).toHaveTextContent("Pre-merge");
    });

    it("has a close button that closes the modal", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is open
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Click close button
      fireEvent.click(screen.getByTestId("workflow-output-modal-close"));

      // Modal should be closed
      expect(screen.queryByTestId("workflow-output-modal")).not.toBeInTheDocument();
    });

    it("closes modal when clicking backdrop", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is open
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Click backdrop (overlay)
      const overlay = screen.getByTestId("workflow-output-modal");
      fireEvent.click(overlay);

      // Modal should be closed (clicking backdrop should close)
      // Note: The actual click handler checks if target === currentTarget
      // In the DOM, clicking the overlay div itself triggers the close
    });

    it("modal syncs with step render mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001 and toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");

      // Open modal
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal should also be in plain mode
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Plain");
    });

    it("can toggle render mode within modal", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal (starts in markdown mode)
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is in markdown mode
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Markdown");

      // Toggle to plain in modal
      fireEvent.click(screen.getByTestId("workflow-output-modal-mode-toggle"));
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Plain");

      // The inline view should also reflect this change
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");
    });

    it("displays markdown content in expanded view", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-MD"));

      // Modal content should be rendered
      expect(screen.getByTestId("workflow-output-modal-content")).toBeInTheDocument();
    });

    it("does not show expand button when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand button should not be visible when output is collapsed
      expect(screen.queryByTestId("workflow-result-expand-WS-001")).not.toBeInTheDocument();
    });

    it("modal is independent per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand both
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));

      // Open modal for WS-001
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Close modal
      fireEvent.click(screen.getByTestId("workflow-output-modal-close"));
      expect(screen.queryByTestId("workflow-output-modal")).not.toBeInTheDocument();

      // Open modal for WS-002
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-002"));
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();
    });
  });

  describe("verdict and notes rendering", () => {
    it("renders PASS verdict badge when verdict is present", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          verdict: "APPROVE",
          output: "All tests passed.",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      const badge = screen.getByTestId("workflow-verdict-badge-WS-001");
      expect(badge).toHaveTextContent("APPROVE");
      expect(badge.className).toContain("workflow-verdict-badge--APPROVE");
    });

    it("renders FAIL verdict badge when verdict is present", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-002",
          workflowStepName: "Security Audit",
          status: "failed",
          verdict: "REVISE",
          output: "Found issues in auth.ts.",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      const badge = screen.getByTestId("workflow-verdict-badge-WS-002");
      expect(badge).toHaveTextContent("REVISE");
      expect(badge.className).toContain("workflow-verdict-badge--REVISE");
    });

    it("does not render verdict badge when verdict is undefined", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          output: "All tests passed.",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      expect(screen.queryByTestId("workflow-verdict-badge-WS-001")).not.toBeInTheDocument();
    });

    it("renders notes when present on completed step", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          verdict: "APPROVE",
          notes: "No relevant changes in scope — approved.",
          output: "Reviewed files.",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      const notesEl = screen.getByTestId("workflow-result-notes-WS-001");
      expect(notesEl).toHaveTextContent("No relevant changes in scope — approved.");
    });

    it("hides notes when status is pending", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "pending",
          notes: "Should not show.",
          startedAt: "2026-03-31T10:00:00Z",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      expect(screen.queryByTestId("workflow-result-notes-WS-001")).not.toBeInTheDocument();
    });

    it("renders both verdict badge and notes together", () => {
      const results: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-003",
          workflowStepName: "UX Review",
          status: "advisory_failure",
          verdict: "REVISE",
          notes: "Spacing needs adjustment.",
          output: "Detailed findings here.",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={results} />);

      expect(screen.getByTestId("workflow-verdict-badge-WS-003")).toHaveTextContent("REVISE");
      expect(screen.getByTestId("workflow-result-notes-WS-003")).toHaveTextContent("Spacing needs adjustment.");
    });
  });
});
