import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";
import type { TaskDetail, Column, MergeResult, Task } from "@fusion/core";
import { clearAuthToken } from "../../auth";

const taskDetailSseSubscriptions = vi.hoisted(() => [] as Array<{
  url: string;
  options: { events?: Record<string, (event: MessageEvent) => void> };
}>);

export { taskDetailSseSubscriptions };

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((url: string, options: { events?: Record<string, (event: MessageEvent) => void> }) => {
    taskDetailSseSubscriptions.push({ url, options });
    return vi.fn();
  }),
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({}),
    repairOverlapBlocker: vi.fn().mockResolvedValue({ repaired: true, statusCleared: false, reason: "repaired", message: "Repaired", task: makeTask() }),
    summarizeTitle: vi.fn().mockResolvedValue("Generated Title"),
    fetchTaskDetail: vi.fn().mockResolvedValue(makeTask()),
    fetchAgentLogs: vi.fn().mockResolvedValue([]),
    requestSpecRevision: vi.fn().mockResolvedValue({}),
    approvePlan: vi.fn().mockResolvedValue({}),
    rejectPlan: vi.fn().mockResolvedValue({}),
    duplicateTask: vi.fn().mockResolvedValue({}),
    refineTask: vi.fn().mockResolvedValue({}),
    addSteeringComment: vi.fn(),
    assignTask: vi.fn().mockResolvedValue({}),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgent: vi.fn().mockResolvedValue(null),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [] }),
    fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: vi.fn().mockResolvedValue({}),
    fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
    fetchWorkflows: vi.fn().mockResolvedValue([]),
    fetchTaskWorkflow: vi.fn().mockResolvedValue({ workflowId: null }),
    fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: false, defaultWorkflowId: "", workflows: [], taskWorkflowIds: {} }),
    fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
    fetchWorkflow: vi.fn().mockResolvedValue({ id: "builtin:coding", name: "Coding", ir: { version: 1, nodes: [], edges: [] } }),
    selectTaskWorkflow: vi.fn().mockResolvedValue({ workflowId: null, enabledWorkflowSteps: [] }),
    submitTaskWorkflowInput: vi.fn().mockResolvedValue({ ok: true }),
    approveTaskWorkflowCli: vi.fn().mockResolvedValue({ approved: "ok" }),
    refineText: vi.fn(),
    getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
    updateGlobalSettings: vi.fn().mockResolvedValue({}),
    pauseTask: vi.fn().mockResolvedValue({}),
    unpauseTask: vi.fn().mockResolvedValue({}),
    refreshPrStatus: vi.fn(),
    fetchWorkflowResults: vi.fn().mockResolvedValue([]),
    fetchTaskReview: vi.fn().mockResolvedValue({ reviewState: { source: "reviewer-agent", items: [], addressing: [] }, automationStatus: null, emptyMessage: "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode." }),
    refreshTaskReview: vi.fn().mockResolvedValue({ reviewState: undefined, automationStatus: null }),
    reviseTaskReviewItems: vi.fn().mockResolvedValue({ task: makeTask(), reviewState: undefined }),
    ensureTaskPlannerChatSession: vi.fn().mockResolvedValue({ session: { id: "chat-task-planner", agentId: "task-planner:FN-099", title: "FN-099 planner chat", status: "active", projectId: null, modelProvider: null, modelId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", cliSessionFile: null, cliExecutorAdapterId: null, inFlightGeneration: null } }),
    fetchChatMessages: vi.fn().mockResolvedValue({ messages: [] }),
    streamChatResponse: vi.fn(),
  });
});

// Mock lucide-react icons used by TaskDetailModal, TaskForm, PrPanel, CustomModelDropdown
vi.mock("lucide-react", () => ({
  Pencil: () => null,
  Sparkles: (props: any) => React.createElement("svg", { "data-testid": "sparkles-icon", ...props }),
  Globe: () => null,
  GitPullRequest: () => null,
  ExternalLink: () => null,
  RefreshCw: () => null,
  Plus: () => null,
  MessageSquare: () => null,
  Check: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
  ChevronRight: (props: any) => React.createElement("svg", { "data-testid": "chevron-right-icon", ...props }),
  ArrowLeft: () => null,
  Zap: () => null,
  X: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  Loader2: (props: any) => React.createElement("svg", { "data-testid": "loader2-icon", ...props }),
  Send: (props: any) => React.createElement("svg", { "data-testid": "send-icon", ...props }),
  Bot: () => null,
  CircleDot: () => null,
  XCircle: () => null,
  Workflow: () => null,
  GitMerge: () => null,
  GitBranch: () => null,
  AlertTriangle: () => null,
  Play: () => null,
  Flag: () => null,
  Terminal: () => null,
  Shield: () => null,
  PauseCircle: () => null,
  Split: () => null,
  Merge: () => null,
  Repeat: () => null,
  // FNXC:Test 2026-06-24-23:30: WorkflowNodeEditor (lazy-loaded by TaskDetailModal) uses ToggleRight
  // for the optional-group node (FN-6880); the explicit mock list omitted it, breaking every
  // TaskDetailModal suite at import. Keep this list in sync with the node-editor icon set.
  ToggleRight: () => null,
  ClipboardCheck: () => null,
  ListChecks: () => null,
  Code2: () => null,
  Cpu: () => null,
  Bell: () => null,
}));

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(() => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false })),
}));

// Mock usePluginUiSlots hook
export const mockUsePluginUiSlots = vi.fn((_projectId?: string) => ({
  slots: [] as any[],
  getSlotsForId: vi.fn((_id: string) => [] as any[]),
  loading: false,
  error: null,
}));

vi.mock("../../hooks/usePluginUiSlots", () => ({
  usePluginUiSlots: (projectId?: string) => mockUsePluginUiSlots(projectId),
}));

export const mockConfirm = vi.fn();
export const mockConfirmWithChoice = vi.fn();
export const mockConfirmWithCheckbox = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({
    confirm: mockConfirm,
    confirmWithChoice: mockConfirmWithChoice,
    confirmWithCheckbox: mockConfirmWithCheckbox,
  }),
}));

export function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-099",
    description: "Test task",
    column: "in-progress" as Column,
    dependencies: [],
    prompt: "",
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as TaskDetail;
}

export const noop = vi.fn();
export const noopMove = vi.fn(async () => ({}) as Task);
export const noopDelete = vi.fn(async () => ({}) as Task);
export const noopMerge = vi.fn(async () => ({ merged: false }) as MergeResult);
export const noopRetry = vi.fn(async () => ({}) as Task);
export const noopOpenDetail = vi.fn();

export function getCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function expectBaseRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(`${escapeRegExp(selector)}\\s*\\{[^}]*${escapeRegExp(declaration)}`);
  expect(pattern.test(css)).toBe(true);
}

export function readDashboardStylesSource(): string {
  return loadAllAppCss();
}

export function loadDashboardCss(): string {
  return loadAllAppCss();
}

export function setupTaskDetailModalHooks(): void {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockConfirmWithChoice.mockReset();
    mockConfirmWithCheckbox.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockConfirmWithChoice.mockResolvedValue("primary");
    mockConfirmWithCheckbox.mockResolvedValue({ choice: "primary", checkboxValue: false });
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    taskDetailSseSubscriptions.length = 0;
  });

  afterEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
  });
}
