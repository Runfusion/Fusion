import { useEffect } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { listComponentFiles, readAppFile } from "../../../test/cssFixture";
import type { MainContentProps } from "../types";
import { KEEP_ALIVE_MAIN_VIEW_IDS, MainViewKeepAlive } from "../MainViewKeepAlive";

const activeByView = vi.hoisted(() => ({
  board: [] as boolean[],
  list: [] as boolean[],
  chat: [] as boolean[],
  markRead: vi.fn(),
}));

vi.mock("../../Board", () => ({
  Board: ({ active }: { active?: boolean }) => {
    const isActive = active ?? true;
    activeByView.board.push(isActive);
    const slot = document.getElementById("header-workflow-slot");
    return (
      <>
        <output data-testid="board-child" data-active={String(isActive)} />
        {isActive && slot ? createPortal(<output data-testid="board-header-control">Board controls</output>, slot) : null}
      </>
    );
  },
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
  it("keeps visited children mounted and derives their active value from one resolved id", () => {
    const result = renderHost("board");

    expect(screen.getByTestId("board-keep-alive")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("board-child")).toHaveAttribute("data-active", "true");
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
    expect(screen.getByTestId("board-child")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("chat-keep-alive")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("chat-child")).toHaveAttribute("data-active", "true");
  });

  it("hides and deactivates every mounted entry when no main view is active", () => {
    const slot = createHeaderSlot();
    activeByView.markRead.mockClear();
    renderHost(null);

    for (const id of KEEP_ALIVE_MAIN_VIEW_IDS) {
      expect(screen.getByTestId(`${id}-keep-alive`)).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByTestId(`${id}-child`)).toHaveAttribute("data-active", "false");
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
    expect(slot.querySelector("[data-testid='board-header-control']")).toBeNull();
    slot.remove();
  });

  it("keeps the production Chat and workflow-header host census explicit", () => {
    const sourceFiles = productionAppSourceFiles();
    const chatHosts = sourceFiles
      .filter((file) => readAppFile(file).includes("<ChatView"))
      .sort();
    expect(chatHosts).toEqual([
      "App.tsx",
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
    expect(quickChatHost).toContain("active={quickChatOpen}");
  });
});
