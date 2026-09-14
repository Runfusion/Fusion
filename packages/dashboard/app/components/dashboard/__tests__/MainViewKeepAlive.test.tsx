import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { listComponentFiles, readAppFile } from "../../../test/cssFixture";
import type { MainContentProps } from "../types";
import { KEEP_ALIVE_MAIN_VIEW_IDS, MainViewKeepAlive } from "../MainViewKeepAlive";

const activeByView = vi.hoisted(() => {
  const workflow = {
    id: "builtin:coding",
    name: "Coding",
    columns: [
      { id: "triage", name: "Triage", flags: { intake: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  };
  const workflowHookResult = {
    boardWorkflows: {
      defaultWorkflowId: workflow.id,
      workflows: [workflow],
      taskWorkflowIds: {},
    },
    workflowMode: true,
    workflowOptions: [workflow],
    selectedWorkflow: workflow,
    selectedWorkflowId: workflow.id,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  };
  return {
    workflow,
    workflowHookResult,
    board: [] as boolean[],
    list: [] as boolean[],
    chat: [] as boolean[],
    historyCallbacks: [] as Array<(() => void) | undefined>,
    historyColumnRenders: 0,
    markRead: vi.fn(),
  };
});

vi.mock("../../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => activeByView.workflowHookResult,
}));

vi.mock("../../Column", () => ({
  Column: memo(function InstrumentedColumn(props: {
    active?: boolean;
    column: string;
    columnFlags?: { complete?: boolean };
    onOpenHistory?: () => void;
    [key: string]: unknown;
  }) {
    const { active, column, columnFlags, onOpenHistory } = props;
    const isActive = active ?? true;
    activeByView.board.push(isActive);
    if (!columnFlags?.complete) return <output data-testid={`board-column-${column}`} data-active={String(isActive)} />;

    activeByView.historyColumnRenders += 1;
    activeByView.historyCallbacks.push(onOpenHistory);
    return (
      <output data-testid="board-child" data-active={String(isActive)}>
        {onOpenHistory ? (
          <button type="button" data-testid="column-history-done" onClick={onOpenHistory}>History</button>
        ) : null}
      </output>
    );
  }),
}));
vi.mock("../../ListView", () => ({
  ListView: ({ active }: { active?: boolean }) => {
    const isActive = active ?? true;
    activeByView.list.push(isActive);
    const slot = document.getElementById("header-workflow-slot");
    return (
      <>
        <output data-testid="list-child" data-active={String(isActive)} />
        {isActive && slot ? createPortal(<output data-testid="list-header-control">List controls</output>, slot) : null}
      </>
    );
  },
}));
vi.mock("../../ErrorBoundary", () => ({ PageErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../CapacityRiskBanner", () => ({ CapacityRiskBanner: () => null }));

function MockChatView({ active }: { active?: boolean }) {
  const isActive = active ?? true;
  activeByView.chat.push(isActive);
  useEffect(() => {
    if (isActive) activeByView.markRead();
  }, [isActive]);
  return <output data-testid="chat-child" data-active={String(isActive)} />;
}

function mainContentProps(): MainContentProps {
  return {
    ChatView: MockChatView,
    currentProject: { id: "project-1" },
    tasks: [],
    filteredBoardTasks: [],
    remoteData: { tasks: [] },
    addToast: vi.fn(),
    setQuickChatOpen: vi.fn(),
  } as unknown as MainContentProps;
}

function renderHost(activeId: "board" | "list" | "chat" | null) {
  return render(
    <MainViewKeepAlive
      activeId={activeId}
      mountedIds={KEEP_ALIVE_MAIN_VIEW_IDS}
      projectKey="project-1"
      mainContentProps={mainContentProps()}
    />,
  );
}

function HistoryWindowHost() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [props] = useState(() => ({
    ...mainContentProps(),
    handleChangeTaskView: (view: MainContentProps["taskView"]) => {
      if (view === "patchnode") setHistoryOpen(true);
    },
  } as MainContentProps));
  return (
    <>
      <MainViewKeepAlive
        activeId="board"
        mountedIds={["board"]}
        projectKey="project-1"
        mainContentProps={props}
      />
      {historyOpen ? <output data-testid="history-window">History open</output> : null}
    </>
  );
}

function createHeaderSlot() {
  const slot = document.createElement("div");
  slot.id = "header-workflow-slot";
  document.body.appendChild(slot);
  return slot;
}

function productionAppSourceFiles(): string[] {
  return [
    "App.tsx",
    ...listComponentFiles()
      .filter((path) => !path.split("/").some((segment) => segment === "__tests__" || segment === "__mocks__"))
      .map((path) => `components/${path}`),
  ].sort();
}

describe("MainViewKeepAlive", () => {
  it("keeps the complete-column History callback stable when its Alpha window opens", () => {
    activeByView.historyCallbacks.length = 0;
    activeByView.historyColumnRenders = 0;
    render(<HistoryWindowHost />);

    const boardBefore = screen.getByTestId("board-child");
    const callbackBefore = activeByView.historyCallbacks.at(-1);
    expect(callbackBefore).toBeTypeOf("function");
    const rendersBeforeOpen = activeByView.historyColumnRenders;
    expect(rendersBeforeOpen).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("column-history-done"));

    expect(screen.getByTestId("history-window")).toBeInTheDocument();
    expect(screen.getByTestId("board-child")).toBe(boardBefore);
    expect(activeByView.historyCallbacks.at(-1)).toBe(callbackBefore);
    expect(activeByView.historyColumnRenders).toBe(rendersBeforeOpen);
  });

  it("exposes History whenever the official complete lane has a route handler", () => {
    renderHost("board");
    expect(screen.getByTestId("column-history-done")).toBeInTheDocument();
  });

  it("keeps visited children mounted and derives their active value from one resolved id", () => {
    const result = renderHost("board");

    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
    for (const id of ["list", "chat"] as const) {
      expect(screen.getByTestId(`${id}-keep-alive`)).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByTestId(`${id}-child`)).toHaveAttribute("data-active", "false");
    }

    const boardBefore = screen.getByTestId("board-child");
    result.rerender(
      <MainViewKeepAlive
        activeId="chat"
        mountedIds={KEEP_ALIVE_MAIN_VIEW_IDS}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
      />,
    );

    expect(screen.getByTestId("board-child")).toBe(boardBefore);
    expect(screen.getByTestId("board-keep-alive")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("chat-keep-alive")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("chat-child")).toHaveAttribute("data-active", "true");
  });

  it.each(["chat", "list"] as const)("keeps Board visible beneath the Alpha mobile %s drawer and closes it once by handle drag", (activeId) => {
    const close = vi.fn();
    render(
      <MainViewKeepAlive
        activeId={activeId}
        mountedIds={["board", activeId]}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
        alphaMobileDrawer={{ activeId, title: activeId === "chat" ? "Chat" : "List", onClose: close }}
      />,
    );

    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
    const dialog = screen.getByRole("dialog", { name: activeId === "chat" ? "Chat" : "List" });
    expect(dialog).toContainElement(screen.getByTestId(`${activeId}-child`));
    expect(dialog.querySelector(".alpha-mobile-drawer__close")).toBeNull();
    const handle = dialog.querySelector(".alpha-mobile-drawer__handle-target")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0, button: 0, isPrimary: true });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 200 });

    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(`${activeId}-child`)).toHaveAttribute("data-active", "true");
  });

  it("hides and deactivates every mounted entry when no main view is active", () => {
    const slot = createHeaderSlot();
    activeByView.markRead.mockClear();
    renderHost(null);

    for (const id of KEEP_ALIVE_MAIN_VIEW_IDS) {
      expect(screen.getByTestId(`${id}-keep-alive`)).toHaveAttribute("aria-hidden", "true");
      if (id !== "board") expect(screen.getByTestId(`${id}-child`)).toHaveAttribute("data-active", "false");
    }
    expect(slot).toBeEmptyDOMElement();
    expect(activeByView.markRead).not.toHaveBeenCalled();
    slot.remove();
  });

  it("lets only the visible retained view own the shared header slot", () => {
    const slot = createHeaderSlot();
    render(
      <MainViewKeepAlive
        activeId="list"
        mountedIds={["board", "list"]}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
      />,
    );

    expect(screen.getByTestId("board-keep-alive")).toHaveAttribute("aria-hidden", "true");
    expect(slot.querySelectorAll("[data-testid$='header-control']")).toHaveLength(1);
    expect(slot).toContainElement(screen.getByTestId("list-header-control"));
    expect(slot.querySelector(".board-workflow-toolbar")).toBeNull();
    slot.remove();
  });

  it("keeps the production Chat and workflow-header host census explicit", () => {
    const sourceFiles = productionAppSourceFiles();
    const chatHosts = sourceFiles
      .filter((file) => readAppFile(file).includes("<ChatView"))
      .sort();
    expect(chatHosts).toEqual([
      "components/ChatView.tsx",
      "components/PoppedOutChatWindows.tsx",
      "components/dashboard/MainViewKeepAlive.tsx",
      "components/overflowViewRegistry.tsx",
    ]);

    const headerPortalHosts = sourceFiles
      .filter((file) => {
        const source = readAppFile(file);
        return source.includes("headerWorkflowSlot") && source.includes("createPortal(");
      })
      .sort();
    expect(headerPortalHosts).toEqual([
      "components/Board.tsx",
      "components/GraphWorkflowSwitcherSlot.tsx",
      "components/HeaderWorkflowSwitcherSlot.tsx",
      "components/ListView.tsx",
    ]);

    const quickChatHost = readAppFile("App.tsx");
    expect(quickChatHost).toContain("hidden={!quickChatOpen}");
  });
});
