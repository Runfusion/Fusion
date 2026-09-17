import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  openTaskDetailActionsMenu,
  resetTaskDetailFetchMock,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import { MobileDrawer } from "../MobileDrawer";
import {
  ListSplitTaskDetailHost,
  MainPanelTaskDetailHost,
  RightDockTaskDetailHost,
} from "../TaskDetailHostBoundaries";
import { readAppFile } from "../../test/cssFixture";
import * as dashboardApi from "../../api";
import type { TaskDetail } from "@fusion/core";

setupTaskDetailModalHooks();

/*
FNXC:TaskDetailHeaderActions 2026-09-16-18:07 (FN-470):
The operator reported the Task Detail header as cluttered: every command sat side by side at the top.
These cases pin the replacement contract — the "…" overflow is the only header action surface, the close
control (and, on a phone without the drawer opt-in, the Back arrow) is the only directly visible control,
and every relocated command keeps its historical test id inside the opened menu.
*/

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setViewport(mode: "mobile" | "desktop", { drawers = true }: { drawers?: boolean } = {}) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 375 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query.includes("max-width") || query.includes("max-height")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  document.documentElement.dataset.viewportMode = mode;
  if (mode === "mobile" && drawers) document.documentElement.dataset.mobileDrawers = "true";
  else delete document.documentElement.dataset.mobileDrawers;
}

const baseHandlers = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

function lifecycleHandlers() {
  return {
    onDuplicateTask: vi.fn(async () => ({}) as never),
    onRetryTask: vi.fn(async () => ({}) as never),
    onResetTask: vi.fn(async () => ({}) as never),
    onPauseTask: vi.fn(async () => ({}) as never),
    onUnpauseTask: vi.fn(async () => ({}) as never),
  };
}

function headerActionsGroup(): HTMLElement {
  return document.querySelector<HTMLElement>(".modal-header-actions")!;
}

/** Buttons rendered directly in the header group, excluding anything inside the opened overflow menu. */
function directHeaderButtons(): HTMLButtonElement[] {
  const group = headerActionsGroup();
  return Array.from(group.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.closest(".detail-actions-menu") === null);
}

function accessibleNames(buttons: HTMLElement[]): string[] {
  return buttons.map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim());
}

function renderModal(task: TaskDetail, overrides: Record<string, unknown> = {}) {
  vi.mocked(dashboardApi.fetchTaskDetail).mockResolvedValue(task);
  return render(
    <TaskDetailModal
      task={task}
      initialTab="definition"
      onClose={noop}
      {...baseHandlers}
      {...(overrides as object)}
    />,
  );
}

