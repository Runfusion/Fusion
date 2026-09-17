import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@fusion/core";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's Boost affordance on the real TaskCard. The assertions are behavioural: which cards offer
the action, what the click actually sends, and \u2014 critically \u2014 what the click must NOT do (open the
detail, start a drag, or paint a false success after a refusal).
*/

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

const { TaskCard } = await import("../TaskCard");
const { CostBadgeProvider } = await import("../../context/CostBadgeContext");

afterEach(() => cleanup());

const ENTRY_AT = "2026-09-17T10:00:00.000Z";

function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: ENTRY_AT,
    updatedAt: ENTRY_AT,
    columnMovedAt: ENTRY_AT,
    ...patch,
  } as Task;
}

const HOLD_FLAGS = { hold: true } as const;
const WIP_FLAGS = { countsTowardWip: true } as const;
const COMPLETE_FLAGS = { complete: true } as const;
const IDEAS_FLAGS = { intake: true, manualIntake: true } as const;
const REVIEW_FLAGS = { mergeBlocker: true } as const;

function renderCard(task: Task, props: Record<string, unknown> = {}) {
  return render(
    <CostBadgeProvider value={{ enabled: false }}>
      <TaskCard
        task={task}
        onOpenDetail={props.onOpenDetail as never ?? vi.fn()}
        addToast={props.addToast as never ?? vi.fn()}
        taskColumnFlags={props.taskColumnFlags as never ?? HOLD_FLAGS}
        onBoostTask={props.onBoostTask as never}
        {...props}
      />
    </CostBadgeProvider>,
  );
}

describe("TaskCard Boost — availability", () => {
  it("offers Boost on a waiting planning card", () => {
    renderCard(makeTask("FN-1"), { onBoostTask: vi.fn() });
    expect(screen.getByTestId("card-boost-FN-1")).toBeTruthy();
  });

  it("offers Boost on a queued WIP card that is currently blocked", () => {
    renderCard(makeTask("FN-1", { column: "in-progress", status: "queued", overlapBlockedBy: "FN-9" }), {
      taskColumnFlags: WIP_FLAGS,
      onBoostTask: vi.fn(),
    });
    expect(screen.getByTestId("card-boost-FN-1")).toBeTruthy();
  });

  it("offers Boost on a paused card, because a pause is a queue wait and Boost clears nothing", () => {
    renderCard(makeTask("FN-1", { paused: true, userPaused: true }), { onBoostTask: vi.fn() });
    expect(screen.getByTestId("card-boost-FN-1")).toBeTruthy();
  });

  it("withholds Boost on manual intake (Ideas), Complete, and an unresolved column", () => {
    for (const flags of [IDEAS_FLAGS, COMPLETE_FLAGS, undefined]) {
      cleanup();
      renderCard(makeTask("FN-1", { column: flags === COMPLETE_FLAGS ? "done" : "todo" }), {
        taskColumnFlags: flags,
        onBoostTask: vi.fn(),
      });
      expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
    }
  });

  it("withholds Boost on a card that is actively being worked on", () => {
    renderCard(
      makeTask("FN-1", { column: "in-progress", status: "executing", sessionFile: "/tmp/s", checkedOutBy: "agent-1" }),
      { taskColumnFlags: WIP_FLAGS, onBoostTask: vi.fn() },
    );
    expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
  });

  it("withholds Boost on a review card that is a purely human wait with auto-merge off", () => {
    renderCard(makeTask("FN-1", { column: "in-review", autoMerge: false }), {
      taskColumnFlags: REVIEW_FLAGS,
      autoMergeEnabled: false,
      onBoostTask: vi.fn(),
    });
    expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
  });

  /*
  FNXC:TaskQueueOrder 2026-09-17-13:51:
  Auto-merge OFF alone does not make a review lane a human-only wait. While an enabled pre-merge gate
  still has no terminal result, the automatic review queue is real and the card keeps Boost — the
  case the previous availability test above deliberately contrasts with.
  */
  it("keeps Boost on a review card whose automatic gate has not run yet, even with auto-merge off", () => {
    renderCard(
      makeTask("FN-1", {
        column: "in-review",
        autoMerge: false,
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [],
      }),
      { taskColumnFlags: REVIEW_FLAGS, autoMergeEnabled: false, onBoostTask: vi.fn() },
    );
    expect(screen.getByTestId("card-boost-FN-1")).toBeTruthy();
  });

  it("keeps Boost while one enabled gate has not run, and drops it once every gate is terminal", () => {
    renderCard(
      makeTask("FN-1", {
        column: "in-review",
        autoMerge: false,
        enabledWorkflowSteps: ["code-review", "completion-summary"],
        workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] as never,
      }),
      { taskColumnFlags: REVIEW_FLAGS, autoMergeEnabled: false, onBoostTask: vi.fn() },
    );
    expect(screen.getByTestId("card-boost-FN-1")).toBeTruthy();

    cleanup();
    renderCard(
      makeTask("FN-1", {
        column: "in-review",
        autoMerge: false,
        enabledWorkflowSteps: ["code-review"],
        workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] as never,
      }),
      { taskColumnFlags: REVIEW_FLAGS, autoMergeEnabled: false, onBoostTask: vi.fn() },
    );
    expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
  });

  it("withholds Boost when no host supplies the callback, leaving no empty shell", () => {
    const { container } = renderCard(makeTask("FN-1"));
    expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
    expect(container.querySelector(".card-boost-row")).toBeNull();
  });

  it("withholds Boost on a soft-deleted row", () => {
    renderCard(makeTask("FN-1", { deletedAt: ENTRY_AT }), { onBoostTask: vi.fn() });
    expect(screen.queryByTestId("card-boost-FN-1")).toBeNull();
  });
});

