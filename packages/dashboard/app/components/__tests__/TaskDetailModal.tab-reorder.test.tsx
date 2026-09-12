import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  makeTask,
  mockUsePluginUiSlots,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const originalMatchMedia = window.matchMedia;

function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
    .map((button) => button.textContent?.trim() ?? "");
}

function ids(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".detail-tabs [data-tab-id]"))
    .map((slot) => slot.dataset.tabId ?? "");
}

function detail(projectId = "project-a", task = makeTask({ column: "in-progress" })) {
  return (
    <TaskDetailContent
      embedded
      projectId={projectId}
      task={task}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />
  );
}

function dataTransfer() {
  return { effectAllowed: "none", setData: vi.fn(), getData: vi.fn() };
}

function desktopMatchMedia(matches = true) {
  return vi.fn(() => ({
    matches,
    media: "(min-width: 769px) and (pointer: fine)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("TaskDetailModal tab reorder", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsePluginUiSlots.mockImplementation(() => ({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: null,
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: desktopMatchMedia(),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("réordonne après la cible et restaure l'ordre du projet au remontage", () => {
    const first = render(detail());
    const chat = first.container.querySelector<HTMLElement>('[data-tab-id="planner-chat"]')!;
    const definition = first.container.querySelector<HTMLElement>('[data-tab-id="definition"]')!;
    const transfer = dataTransfer();

    fireEvent.dragStart(chat, { dataTransfer: transfer });
    fireEvent.dragOver(definition, { clientX: 1, dataTransfer: transfer });
    expect(definition).toHaveClass("task-detail-tab-slot--drop-after");
    fireEvent.drop(definition, { clientX: 1, dataTransfer: transfer });

    expect(labels(first.container).slice(0, 3)).toEqual(["Activity", "Plan", "Chat"]);
    expect(first.container.querySelector('[data-testid="task-planner-chat-panel"]')).toBeNull();
    first.unmount();

    const restored = render(detail());
    expect(labels(restored.container).slice(0, 3)).toEqual(["Activity", "Plan", "Chat"]);
    restored.unmount();

    const otherProject = render(detail("project-b"));
    expect(labels(otherProject.container).slice(0, 3)).toEqual(["Activity", "Chat", "Plan"]);
  });

  it("dépose avant la cible selon son milieu horizontal", () => {
    const view = render(detail());
    const terminal = view.container.querySelector<HTMLElement>('[data-tab-id="worktree-terminal"]')!;
    const activity = view.container.querySelector<HTMLElement>('[data-tab-id="chat"]')!;
    const transfer = dataTransfer();
    vi.spyOn(activity, "getBoundingClientRect").mockReturnValue({ left: 100, width: 80 } as DOMRect);

    fireEvent.dragStart(terminal, { dataTransfer: transfer });
    fireEvent(activity, new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 110 }));
    expect(activity).toHaveClass("task-detail-tab-slot--drop-before");
    fireEvent.drop(activity, { dataTransfer: transfer });

    expect(ids(view.container)[0]).toBe("worktree-terminal");
    expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull();
  });

  it("déplace au clavier sans sélectionner l'onglet déplacé", () => {
    const view = render(detail());
    const definition = view.container.querySelector<HTMLElement>('[data-tab-id="definition"]')!;
    const definitionButton = definition.querySelector("button")!;
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");

    fireEvent.keyDown(definition, { key: "ArrowLeft", altKey: true });

    expect(labels(view.container).slice(0, 3)).toEqual(["Activity", "Plan", "Chat"]);
    expect(definitionButton).not.toHaveClass("detail-tab-active");
    expect(screen.getByText(/Plan moved to position 2 of/)).toBeInTheDocument();
  });

  it("nettoie la source et la cible après une annulation sans persister", () => {
    const view = render(detail());
    const before = ids(view.container);
    const chat = view.container.querySelector<HTMLElement>('[data-tab-id="planner-chat"]')!;
    const definition = view.container.querySelector<HTMLElement>('[data-tab-id="definition"]')!;
    const transfer = dataTransfer();

    fireEvent.dragStart(chat, { dataTransfer: transfer });
    fireEvent.dragOver(definition, { clientX: 1, dataTransfer: transfer });
    expect(chat).toHaveClass("task-detail-tab-slot--dragging");
    fireEvent.dragLeave(definition, { dataTransfer: transfer });
    fireEvent.dragEnd(chat, { dataTransfer: transfer });

    expect(ids(view.container)).toEqual(before);
    expect(view.container.querySelector(".task-detail-tab-slot--dragging, .task-detail-tab-slot--drop-before, .task-detail-tab-slot--drop-after")).toBeNull();
    view.unmount();
    expect(ids(render(detail()).container)).toEqual(before);
  });

  it("réordonne Activity sans le sélectionner ni ouvrir son menu", () => {
    const view = render(detail());
    const activity = view.container.querySelector<HTMLElement>('[data-tab-id="chat"]')!;
    const definition = view.container.querySelector<HTMLElement>('[data-tab-id="definition"]')!;
    const transfer = dataTransfer();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.dragStart(activity, { dataTransfer: transfer });
    fireEvent.dragOver(definition, { clientX: 1, dataTransfer: transfer });
    fireEvent.drop(definition, { clientX: 1, dataTransfer: transfer });

    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("detail-tab-active");
    expect(screen.queryByRole("menu", { name: "Activity views" })).toBeNull();
  });

  it("réconcilie PR, Session et plugins autour d'un ordre utilisateur persistant", async () => {
    const originalFetch = globalThis.fetch;
    let pluginVisible = false;
    let sessionVisible = false;
    globalThis.fetch = (async (url) => {
      const taskId = new URL(url.toString(), "http://localhost").searchParams.get("taskId");
      const body = sessionVisible
        ? { sessions: [{ id: `session-${taskId}`, taskId, projectId: "project-a", agentState: "ready", adapterId: "claude", terminationReason: null, autonomyPosture: null }] }
        : { sessions: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    mockUsePluginUiSlots.mockImplementation(() => ({
      slots: [],
      getSlotsForId: vi.fn(() => pluginVisible ? [{
        pluginId: "quality",
        slot: { slotId: "task-detail-tab", label: "Quality", componentPath: "./quality.js" },
      }] : []),
      loading: false,
      error: null,
    }));

    try {
      const view = render(detail("project-a", makeTask({ id: "FN-355-dynamic-1", column: "in-progress" })));
      const definition = view.container.querySelector<HTMLElement>('[data-tab-id="definition"]')!;
      const activity = view.container.querySelector<HTMLElement>('[data-tab-id="chat"]')!;
      const transfer = dataTransfer();
      vi.spyOn(activity, "getBoundingClientRect").mockReturnValue({ left: 100, width: 80 } as DOMRect);

      fireEvent.dragStart(definition, { dataTransfer: transfer });
      fireEvent(activity, new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 110 }));
      fireEvent.drop(activity, { dataTransfer: transfer });
      expect(ids(view.container).slice(0, 3)).toEqual(["definition", "chat", "planner-chat"]);

      pluginVisible = true;
      sessionVisible = true;
      view.rerender(detail("project-a", makeTask({ id: "FN-355-dynamic-2", column: "in-review" })));
      await waitFor(() => expect(ids(view.container)).toContain("terminal"));
      const firstAppearance = ids(view.container);
      expect(firstAppearance.indexOf("definition")).toBeLessThan(firstAppearance.indexOf("chat"));
      expect(firstAppearance.indexOf("pr")).toBeLessThan(firstAppearance.indexOf("comments"));
      expect(firstAppearance.slice(-2)).toEqual(["terminal", "plugin-quality-0"]);
      expect(firstAppearance.filter((id) => id === "pr")).toHaveLength(1);
      expect(firstAppearance.filter((id) => id === "terminal")).toHaveLength(1);
      expect(firstAppearance.filter((id) => id === "plugin-quality-0")).toHaveLength(1);

      pluginVisible = false;
      sessionVisible = false;
      view.rerender(detail("project-a", makeTask({ id: "FN-355-dynamic-3", column: "in-progress" })));
      await waitFor(() => expect(ids(view.container)).not.toContain("terminal"));
      expect(ids(view.container)).not.toContain("pr");
      expect(ids(view.container)).not.toContain("plugin-quality-0");
      expect(ids(view.container).slice(0, 3)).toEqual(["definition", "chat", "planner-chat"]);

      pluginVisible = true;
      sessionVisible = true;
      view.rerender(detail("project-a", makeTask({ id: "FN-355-dynamic-4", column: "in-review" })));
      await waitFor(() => expect(ids(view.container)).toContain("terminal"));
      const reappeared = ids(view.container);
      expect(reappeared.indexOf("definition")).toBeLessThan(reappeared.indexOf("chat"));
      expect(reappeared.indexOf("pr")).toBeLessThan(reappeared.indexOf("comments"));
      expect(reappeared.slice(-2)).toEqual(["terminal", "plugin-quality-0"]);
      for (const conditionalId of ["pr", "terminal", "plugin-quality-0"]) {
        expect(reappeared.filter((id) => id === conditionalId)).toHaveLength(1);
      }

      view.unmount();
      const restored = render(detail("project-a", makeTask({ id: "FN-355-dynamic-5", column: "in-review" })));
      await waitFor(() => expect(ids(restored.container)).toContain("terminal"));
      const remounted = ids(restored.container);
      expect(remounted.indexOf("definition")).toBeLessThan(remounted.indexOf("chat"));
      expect(remounted.indexOf("pr")).toBeLessThan(remounted.indexOf("comments"));
      expect(remounted.slice(-2)).toEqual(["terminal", "plugin-quality-0"]);
      for (const conditionalId of ["pr", "terminal", "plugin-quality-0"]) {
        expect(remounted.filter((id) => id === conditionalId)).toHaveLength(1);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("privilégie le pan tactile tout en sélectionnant par tap", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: desktopMatchMedia(false),
    });
    const view = render(detail());
    const chatSlot = view.container.querySelector<HTMLElement>('[data-tab-id="planner-chat"]')!;
    expect(chatSlot).toHaveAttribute("draggable", "false");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-detail-chat-footer")).toContainElement(
      screen.getByRole("textbox", { name: "Message task chat" }),
    );
  });
});
