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
/*
FNXC:WorkflowControls 2026-09-16-23:24:
FN-483 : ce double reflète le contrat réel de ListView — publier dans le slot demande à la fois d'être actif ET d'y
être autorisé. Un double qui ne lirait que `active` ne pourrait pas détecter le doublon de sélecteurs signalé.
*/
vi.mock("../../ListView", () => ({
  ListView: ({ active, showWorkflowControls }: { active?: boolean; showWorkflowControls?: boolean }) => {
    const isActive = active ?? true;
    const controlsAllowed = showWorkflowControls ?? true;
    activeByView.list.push(isActive);
    const slot = document.getElementById("header-workflow-slot");
    return (
      <>
        <output data-testid="list-child" data-active={String(isActive)} data-workflow-controls={String(controlsAllowed)} />
        {isActive && controlsAllowed && slot ? createPortal(<output data-testid="list-header-control">List controls</output>, slot) : null}
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

/*
FNXC:HistoryModalSurface 2026-09-15-04:29:
FN-403: the complete-lane History action is a modal request. It calls the `openHistory` owner and must never route
through `handleChangeTaskView`, so the retained Board subtree keeps its identity and its memoized column callbacks.
*/
function HistoryWindowHost() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const viewChanges: string[] = trackedViewChanges;
  const [props] = useState(() => ({
    ...mainContentProps(),
    openHistory: () => setHistoryOpen(true),
    handleChangeTaskView: (view: MainContentProps["taskView"]) => {
      viewChanges.push(String(view));
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

const trackedViewChanges: string[] = [];

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
  it("keeps the complete-column History callback stable when the History modal opens", () => {
    trackedViewChanges.length = 0;
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
    expect(trackedViewChanges).toEqual([]);
    expect(screen.getByTestId("board-child")).toBe(boardBefore);
    expect(activeByView.historyCallbacks.at(-1)).toBe(callbackBefore);
    expect(activeByView.historyColumnRenders).toBe(rendersBeforeOpen);
  });

  /*
   * FN-419: in `sidebar` navigation placement Chat is an ordinary main page, exactly like Notes — no drawer wrapper,
   * and still exactly ONE mounted primary Chat instance (FN-392 invariant).
   */
  it("mounts Chat as a page with no drawer wrapper and a single instance for the sidebar page host", () => {
    activeByView.chat.length = 0;
    const { container } = render(
      <MainViewKeepAlive
        activeId="chat"
        mountedIds={["board", "chat"]}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
      />,
    );

    expect(screen.getAllByTestId("chat-child")).toHaveLength(1);
    expect(screen.getByTestId("chat-child")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("chat-keep-alive")).not.toHaveAttribute("aria-hidden");
    expect(container.querySelector(".mobile-drawer")).toBeNull();
    expect(container.querySelector("[data-testid='main-view-mobile-drawer']")).toBeNull();
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
        mobileDrawer={{ activeId, title: activeId === "chat" ? "Chat" : "List", onClose: close }}
      />,
    );

    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
    const dialog = screen.getByRole("dialog", { name: activeId === "chat" ? "Chat" : "List" });
    expect(dialog).toContainElement(screen.getByTestId(`${activeId}-child`));
    expect(dialog.querySelector(".mobile-drawer__close")).toBeNull();
    const handle = dialog.querySelector(".mobile-drawer__handle-target")!;
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

  /*
   * FN-483 : sous un drawer téléphone, Board reste le propriétaire unique du sélecteur. List reste ACTIVE (ses
   * tâches et ses effets continuent) mais ne publie aucun contrôle : c'est le second symptôme signalé.
   */
  it("laisse le Board de fond seul propriétaire du slot quand List s'ouvre en drawer téléphone", () => {
    const slot = createHeaderSlot();
    render(
      <MainViewKeepAlive
        activeId="list"
        mountedIds={["board", "list"]}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
        mobileDrawer={{ activeId: "list", title: "List", onClose: vi.fn() }}
      />,
    );

    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("list-child")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("list-child")).toHaveAttribute("data-workflow-controls", "false");
    expect(screen.queryByTestId("list-header-control")).toBeNull();
    /* Le Board de fond reste le seul producteur : exactement un sélecteur, et aucun toolbar en dehors du slot. */
    expect(slot.querySelectorAll("[data-testid='workflow-switcher']")).toHaveLength(1);
    expect(document.querySelectorAll("[data-testid='workflow-switcher']")).toHaveLength(1);
    expect(slot.querySelectorAll("[data-testid$='header-control']")).toHaveLength(0);
    slot.remove();
  });

  /* FN-483 : fond explicitement désactivé (vue globale / erreur backend) — List redevient propriétaire légitime. */
  it("rend le slot à List quand le Board de fond est explicitement désactivé", () => {
    const slot = createHeaderSlot();
    render(
      <MainViewKeepAlive
        activeId="list"
        mountedIds={["board", "list"]}
        projectKey="project-1"
        mainContentProps={mainContentProps()}
        mobileDrawer={{ activeId: "list", title: "List", backgroundActive: false, onClose: vi.fn() }}
      />,
    );

    expect(screen.getByTestId("list-child")).toHaveAttribute("data-workflow-controls", "true");
    expect(slot.querySelectorAll("[data-testid$='header-control']")).toHaveLength(1);
    slot.remove();
  });

  it("keeps the canonical Chat and workflow-header host census explicit", () => {
    const sourceFiles = productionAppSourceFiles();
    const chatHosts = sourceFiles
      .filter((file) => readAppFile(file).includes("<ChatView"))
      .sort();
    /*
     * FN-426: App.tsx joins this census as the footer Conversations popover host. It is mounted only while that
     * popover is open and renders ChatView in `listOnly` mode, so it never adds a second retained transcript — the
     * conversation itself still opens through the existing popped-out chat windows.
     */
    expect(chatHosts).toEqual([
      "App.tsx",
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

    /*
     * FN-419: the keep-alive Chat gate is no longer mobile-drawer-only — the `sidebar` navigation placement is a
     * second page host. The structural guard follows the new gate: Chat enters the tree exactly when this shell is
     * the resolved page host, and a non-page shell still evicts a retained Chat entry.
     */
    const mainContent = readAppFile("components/dashboard/MainContent.tsx");
    /*
     * Assertion périmée réparée ici : la dérivation est désormais écrite sur plusieurs lignes, et FN-468 y a ajouté
     * l'hôte `"mobile-page"`. Le garde structurel vise les constituants du portillon, pas leur mise en forme.
     */
    expect(mainContent).toContain("const chatPageHostEnabled = mobileDrawerEnabled");
    expect(mainContent).toContain('chatPageHost === "sidebar-page"');
    expect(mainContent).toContain('taskView === "chat" && !chatPageHostEnabled ? null : taskView');
    expect(mainContent).toContain('!chatPageHostEnabled && storedKeepAliveIds.includes("chat")');
    expect(mainContent).toContain('storedKeepAliveIds.filter((id) => id !== "chat")');
    // The drawer wrapper stays strictly mobile: sidebar placement must mount Chat as a page.
    expect(mainContent).toContain("mobileDrawer={mobileDrawerEnabled ?");
    /*
     * Pre-existing stale assertion repaired here (unrelated to FN-419): the dock Chat entry expresses its restricted
     * capability through `isExpandable`, not `isInline` — the `isInline: () => false` literal this line pinned was
     * removed from the registry by a later change, so the guard was asserting a construct that no longer exists.
     */
    const registry = readAppFile("components/overflowViewRegistry.tsx");
    expect(registry).toContain("isExpandable: () => false");
  });
});
