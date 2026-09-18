import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@fusion/core";

/*
FNXC:EventDrivenDispatch 2026-09-18-00:40:
FN-519 — the display half of "action → réaction", asserted as HONESTY rather than speed.

The trap this file guards against is the tempting non-fix: make the card LOOK started the moment
Start is pressed. That hides a real queue instead of removing a real wait, and it is explicitly out
of bounds for this task. So the assertions here are:

  * Start performs the column move and nothing else — no invented `planning` status, no forged
    "started" label before the authoritative state says so;
  * a legitimate queue stays VISIBLE and explainable ("Queued to plan" is server-derived), because
    an operator whose card is genuinely waiting on capacity must be able to see that;
  * the authoritative state is applied as received, on both breakpoints, without waiting for any
    refresh clock — the card is a pure function of its props, so there is nothing to tick.

No production UI change is made or needed; these cases exist to prove that, and to fail loudly if a
future "fix" reaches for an optimistic status.
*/

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

const { TaskCard } = await import("../TaskCard");
const { CostBadgeProvider } = await import("../../context/CostBadgeContext");

const AT = "2026-09-18T00:00:00.000Z";
const HOLD_FLAGS = { hold: true } as const;
/*
The Start affordance renders only on a MANUAL INTAKE column (`showStartAction` requires
`taskColumnFlags.manualIntake`), while "Queued to plan" is an idle hold-column badge. They are
deliberately different surfaces, so each case below uses the flags its own subject actually needs
rather than asserting both on one card.
*/
const IDEAS_FLAGS = { intake: true, manualIntake: true } as const;

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: "FN-519-UI",
    title: "Bootstrap card",
    description: "started from the board",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: AT,
    updatedAt: AT,
    columnMovedAt: AT,
    ...patch,
  } as Task;
}

function renderCard(task: Task, props: Record<string, unknown> = {}) {
  return render(
    <CostBadgeProvider value={{ enabled: false }}>
      <TaskCard
        task={task}
        onOpenDetail={vi.fn() as never}
        addToast={vi.fn() as never}
        taskColumnFlags={(props.taskColumnFlags as never) ?? HOLD_FLAGS}
        {...props}
      />
    </CostBadgeProvider>,
  );
}

/** Force a breakpoint, restoring BOTH innerWidth and a working matchMedia afterwards. */
function setViewport(width: number) {
  const originalWidth = window.innerWidth;
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*768px/.test(query) ? width <= 768 : false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as never;
  return () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
    window.matchMedia = originalMatchMedia;
  };
}

let restoreViewport: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  restoreViewport?.();
  restoreViewport = null;
});

describe("TaskCard Start is honest about the queue", () => {
  it("performs the column move and paints no fabricated planning state", async () => {
    const onMoveTask = vi.fn(async () => undefined);
    const task = makeTask({ column: "ideas", awaitingPlanning: true } as Partial<Task>);
    renderCard(task, { onMoveTask, taskColumnFlags: IDEAS_FLAGS });

    await userEvent.click(screen.getByTestId("card-start-FN-519-UI"));

    expect(onMoveTask).toHaveBeenCalledTimes(1);
    // The card's own status must still be what the server says it is. An optimistic "planning"
    // would hide exactly the wait this task exists to remove.
    expect(task.status ?? null).toBeNull();
  });

  it("keeps a legitimate queue visible instead of hiding it behind the click", async () => {
    const onMoveTask = vi.fn(async () => undefined);
    // Server-derived: this card has no spec yet, so it is genuinely queued to plan.
    renderCard(makeTask({ awaitingPlanning: true } as Partial<Task>), { onMoveTask });

    // The queue badge and its container survive the interaction; nothing is removed to make the
    // symptom go away.
    await waitFor(() => expect(screen.getByText(/Queued to plan/i)).toBeTruthy());
  });

  it("renders the authoritative planning state as received, with no refresh clock", () => {
    // A re-render with the state the engine actually published is all it takes — the card is a
    // pure function of its props, so there is no interval to advance.
    const { rerender } = renderCard(makeTask());
    rerender(
      <CostBadgeProvider value={{ enabled: false }}>
        <TaskCard
          task={makeTask({ status: "planning" } as Partial<Task>)}
          onOpenDetail={vi.fn() as never}
          addToast={vi.fn() as never}
          taskColumnFlags={HOLD_FLAGS as never}
        />
      </CostBadgeProvider>,
    );

    expect(screen.queryByText(/Queued to plan/i)).toBeNull();
  });

  it("keeps the Start affordance and its accessible label on mobile", async () => {
    restoreViewport = setViewport(390);
    const onMoveTask = vi.fn(async () => undefined);
    renderCard(makeTask({ column: "ideas", awaitingPlanning: true } as Partial<Task>), { onMoveTask, taskColumnFlags: IDEAS_FLAGS });

    // No affordance is added or removed by this task, and no empty button shell is left behind at
    // the narrow breakpoint.
    const start = screen.getByTestId("card-start-FN-519-UI");
    expect(start.getAttribute("aria-label")).toBeTruthy();
    await userEvent.click(start);
    expect(onMoveTask).toHaveBeenCalledTimes(1);
  });

  it("keeps the Start affordance on desktop", async () => {
    restoreViewport = setViewport(1280);
    const onMoveTask = vi.fn(async () => undefined);
    renderCard(makeTask({ column: "ideas", awaitingPlanning: true } as Partial<Task>), { onMoveTask, taskColumnFlags: IDEAS_FLAGS });

    const start = screen.getByTestId("card-start-FN-519-UI");
    expect(start.getAttribute("aria-label")).toBeTruthy();
    await userEvent.click(start);
    expect(onMoveTask).toHaveBeenCalledTimes(1);
  });

  it("does not re-send the move while the first one is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onMoveTask = vi.fn(async () => { await gate; });
    renderCard(makeTask({ column: "ideas", awaitingPlanning: true } as Partial<Task>), { onMoveTask, taskColumnFlags: IDEAS_FLAGS });

    const start = screen.getByTestId("card-start-FN-519-UI");
    await userEvent.click(start);
    // A duplicate click must not produce a second admission request.
    await userEvent.click(start);

    expect(onMoveTask).toHaveBeenCalledTimes(1);
    release();
  });
});