describe("Task Detail header overflow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTaskDetailFetchMock();
    setViewport("desktop");
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    delete document.documentElement.dataset.viewportMode;
    delete document.documentElement.dataset.mobileDrawers;
  });

  /*
  Case (a) — the exact reported reproduction: a mutable task with every lifecycle handler wired used to
  expose at least eight header controls.
  */
  it("exposes only the Actions trigger and Close in the header of a fully wired task", () => {
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const buttons = directHeaderButtons();
    expect(accessibleNames(buttons)).toEqual(["Actions", "Close"]);
    for (const name of accessibleNames(buttons)) expect(name).not.toBe("");
    expect(document.querySelector('[data-testid^="task-detail-header-action-"]')).toBeNull();
    expect(document.querySelector(".modal-edit-btn")).toBeNull();
    expect(document.querySelector('[data-testid="task-detail-pop-out"]')).toBeNull();
  });

  it("keeps every relocated command inside the opened menu exactly once", async () => {
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const menu = await openTaskDetailActionsMenu();
    for (const testId of [
      "task-detail-header-action-duplicate",
      "task-detail-header-action-retry",
      "task-detail-header-action-delete",
      "task-detail-header-action-pause",
      "task-detail-header-action-reset",
      "task-detail-header-action-edit",
      "task-detail-pop-out",
    ]) {
      expect(within(menu).getAllByTestId(testId)).toHaveLength(1);
    }
  });

  it("omits terminal-column lifecycle entries while retaining Duplicate", async () => {
    renderModal(makeTask({ column: "done" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).getByTestId("task-detail-header-action-duplicate")).toBeInTheDocument();
    expect(within(menu).queryByTestId("task-detail-header-action-retry")).toBeNull();
    expect(within(menu).queryByTestId("task-detail-header-action-reset")).toBeNull();
    expect(within(menu).queryByTestId("task-detail-header-action-pause")).toBeNull();
    expect(within(menu).queryByTestId("task-detail-header-action-unpause")).toBeNull();
  });

  /* Case (c) — the relocated entries are APPENDED, so the documented quick-control head order survives. */
  it("appends the relocated entries after the quick controls and keeps the opening focus", async () => {
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const menu = await openTaskDetailActionsMenu();
    const ordered = Array.from(menu.querySelectorAll<HTMLElement>("[data-testid]"))
      .map((node) => node.getAttribute("data-testid")!);
    const indexOf = (testId: string) => ordered.indexOf(testId);

    expect(indexOf("detail-inline-attach")).toBe(0);
    expect(indexOf("detail-inline-attach")).toBeLessThan(indexOf("task-detail-header-action-duplicate"));
    expect(indexOf("task-detail-header-action-duplicate")).toBeLessThan(indexOf("task-detail-header-action-edit"));
    expect(indexOf("task-detail-header-action-edit")).toBeLessThan(indexOf("task-detail-pop-out"));
    expect(ordered.at(-1)).toBe("task-detail-pop-out");
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByTestId("detail-inline-attach")));
  });

  it("pops the task out from the menu and closes the menu", async () => {
    const onPopOut = vi.fn();
    const task = makeTask({ column: "todo" });
    renderModal(task, { ...lifecycleHandlers(), onPopOut });

    const menu = await openTaskDetailActionsMenu();
    fireEvent.click(within(menu).getByTestId("task-detail-pop-out"));

    expect(onPopOut).toHaveBeenCalledTimes(1);
    expect(onPopOut.mock.calls[0][0]).toMatchObject({ id: task.id });
    await waitFor(() => expect(document.querySelector(".detail-actions-menu")).toBeNull());
  });

  it("enters edit mode from the menu and then renders only Close in the header", async () => {
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const menu = await openTaskDetailActionsMenu();
    fireEvent.click(within(menu).getByTestId("task-detail-header-action-edit"));

    await waitFor(() => expect(document.querySelector(".modal-edit-form")).toBeInTheDocument());
    expect(document.querySelector(".detail-actions-menu")).toBeNull();
    expect(accessibleNames(directHeaderButtons())).toEqual(["Close"]);
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  /* Case (e) — the phone keeps its Back arrow as the only exit and never offers Pop out. */
  it("keeps only Back and the Actions trigger on a phone without the drawer opt-in", async () => {
    setViewport("mobile", { drawers: false });
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn() });

    const header = document.querySelector<HTMLElement>(".task-detail-content > .modal-header")!;
    const back = within(header).getByRole("button", { name: "Back" });
    expect(header.firstElementChild).toBe(back);
    expect(accessibleNames(directHeaderButtons())).toEqual(["Actions"]);
    expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();

    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).queryByTestId("task-detail-pop-out")).toBeNull();
    expect(within(menu).getByTestId("task-detail-header-action-duplicate")).toBeInTheDocument();
  });

  it("keeps only the Actions trigger in phone drawer presentation", async () => {
    setViewport("mobile");
    renderModal(makeTask({ column: "todo" }), { ...lifecycleHandlers(), onPopOut: vi.fn(), mobileDrawer: true });

    const header = document.querySelector<HTMLElement>(".task-detail-content > .modal-header")!;
    expect(within(header).queryByRole("button", { name: "Back" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
    expect(accessibleNames(directHeaderButtons())).toEqual(["Actions"]);

    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).queryByTestId("task-detail-pop-out")).toBeNull();
  });

  /* Case (f) — every embedded host shares the same header producer. */
  it("holds at most two direct header controls in every Task Detail host", () => {
    const hostProps = {
      task: makeTask({ id: "FN-470-DETAIL", column: "todo" }),
      initialTab: "definition" as const,
      ...baseHandlers,
      ...lifecycleHandlers(),
      onPopOut: vi.fn(),
    };

    const hosts: Array<readonly [string, React.ReactElement]> = [
      ["modal", <TaskDetailModal key="modal" {...hostProps} onClose={noop} />],
      ["main panel", <MainPanelTaskDetailHost key="panel" {...hostProps} onNavigateToBoard={noop} />],
      ["list split", <ListSplitTaskDetailHost key="list" {...hostProps} onClearSelection={noop} />],
      ["right dock", <RightDockTaskDetailHost key="dock" {...hostProps} onCloseDock={noop} />],
      ["mobile drawer", <TaskDetailModal key="drawer" {...hostProps} onClose={noop} mobileDrawer />],
      [
        "shared drawer shell",
        <MobileDrawer key="shell" open title="Task" onClose={noop}>
          <TaskDetailModal {...hostProps} onClose={noop} mobileDrawer />
        </MobileDrawer>,
      ],
    ];

    for (const [, host] of hosts) {
      const view = render(host);
      const buttons = directHeaderButtons();
      expect(buttons.length).toBeLessThanOrEqual(2);
      for (const name of accessibleNames(buttons)) {
        expect(["Actions", "Close", "Back"]).toContain(name);
      }
      expect(document.querySelector('[data-testid^="task-detail-header-action-"]')).toBeNull();
      view.unmount();
    }
  });

  /*
  Case (g) — a host wiring no lifecycle handler, no pop-out and a non-editable column leaves no empty shell:
  the overflow still carries the unconditional quick controls, and nothing else appears in the header.
  */
  it("renders no lifecycle, edit, or pop-out entry when their hosts wire nothing", async () => {
    renderModal(makeTask({ column: "done" }));

    expect(accessibleNames(directHeaderButtons())).toEqual(["Actions", "Close"]);
    const menu = await openTaskDetailActionsMenu();
    expect(within(menu).queryByTestId("task-detail-header-action-duplicate")).toBeNull();
    expect(within(menu).queryByTestId("task-detail-header-action-edit")).toBeNull();
    expect(within(menu).queryByTestId("task-detail-pop-out")).toBeNull();
    for (const button of Array.from(headerActionsGroup().querySelectorAll("button"))) {
      expect((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()).not.toBe("");
    }
  });

  /* Case (h) — a disabled descriptor stays rendered in the menu and refuses selection. */
  it("renders a disabled menu entry without running its handler", async () => {
    let releaseUpload: (() => void) | undefined;
    vi.mocked(dashboardApi.uploadAttachment).mockImplementation(() => new Promise<never>((resolve) => {
      releaseUpload = () => resolve(undefined as never);
    }));
    renderModal(makeTask({ column: "todo" }), lifecycleHandlers());

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const clickSpy = vi.spyOn(fileInput, "click");
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "note.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(vi.mocked(dashboardApi.uploadAttachment)).toHaveBeenCalledTimes(1));

    const menu = await openTaskDetailActionsMenu();
    const attach = within(menu).getByTestId("detail-inline-attach");
    expect(attach).toBeDisabled();
    fireEvent.click(attach);
    expect(clickSpy).not.toHaveBeenCalled();
    releaseUpload?.();
  });

  /* Case (k) — the removed affordance leaves no residual construct in source or stylesheet. */
  it("leaves no direct header action construct behind in source or CSS", () => {
    const source = readAppFile("components/TaskDetailModal.tsx");
    expect(source).not.toContain("renderTaskDetailActionIcon");
    expect(source).not.toContain("modal-edit-btn");

    const css = readAppFile("components/TaskDetailModal.css");
    expect(css).not.toMatch(/\.task-detail-header-action--danger\s*\{/);
    expect(css).toContain(":is(.task-detail-header-action, .modal-close, .task-detail-header-back-btn)");
  });
});