describe("TaskCard Boost — interaction", () => {
  it("sends the card's current stay as the precondition", async () => {
    const onBoostTask = vi.fn(async () => makeTask("FN-1"));
    renderCard(makeTask("FN-1"), { onBoostTask });
    fireEvent.click(screen.getByTestId("card-boost-FN-1"));
    await waitFor(() => expect(onBoostTask).toHaveBeenCalledWith("FN-1", {
      expectedColumn: "todo",
      expectedColumnEntryAt: ENTRY_AT,
    }));
  });

  it("does not open the task detail when Boost is clicked", async () => {
    const onOpenDetail = vi.fn();
    const onBoostTask = vi.fn(async () => makeTask("FN-1"));
    renderCard(makeTask("FN-1"), { onBoostTask, onOpenDetail });
    fireEvent.click(screen.getByTestId("card-boost-FN-1"));
    await waitFor(() => expect(onBoostTask).toHaveBeenCalled());
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("is reachable and activatable from the keyboard", async () => {
    const onBoostTask = vi.fn(async () => makeTask("FN-1"));
    renderCard(makeTask("FN-1"), { onBoostTask });
    const button = screen.getByTestId("card-boost-FN-1") as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onBoostTask).toHaveBeenCalledTimes(1));
  });

  it("issues exactly one request for a double click while the first is in flight", async () => {
    let resolveFirst: (task: Task) => void = () => {};
    const onBoostTask = vi.fn(() => new Promise<Task>((resolve) => { resolveFirst = resolve; }));
    renderCard(makeTask("FN-1"), { onBoostTask });
    const button = screen.getByTestId("card-boost-FN-1");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onBoostTask).toHaveBeenCalledTimes(1);
    resolveFirst(makeTask("FN-1"));
    await waitFor(() => expect((screen.getByTestId("card-boost-FN-1") as HTMLButtonElement).disabled).toBe(false));
  });

  it("surfaces a refusal as an error and never paints a false success", async () => {
    const addToast = vi.fn();
    const onBoostTask = vi.fn(async () => { throw new Error("409"); });
    renderCard(makeTask("FN-1"), { onBoostTask, addToast });
    fireEvent.click(screen.getByTestId("card-boost-FN-1"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), "error"));
    // The button returns to its idle state rather than staying stuck in "Boosting…".
    await waitFor(() => expect((screen.getByTestId("card-boost-FN-1") as HTMLButtonElement).disabled).toBe(false));
  });

  it("exposes a task-specific accessible name", () => {
    renderCard(makeTask("FN-42"), { onBoostTask: vi.fn() });
    const label = screen.getByTestId("card-boost-FN-42").getAttribute("aria-label") ?? "";
    expect(label).toContain("FN-42");
  });
});

describe("TaskCard Boost — memoization", () => {
  it("re-renders when ONLY the durable rank changes", async () => {
    const { __test_areTaskCardPropsEqual } = await import("../TaskCard");
    const base = { task: makeTask("FN-1"), onOpenDetail: vi.fn(), addToast: vi.fn() } as never;
    const boosted = {
      ...(base as object),
      task: makeTask("FN-1", {
        queueBoost: { sequence: "9", workflowId: "builtin:coding", column: "todo", columnEntryAt: ENTRY_AT, requestId: "r" },
      }),
    } as never;
    // Equal props would let the memo keep a stale Boost affordance on screen.
    expect(__test_areTaskCardPropsEqual(base, boosted)).toBe(false);
  });
});
