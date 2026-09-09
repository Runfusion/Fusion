/*
FNXC:WorkflowResolvedColumns 2026-07-31-02:20:
THE DOCK'S `renderTaskCard` IS THE SECOND PRODUCER OF THIS AFFORDANCE, AND IT HAD NO TEST.

#3025 fixed both producers of a dock/plugin-rendered `TaskCard` — `MainContent.renderTaskCard` and
this hook's — so that the card receives `taskColumnFlags` instead of resolving nothing and falling
back to legacy lane ids for every role helper inside it (Revert affordances, progress, the
elapsed-time indicator, the planning badge).

Its test covered `MainContent` only. MEASURED: deleting
`taskColumnFlags={input.columnFlagsByTaskId?.get(task.id)}` from `useRightDockController` left the
whole suite green — `MainContent.graph-popout` 6/6, `RightDock` 33/33, `TaskCard.host-inventory` 1/1.
That PR's own revert-check note says dropping the prop "from either `renderTaskCard`" would show up;
for this producer it did not.

So the pair could silently become a single again, on the producer that draws cards into the right
dock where an operator actually sees them. One affordance with two producers needs two assertions —
the Surface Enumeration rule applies to the coverage, not only to the fix.

Driven through the hook's real `renderTaskCard`, captured off the `renderProps` the controller hands
`RightDock`: that function IS the contract this pins. `RightDock` itself is stubbed so the assertion
cannot fail for unrelated dock plumbing.
*/

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { useRightDockController } from "../useRightDockController";

/* Capture the renderProps the controller builds; `renderTaskCard` is not on the returned controller. */
const captured: { renderTaskCard?: (task: Task) => React.ReactNode } = {};
vi.mock("../RightDock", async (importOriginal) => ({
  /* Keep the module's real exports — the controller imports its persistence helpers from here, and a
     bare factory silently drops them ("No readStoredRightDockOpen export is defined on the mock"). */
  ...(await importOriginal<Record<string, unknown>>()),
  RightDock: ({ renderProps }: { renderProps: { renderTaskCard?: (task: Task) => React.ReactNode } }) => {
    captured.renderTaskCard = renderProps?.renderTaskCard;
    return <aside data-testid="dock" />;
  },
  RightDockExpandModal: () => null,
}));

/* The probe: absent means the card resolved nothing, which is the pre-#3025 behaviour. */
const seen: (Record<string, boolean | undefined> | undefined)[] = [];
vi.mock("../TaskCard", () => ({
  TaskCard: ({ taskColumnFlags }: { taskColumnFlags?: Record<string, boolean | undefined> }) => {
    seen.push(taskColumnFlags);
    return <article data-testid="dock-card" />;
  },
}));

const task = {
  id: "KB-DOCK-1",
  title: "a docked card",
  description: "t",
  column: "shipped",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  steps: [],
} as unknown as Task;

/** `shipped` is this board's complete lane — it simply is not called `done`. */
const SHIPPED_IS_COMPLETE = { complete: true } as const;

const noop = () => {};
const asyncNoop = async () => task;

function controllerInput(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    projectId: "proj-1",
    addToast: noop,
    settingsLoaded: true,
    researchReadinessVersion: 0,
    tasks: [task],
    columnFlagsByTaskId: new Map([[task.id, SHIPPED_IS_COMPLETE]]),
    workflowSteps: [],
    subscribePluginEvents: () => () => {},
    openDetailTask: noop,
    openTaskPopup: noop,
    openMobileTasksInPopup: false,
    openFileInBrowser: noop,
    onMoveTask: asyncNoop,
    onDeleteTask: asyncNoop,
    onMergeTask: asyncNoop,
    openSettings: noop,
    ...overrides,
  } as never;
}

/** Renders the hook and draws one card through the real `renderTaskCard`. */
function renderDockCard(input = controllerInput()) {
  captured.renderTaskCard = undefined;
  function Harness() {
    const controller = useRightDockController(input);
    return <>{controller.dock}{captured.renderTaskCard ? captured.renderTaskCard(task) : null}</>;
  }
  const result = render(<Harness />);
  /* First pass mounts the dock and captures the callback; the second draws the card with it. */
  result.rerender(<Harness />);
  return result;
}

describe("the dock's renderTaskCard hands the card its resolved column traits", () => {
  it("passes the task's own flags through to the card", () => {
    seen.length = 0;
    renderDockCard();

    /* Without the wiring this is `undefined` and every role helper in the card reads legacy ids. */
    expect(seen[seen.length - 1]).toEqual(SHIPPED_IS_COMPLETE);
  });

  /*
  The paired negative: a card with no resolved entry must receive `undefined`, not a fabricated
  object. The role helpers document that fallback, and inventing flags here would make an unresolved
  card claim traits its board never declared — worse than the legacy default it replaces.
  */
  it("passes undefined when the board has resolved no traits for that task", () => {
    seen.length = 0;
    renderDockCard(controllerInput({ columnFlagsByTaskId: new Map() }));

    expect(seen[seen.length - 1]).toBeUndefined();
  });
});
