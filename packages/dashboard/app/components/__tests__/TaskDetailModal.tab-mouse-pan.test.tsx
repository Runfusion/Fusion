import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  mockUsePluginUiSlots,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import {
  AppTaskPopoutContent,
  ListSplitTaskDetailHost,
  MainPanelTaskDetailHost,
  RightDockTaskDetailHost,
} from "../TaskDetailHostBoundaries";

setupTaskDetailModalHooks();

const task = makeTask({ id: "FN-359-pan", column: "in-progress", worktree: "/workspace/FN-359-pan" });
const sharedProps = {
  task,
  initialTab: "definition" as const,
  projectId: "project-a",
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function tabLabels(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
    .map((button) => button.textContent?.trim() ?? "");
}

function configureScroller(root: ParentNode = document, overflow = true) {
  const scroller = root.querySelector<HTMLElement>(".detail-tabs")!;
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: overflow ? 800 : 200 },
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  scroller.scrollLeft = 100;
  return scroller;
}

function pan(target: HTMLElement, scroller: HTMLElement, fromX: number, toX: number, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerDown(target, { pointerId, pointerType, button: 0, clientX: fromX, clientY: 50 });
  fireEvent.pointerMove(target, { pointerId, pointerType, clientX: toX, clientY: 50 });
  fireEvent.pointerUp(scroller, { pointerId, pointerType, button: 0, clientX: toX, clientY: 50 });
}

function embeddedContent(): ReactElement {
  return <TaskDetailContent {...sharedProps} embedded onRequestClose={noop} />;
}

beforeEach(() => {
  localStorage.clear();
  mockUsePluginUiSlots.mockReturnValue({
    slots: [],
    getSlotsForId: vi.fn(() => []),
    loading: false,
    error: null,
  });
});

describe("Task Detail tab mouse pan", () => {
  it("fait défiler une rangée overflowée sans changer l'ordre, l'onglet actif ni le stockage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(embeddedContent());
    const scroller = configureScroller();
    const initialOrder = tabLabels();
    const chat = screen.getByRole("button", { name: "Chat" });

    pan(chat, scroller, 100, 140);

    expect(scroller.scrollLeft).toBe(60);
    expect(tabLabels()).toEqual(initialOrder);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    expect(chat).not.toHaveClass("detail-tab-active");
    expect(setItem.mock.calls.some(([key]) => String(key).includes("kb-task-detail-tab-order"))).toBe(false);

    fireEvent.click(chat);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    fireEvent.click(chat);
    expect(chat).toHaveClass("detail-tab-active");

    scroller.scrollLeft = 100;
    pan(chat, scroller, 100, 70, 2);
    expect(scroller.scrollLeft).toBe(130);
  });

  it("pan sur Activity ne sélectionne rien et n'ouvre pas son menu", () => {
    render(embeddedContent());
    const scroller = configureScroller();
    const activity = screen.getByRole("button", { name: "Activity" });

    pan(activity, scroller, 100, 40);
    fireEvent.click(activity);

    expect(scroller.scrollLeft).toBe(160);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull();
  });

  it("laisse les gestes du menu Activity portaled à leur interaction native", () => {
    render(embeddedContent());
    const scroller = configureScroller();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const feed = screen.getByRole("menuitem", { name: "Feed" });

    expect(scroller).not.toContainElement(feed);
    pan(feed, scroller, 100, 40);
    expect(scroller.scrollLeft).toBe(100);

    fireEvent.click(feed);
    expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Feed" })).toBeInTheDocument();
  });

  it("laisse sans overflow, touch et pen au comportement natif", () => {
    render(embeddedContent());
    const scroller = configureScroller(document, false);
    const chat = screen.getByRole("button", { name: "Chat" });

    pan(chat, scroller, 100, 40);
    pan(chat, scroller, 100, 40, 2, "touch");
    pan(chat, scroller, 100, 40, 3, "pen");

    expect(scroller.scrollLeft).toBe(100);
    expect(scroller).not.toHaveClass("is-mouse-panning");
    fireEvent.click(chat);
    expect(chat).toHaveClass("detail-tab-active");
  });

  it.each(["{malformed", JSON.stringify(["unknown", "definition", "definition"]), "null"])(
    "ignore une ancienne préférence %s",
    (legacyValue) => {
      localStorage.setItem("kb:project-a:kb-task-detail-tab-order", legacyValue);
      render(embeddedContent());
      expect(tabLabels().slice(0, 4)).toEqual(["Activity", "Chat", "Plan", "Changes"]);
    },
  );

  it("ignore toute ancienne préférence remplie et conserve l'ordre canonique conditionnel et plugin", () => {
    localStorage.setItem("kb:project-a:kb-task-detail-tab-order", JSON.stringify([
      "plugin-quality-0", "pr", "definition", "definition", "unknown", "chat",
    ]));
    mockUsePluginUiSlots.mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => [{
        pluginId: "quality",
        slot: { slotId: "task-detail-tab", label: "Quality", componentPath: "./quality.js" },
      }]),
      loading: false,
      error: null,
    });

    render(
      <TaskDetailContent
        {...sharedProps}
        task={makeTask({ id: "FN-359-conditional", column: "in-review", worktree: "/workspace/FN-359-conditional" })}
        embedded
      />,
    );

    const labels = tabLabels();
    expect(labels.slice(0, 4)).toEqual(["Activity", "Chat", "Plan", "Changes"]);
    expect(labels.indexOf("Pull Request")).toBeLessThan(labels.indexOf("Comments"));
    expect(labels.slice(-2)).toEqual(["Terminal", "Quality"]);
    expect(labels.filter((label) => label === "Plan")).toHaveLength(1);
  });

  it.each([
    ["modal", () => <TaskDetailModal {...sharedProps} onClose={noop} />],
    ["Board panel", () => <MainPanelTaskDetailHost {...sharedProps} onNavigateToBoard={noop} />],
    ["List split", () => <ListSplitTaskDetailHost {...sharedProps} onClearSelection={noop} />],
    ["right dock", () => <RightDockTaskDetailHost {...sharedProps} onCloseDock={noop} />],
    ["pop-out", () => <AppTaskPopoutContent {...sharedProps} onRemoveWindow={noop} />],
  ])("partage le même geste dans l'hôte %s", (_name, host) => {
    render(host());
    const scroller = configureScroller();
    const before = tabLabels();

    pan(screen.getByRole("button", { name: "Chat" }), scroller, 100, 40);

    expect(scroller.scrollLeft).toBe(160);
    expect(tabLabels()).toEqual(before);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
  });
});
