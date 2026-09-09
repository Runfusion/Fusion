import { useState } from "react";
import type { Task } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatView } from "../../ChatView";
import { useBoardScrollRestore } from "../../../hooks/useBoardScrollRestore";
import {
  activeSessionFixture,
  installChatViewEnv,
  setupMockChat,
  setupMockRooms,
} from "../../__tests__/ChatView.test-harness";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn() }));

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

vi.mock("../../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflow.id, workflows: [workflow], taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: workflow.id,
    isAllWorkflowsSelected: false,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useUnmappedWorkflowRefetch", () => ({ useUnmappedWorkflowRefetch: vi.fn() }));
vi.mock("../../../hooks/useChat");
vi.mock("../../../hooks/useChatRooms");
vi.mock("../../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead }),
}));
vi.mock("../../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../ErrorBoundary", () => ({ PageErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../CapacityRiskBanner", () => ({ CapacityRiskBanner: () => null }));
vi.mock("../../BackendConnectionErrorPage", () => ({ BackendConnectionErrorPage: () => <output data-testid="connection-error" /> }));
vi.mock("../../ProjectOverview", () => ({ ProjectOverview: () => <output data-testid="project-overview" /> }));
vi.mock("../../TaskDetailModal", () => ({
  TaskDetailContent: ({ onBackToBoard }: { onBackToBoard?: () => void }) => (
    <button type="button" data-testid="task-detail-back" onClick={onBackToBoard}>Back to board</button>
  ),
}));
vi.mock("../../../api", () => ({
  fetchMission: vi.fn(),
  fetchMissions: vi.fn().mockResolvedValue([]),
  fetchInsights: vi.fn().mockResolvedValue({ insights: [] }),
  fetchTaskDetail: vi.fn(),
  listEvals: vi.fn().mockResolvedValue({ results: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ effective: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refreshPrStatus: vi.fn(),
  updateTask: vi.fn(),
}));

installChatViewEnv();

function taskFixture(id = "task-1"): Task {
  return {
    id,
    title: "Task",
    description: "Task detail",
    column: "triage",
    status: "pending",
    prompt: "",
    steps: [],
    attachments: [],
    dependencies: [],
    createdAt: "2026-08-30T19:05:00.000Z",
    updatedAt: "2026-08-30T19:05:00.000Z",
  } as Task;
}

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(async () => undefined),
    shellApi: null,
    taskView: "board",
    modalManager: {
      closeSettings: vi.fn(),
      openNewTaskWithDescription: vi.fn(),
    } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    ChatView: ChatView as unknown as MainContentProps["ChatView"],
    viewMode: "project",
    tasks: [],
    filteredBoardTasks: [],
    workflowSteps: [],
    remoteData: { tasks: [] } as MainContentProps["remoteData"],
    setQuickChatOpen: vi.fn(),
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as MainContentProps["capacityRiskSignal"],
    maxConcurrent: 2,
    maxWorktrees: 4,
    showWorktreeGrouping: false,
    moveTask: vi.fn(async () => taskFixture()),
    pauseTask: vi.fn(async () => taskFixture()),
    openBoardTaskDetail: vi.fn(),
    openTaskDetailInMainPanel: vi.fn(),
    openGroupModalWithNav: vi.fn(),
    handleBoardQuickCreate: vi.fn(async () => taskFixture()),
    openNewTaskWithNav: vi.fn(),
    toggleAutoMerge: vi.fn(async () => undefined),
    togglePlanAutoApprove: vi.fn(async () => undefined),
    autoMerge: true,
    planAutoApproveEnabled: false,
    mergeStrategy: "direct",
    globalPaused: false,
    updateTask: vi.fn(async () => taskFixture()),
    retryTask: vi.fn(async () => taskFixture()),
    revertTask: vi.fn(async () => ({ task: taskFixture() })),
    deleteTask: vi.fn(async () => taskFixture()),
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: vi.fn(),
    handleToggleFavorite: vi.fn(async () => undefined),
    handleToggleModelFavorite: vi.fn(async () => undefined),
    staleHighFanoutBlockerAgeThresholdMs: 0,
    lastFetchTimeMs: undefined,
    prAuthAvailable: false,
    openWorkflowEditorWithNav: vi.fn(),
    openCreateWorkflowWithNav: vi.fn(),
    sidebarActive: true,
    isMobile: false,
    isRemote: false,
    ingestCreatedTasks: vi.fn(),
    openDetailTask: vi.fn(),
    popOutTaskDetail: vi.fn(),
    onOpenChatWithPrefill: vi.fn(),
    closeTaskDetailMainPanel: vi.fn(),
    setMainPanelDetailTask: vi.fn(),
    handleDismissCapacityRisk: vi.fn(),
    ...overrides,
  } as unknown as MainContentProps;
}

function addHeaderSlot() {
  const slot = document.createElement("div");
  slot.id = "header-workflow-slot";
  document.body.appendChild(slot);
  return slot;
}

function boardRoot(): HTMLElement {
  const board = document.getElementById("board");
  if (!board) throw new Error("Expected the production Board root");
  return board;
}

function chatRoot(): HTMLElement {
  const chat = document.querySelector<HTMLElement>(".chat-view");
  if (!chat) throw new Error("Expected the production ChatView root");
  return chat;
}

async function openProductionChatComposer() {
  await screen.findByTestId(`chat-session-${activeSessionFixture.id}`);
  fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
  return screen.findByTestId("chat-input");
}

function configureProductionChat(messageId = "message-1") {
  setupMockRooms();
  setupMockChat({
    activeSession: activeSessionFixture,
    messages: [{ id: messageId, role: "user", content: "Unread", createdAt: "2026-08-30T19:05:00.000Z" }] as never,
  });
}

/*
FNXC:MainViewKeepAlive 2026-08-30-18:55:
These route tests mount the production Board, ListView, and ChatView. Their data hooks are mocked,
but the retained route itself must execute real scroll, portal, and unread-acknowledgement behavior
so a component stub cannot accidentally certify the keep-alive contract.
*/
function BoardDetailRestoreHarness() {
  const task = taskFixture();
  const [taskView, setTaskView] = useState<MainContentProps["taskView"]>("board");
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const { capture, requestRestore } = useBoardScrollRestore(taskView);

  const openDetail = () => {
    capture();
    setDetailTask(task);
    setTaskView("task-detail");
  };
  const returnToBoard = () => {
    requestRestore();
    setDetailTask(null);
    setTaskView("board");
  };

  return (
    <div className="project-content">
      <button type="button" data-testid="open-task-detail" onClick={openDetail}>Open task detail</button>
      <MainContent
        {...mainContentProps({
          taskView,
          tasks: [task],
          filteredBoardTasks: [task],
          mainPanelDetailTask: detailTask,
          openBoardTaskDetail: openDetail,
          closeTaskDetailMainPanel: returnToBoard,
        })}
      />
    </div>
  );
}

describe("MainContent main-view keep alive", () => {
  beforeEach(() => {
    markRead.mockClear();
    configureProductionChat();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById("header-workflow-slot")?.remove();
  });

  it.each([
    { name: "an empty Board", tasks: [] as Task[] },
    { name: "a populated Board", tasks: [taskFixture("task-populated")] },
  ])("keeps the production $name mounted across Board to Chat to Board navigation", async ({ tasks }) => {
    const result = render(<MainContent {...mainContentProps({ taskView: "board", tasks, filteredBoardTasks: tasks })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const board = boardRoot();
    const column = board.querySelector<HTMLElement>(".column-body");
    expect(column).not.toBeNull();
    board.scrollLeft = 124;
    column!.scrollTop = 48;

    result.rerender(<MainContent {...mainContentProps({ taskView: "chat", tasks, filteredBoardTasks: tasks })} />);
    await waitFor(() => expect(document.querySelector(".chat-view")).not.toBeNull());
    result.rerender(<MainContent {...mainContentProps({ taskView: "board", tasks, filteredBoardTasks: tasks })} />);

    expect(boardRoot()).toBe(board);
    expect(board.querySelector(".column-body")).toBe(column);
    expect(board.scrollLeft).toBe(124);
    expect(column!.scrollTop).toBe(48);
  });

  it("keeps the production Chat composer and transcript position across Chat to Board to Chat", async () => {
    const result = render(<MainContent {...mainContentProps({ taskView: "chat" })} />);
    const input = await openProductionChatComposer();
    const chat = chatRoot();
    const messages = chat.querySelector<HTMLElement>(".chat-messages");
    expect(messages).not.toBeNull();
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    Object.defineProperties(messages!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    messages!.scrollTop = 91;
    fireEvent.scroll(messages!);

    result.rerender(<MainContent {...mainContentProps({ taskView: "board" })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    result.rerender(<MainContent {...mainContentProps({ taskView: "chat" })} />);

    expect(chatRoot()).toBe(chat);
    expect(chat.querySelector(".chat-messages")).toBe(messages);
    expect(messages!.scrollTop).toBe(91);
    expect(await screen.findByTestId("chat-input")).toBe(input);
    expect(input).toHaveValue("Keep this draft");
  });

  it("keeps the production ListView mounted across List to Board to List navigation", async () => {
    const result = render(<MainContent {...mainContentProps({ taskView: "list" })} />);
    const list = await screen.findByTestId("list-view-body");
    list.scrollTop = 72;

    result.rerender(<MainContent {...mainContentProps({ taskView: "board" })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    result.rerender(<MainContent {...mainContentProps({ taskView: "list" })} />);

    expect(screen.getByTestId("list-view-body")).toBe(list);
    expect(list.scrollTop).toBe(72);
  });

  it("leaves a hidden retained production ListView inert while an unsupported route uses the switch fallback", async () => {
    const slot = addHeaderSlot();
    const result = render(<MainContent {...mainContentProps({ taskView: "list" })} />);
    const retainedList = await screen.findByTestId("list-view-body");

    result.rerender(<MainContent {...mainContentProps({ taskView: "unsupported-view" as MainContentProps["taskView"] })} />);

    await waitFor(() => expect(screen.getAllByTestId("list-view-body")).toHaveLength(2));
    const [hiddenRetainedList, switchFallbackList] = screen.getAllByTestId("list-view-body");
    expect(hiddenRetainedList).toBe(retainedList);
    expect(screen.getByTestId("list-keep-alive")).toHaveAttribute("aria-hidden", "true");
    expect(switchFallbackList).not.toBe(retainedList);
    expect(slot.querySelectorAll(".list-workflow-control")).toHaveLength(1);
  });

  it("uses exactly one retained production Board for the empty task-detail fallback", async () => {
    render(<MainContent {...mainContentProps({ taskView: "task-detail", mainPanelDetailTask: null })} />);
    await waitFor(() => expect(document.querySelectorAll("#board")).toHaveLength(1));
    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
  });

  it.each([
    { name: "projects overview", props: { viewMode: "overview" as const }, page: "project-overview" },
    { name: "backend connection error", props: { showBackendConnectionErrorPage: true }, page: "connection-error" },
  ])("keeps production Board and Chat mounted but inert behind the $name", async ({ props, page }) => {
    const slot = addHeaderSlot();
    const result = render(<MainContent {...mainContentProps({ taskView: "board" })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const board = boardRoot();
    board.scrollLeft = 88;

    result.rerender(<MainContent {...mainContentProps({ taskView: "chat" })} />);
    const input = await openProductionChatComposer();
    const chat = chatRoot();
    fireEvent.change(input, { target: { value: "Do not lose this" } });
    markRead.mockClear();
    configureProductionChat("arrived-while-hidden");

    result.rerender(<MainContent {...mainContentProps({ taskView: "chat", ...props })} />);

    await screen.findByTestId(page);
    await waitFor(() => expect(slot).toBeEmptyDOMElement());
    expect(boardRoot()).toBe(board);
    expect(chatRoot()).toBe(chat);
    expect(board.scrollLeft).toBe(88);
    expect(input).toHaveValue("Do not lose this");
    expect(screen.getByTestId("board-keep-alive")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("chat-keep-alive")).toHaveAttribute("aria-hidden", "true");
    expect(markRead).not.toHaveBeenCalled();
  });

  it("drops the production retained set when all-projects changes to a project", async () => {
    const result = render(<MainContent {...mainContentProps({ taskView: "board", currentProject: null })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const allProjectsBoard = boardRoot();

    result.rerender(
      <MainContent
        {...mainContentProps({
          taskView: "board",
          currentProject: { id: "project-2", name: "Project 2" } as MainContentProps["currentProject"],
        })}
      />,
    );

    await waitFor(() => expect(boardRoot()).not.toBe(allProjectsBoard));
  });

  it("executes the production Board scroll-restore replay through a task-detail round trip", async () => {
    const result = render(<BoardDetailRestoreHarness />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const board = boardRoot();
    const column = board.querySelector<HTMLElement>(".column-body");
    expect(column).not.toBeNull();
    board.scrollLeft = 37;
    column!.scrollTop = 53;

    fireEvent.click(screen.getByTestId("open-task-detail"));
    expect(screen.getByTestId("board-keep-alive")).toHaveAttribute("aria-hidden", "true");
    board.scrollLeft = 0;
    column!.scrollTop = 0;
    fireEvent.click(screen.getByTestId("task-detail-back"));

    await waitFor(() => {
      expect(boardRoot()).toBe(board);
      expect(board.scrollLeft).toBe(37);
      expect(column!.scrollTop).toBe(53);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(board.scrollLeft).toBe(37);
    expect(column!.scrollTop).toBe(53);
    result.unmount();
  });

  it("does not mount a new hidden production view early, but retains an already visited one through that state", async () => {
    const result = render(<MainContent {...mainContentProps({ taskView: "chat", viewMode: "overview" })} />);
    expect(screen.queryByTestId("chat-keep-alive")).toBeNull();

    result.rerender(<MainContent {...mainContentProps({ taskView: "board" })} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const board = boardRoot();
    board.scrollLeft = 29;

    result.rerender(<MainContent {...mainContentProps({ taskView: "board", viewMode: "overview" })} />);
    expect(boardRoot()).toBe(board);
    expect(board.scrollLeft).toBe(29);
    expect(screen.getByTestId("board-keep-alive")).toHaveAttribute("aria-hidden", "true");

    result.rerender(<MainContent {...mainContentProps({ taskView: "board" })} />);
    expect(boardRoot()).toBe(board);
    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
  });
});
