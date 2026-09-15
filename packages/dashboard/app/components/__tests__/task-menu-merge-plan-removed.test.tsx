import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Column, Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { ListView } from "../ListView";
import { TaskDetailModal } from "../TaskDetailModal";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import {
  makeTask as makeDetailTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

setupTaskDetailModalHooks();

/*
FNXC:TaskContextMenu 2026-09-15-10:40:
FN-417 removed Plan and Merge & Close / Finish & Close from every TASK CONTEXT MENU, because the
engine plans and merges automatically. This file proves the invariant rather than the single reported
reproduction: the same two absences are asserted on every menu host (board card, list row, an
unwired dock/plugin-shaped card) at desktop AND mobile widths, across the data states that used to
produce each entry (legacy `triage`, renamed intake/hold lanes, no resolved flags at all, auto-merge
review, manual-PR review with and without `prInfo`).

Two non-regressions are asserted in the same file, because "removed everywhere" would otherwise be
satisfiable by deleting too much: Task Detail's review FOOTER button (the single remaining manual
merge command, via the opt-in `includeMergeCompletionAction`) and the manual-PR `Start PR Review`
entry both survive. Every negative assertion is paired with a positive anchor so it cannot pass on an
empty or unmounted menu.
*/

const MERGE_COMPLETION_LABEL = /^(Merge & Close|Finish & Close)$/;

const card = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-417",
  title: "Task menu removal fixture",
  description: "Seed text a Plan handoff used to consume.",
  column: "in-review" as Column,
  status: undefined,
  steps: [],
  currentStep: 0,
  dependencies: [],
  log: [],
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  ...overrides,
}) as Task;

const menuItemNames = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).map((item) => item.textContent?.trim() ?? "");

const expectNoPlanOrMergeItems = (context: string) => {
  const names = menuItemNames();
  expect(names, context).not.toContain("Plan");
  expect(names.filter((name) => MERGE_COMPLETION_LABEL.test(name)), context).toEqual([]);
};

const initialInnerWidth = window.innerWidth;
const initialMatchMedia = window.matchMedia;

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: /max-width:\s*768px/.test(query) && width <= 768,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: initialMatchMedia });
});

const BREAKPOINTS = [1280, 640] as const;

describe("FN-417 task context menus omit Plan and merge completion", () => {
  it.each(BREAKPOINTS)("(a) board card in review offers no merge completion at %ipx", (width) => {
    setViewport(width);
    render(
      <TaskCard
        task={card()}
        onMergeTask={vi.fn(async () => ({ merged: true, branch: "fusion/FN-417" }))}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        taskColumnFlags={{ mergeBlocker: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoPlanOrMergeItems(`card in-review @${width}`);
    // Positive anchor: the menu really opened and is populated.
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it.each(BREAKPOINTS)("(b) board card in every pre-execution shape offers no Plan at %ipx", (width) => {
    setViewport(width);
    const shapes: Array<[string, string, Record<string, boolean> | undefined]> = [
      ["legacy triage id", "triage", undefined],
      ["custom intake lane", "ideas", { intake: true }],
      ["custom hold lane", "waiting", { hold: true }],
      ["no resolved workflow metadata", "backlog", undefined],
    ];

    for (const [label, column, flags] of shapes) {
      const view = render(
        <TaskCard
          task={card({ column: column as Column })}
          onDeleteTask={noopDelete}
          onOpenDetail={noop}
          addToast={noop}
          taskColumnFlags={flags as never}
          planningWorkflowId="builtin:coding"
        />,
      );

      // Both entry points: the visible ⋯ button and a right-click on the card.
      fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
      expectNoPlanOrMergeItems(`${label} button @${width}`);
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });

      fireEvent.contextMenu(view.container.querySelector(".card")!, { clientX: 24, clientY: 28 });
      expectNoPlanOrMergeItems(`${label} contextMenu @${width}`);
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it.each(BREAKPOINTS)("(c/d) list rows offer neither merge completion nor Plan at %ipx", async (width) => {
    setViewport(width);
    const projectId = `project-fn-417-${width}`;
    writeBoardWorkflowsCache(projectId, {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{
        id: "builtin:coding",
        name: "Coding",
        columns: [
          { id: "triage", name: "Planning", flags: { intake: true, hold: true } },
          { id: "in-review", name: "In Review", flags: { mergeBlocker: true } },
        ],
      }],
      taskWorkflowIds: { "FN-417": "builtin:coding", "FN-417-plan": "builtin:coding" },
    });

    render(
      <ListView
        tasks={[card(), card({ id: "FN-417-plan", column: "triage" as Column })]}
        onMergeTask={async () => ({ merged: false })}
        onDeleteTask={async () => card()}
        onOpenDetail={noop}
        addToast={noop}
        projectId={projectId}
      />,
    );

    for (const id of ["FN-417", "FN-417-plan"]) {
      await waitFor(() => expect(document.querySelector(`[data-id='${id}']`)).toBeTruthy());
      fireEvent.contextMenu(document.querySelector<HTMLElement>(`[data-id='${id}']`)!, { clientX: 40, clientY: 40 });
      await waitFor(() => expect(document.querySelectorAll("[role='menuitem']").length).toBeGreaterThan(0));
      expectNoPlanOrMergeItems(`list row ${id} @${width}`);
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it("(e) Task Detail keeps its review footer merge command", () => {
    render(
      <TaskDetailModal
        initialTab="review"
        task={makeDetailTask({ id: "FN-417-detail", column: "in-review" as Column })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Merge & Close" })).toBeInTheDocument();
  });

  it("(f/i) an unwired dock/plugin-shaped card renders no menu shell at all", () => {
    const { container } = render(
      <TaskCard task={card({ column: "triage" as Column })} onOpenDetail={noop} addToast={noop} />,
    );

    expect(screen.queryByRole("button", { name: "Task actions" })).toBeNull();
    fireEvent.contextMenu(container.querySelector(".card")!, { clientX: 20, clientY: 20 });
    expect(document.querySelector(".task-context-menu")).toBeNull();
    expectNoPlanOrMergeItems("unwired dock card");
    // Positive anchor: the card itself rendered, so the absences are not an unmounted-tree artifact.
    expect(container.querySelector(".card")).not.toBeNull();
  });

  it("(g) the manual-PR flow keeps Start PR Review", () => {
    render(
      <TaskCard
        task={card()}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        autoMerge={false}
        mergeStrategy="pull-request"
        taskColumnFlags={{ mergeBlocker: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expect(screen.getByRole("menuitem", { name: "Start PR Review" })).toBeInTheDocument();
    expectNoPlanOrMergeItems("manual PR flow, no prInfo");
  });

  it("(h) an already-merged PR offers no Finish & Close", () => {
    render(
      <TaskCard
        task={card({ prInfo: { status: "merged", number: 7, url: "https://example.test/pr/7" } as never })}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        autoMerge={false}
        mergeStrategy="pull-request"
        taskColumnFlags={{ mergeBlocker: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoPlanOrMergeItems("manual PR flow, merged prInfo");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("(j) the retained oversight workflow prop no longer feeds any menu entry", () => {
    const { container } = render(
      <TaskCard
        task={card({ column: "triage" as Column })}
        onDeleteTask={noopDelete}
        onOpenDetail={noop}
        addToast={noop}
        planningWorkflowId="builtin:coding"
        taskColumnFlags={{ intake: true, hold: true }}
      />,
    );

    expect(container.querySelector(".card")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    expectNoPlanOrMergeItems("card carrying planningWorkflowId");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});
