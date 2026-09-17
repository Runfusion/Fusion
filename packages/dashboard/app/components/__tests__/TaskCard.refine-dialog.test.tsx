import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirmWithCheckbox: async (options?: { checkbox?: { defaultChecked?: boolean } }) => ({ choice: "cancel" as const, checkboxValue: options?.checkbox?.defaultChecked ?? false }), confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));

vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  refineTask: vi.fn(),
  /* FNXC:TaskFollowUp 2026-09-17-18:10: FN-513's second composer endpoint. */
  followUpTask: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-a", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";
import { followUpTask, refineTask } from "../../api";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "done",
    status: "done" as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400 symptom: right-clicking a done card and choosing Refine opened the whole Task Detail record and stacked the
composer on top of it behind a painted veil. Refine must now open the standalone composer and nothing else, from every
card entry path, on both complete lanes.
*/
describe("TaskCard refine dialog", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(refineTask).mockReset();
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  THE OLD FIXTURE WAS CONTRADICTORY AND IS CORRECTED, NOT PATCHED. Both rows of this table used to
  declare `taskColumnFlags={{ complete: true }}`, including the one labelled "in-review" — so the
  review case was really a second complete case and proved nothing about a review lane. FN-513 makes
  that difference load-bearing (a review card gets Follow-up, a complete card gets Refine), so the
  review row now declares the review trait it always meant.
  */
  it("opens the Refine composer from a COMPLETE card context menu without opening the task record", () => {
    const onOpenDetail = vi.fn();
    render(
      <TaskCard
        task={makeTask({ column: "done", status: "done" as any })}
        taskColumnFlags={{ complete: true }}
        onOpenDetail={onOpenDetail}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    expect(screen.queryByRole("menuitem", { name: "Follow-up" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));

    expect(screen.getByTestId("task-refine-dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter your feedback here...")).toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();

    const overlay = screen.getByTestId("task-refine-dialog").closest("[data-dashboard-window-surface]") as HTMLElement;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toContain("task-refine-overlay");
    expect(overlay.className).not.toContain("detail-refine-overlay");
    expect(overlay.style.background).toBe("");
  });

  it("reports a created refinement upward and closes without touching the task record", async () => {
    const created = { id: "FN-002", column: "todo" };
    vi.mocked(refineTask).mockResolvedValue(created as never);
    const onOpenDetail = vi.fn();
    const onRefinementCreated = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        projectId="p1"
        onOpenDetail={onOpenDetail}
        onRefinementCreated={onRefinementCreated}
        addToast={noop}
        onDeleteTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(document.querySelector(".card")!, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refine" }));
    fireEvent.change(screen.getByPlaceholderText("Enter your feedback here..."), { target: { value: "tighten the copy" } });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(refineTask).toHaveBeenCalledWith("FN-001", "tighten the copy", "p1"));
    expect(onRefinementCreated).toHaveBeenCalledWith(created);
    await waitFor(() => expect(screen.queryByTestId("task-refine-dialog")).not.toBeInTheDocument());
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(followUpTask).not.toHaveBeenCalled();
  });
});

/*
FNXC:TaskFollowUp 2026-09-17-18:10:
FN-513 — the card host's Follow-up affordance and the shared composer running in follow-up mode.

The interactions exercised here are the real entry paths an operator has on a card: right-click, the
keyboard context menu, and a coarse-pointer long press. Each must open the composer IN PLACE without
mounting the task record, which is the deep-link shape FN-400 deleted and FN-513 must not restore.
*/
describe("TaskCard follow-up affordance", () => {
  const DESKTOP = 1280;
  const PHONE = 390;
  const TABLET = 1024;
  let priorWidth: number;

  function setViewport(width: number, coarse = false) {
    priorWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: coarse ? query.includes("coarse") : query.includes(`max-width: ${width}`),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }

  afterEach(() => {
    cleanup();
    vi.mocked(refineTask).mockReset();
    vi.mocked(followUpTask).mockReset();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: priorWidth ?? 1024 });
    /*
    Restore a FUNCTIONAL matchMedia, not a bare stub: a later desktop mount that receives `undefined`
    from a media query renders a stuck mobile layout with no visible cause.
    */
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      }),
    });
  });

  function renderCard(props: {
    task?: Partial<Task>;
    flags?: Record<string, boolean>;
    onOpenDetail?: ReturnType<typeof vi.fn>;
    onRefinementCreated?: ReturnType<typeof vi.fn>;
    projectId?: string;
    interactionMode?: "search-result";
  } = {}) {
    render(
      <TaskCard
        task={makeTask({ column: "in-progress", status: undefined as never, ...props.task })}
        taskColumnFlags={(props.flags ?? { countsTowardWip: true }) as never}
        projectId={props.projectId}
        onOpenDetail={props.onOpenDetail ?? vi.fn()}
        onRefinementCreated={props.onRefinementCreated}
        addToast={noop}
        onDeleteTask={vi.fn()}
        {...(props.interactionMode ? { interactionMode: props.interactionMode } : {})}
      />,
    );
    return document.querySelector(".card") as HTMLElement;
  }

  it.each([
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ])("opens the follow-up composer from a WIP card right-click on %s without opening the record", (_name, width) => {
    setViewport(width);
    const onOpenDetail = vi.fn();
    const card = renderCard({ onOpenDetail });

    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Follow-up" }));

    expect(screen.getByTestId("task-refine-dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Follow-up" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe the follow-up work here...")).toBeInTheDocument();
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("opens it from the keyboard context menu (Shift+F10) too", () => {
    setViewport(DESKTOP);
    const card = renderCard();
    card.focus();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Follow-up" })).toBeInTheDocument();
  });

  it.each([
    ["phone", PHONE],
    ["touch tablet", TABLET],
  ])("opens it from a coarse-pointer long press on %s", async (_name, width) => {
    // Touch capability and mobile WIDTH are different facts; a touch tablet is not a phone.
    setViewport(width, true);
    const card = renderCard();
    fireEvent.pointerDown(card, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20 });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Follow-up" })).toBeInTheDocument(), { timeout: 2000 });
  });

  it("submits exactly once, forwards the whole server task upward, and never calls refineTask", async () => {
    setViewport(DESKTOP);
    const created = { id: "FN-900", column: "todo", dependencies: ["FN-001"] };
    vi.mocked(followUpTask).mockResolvedValue(created as never);
    const onRefinementCreated = vi.fn();
    const card = renderCard({ onRefinementCreated, projectId: "p1" });

    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Follow-up" }));
    fireEvent.change(screen.getByPlaceholderText("Describe the follow-up work here..."), { target: { value: "add the CSV export" } });

    // Two clicks in the SAME frame must not issue two creations.
    const submit = screen.getByTestId("task-refine-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(followUpTask).toHaveBeenCalledWith("FN-001", "add the CSV export", "p1"));
    expect(followUpTask).toHaveBeenCalledTimes(1);
    expect(refineTask).not.toHaveBeenCalled();
    // The WHOLE server task is published, with its server-selected column untouched.
    expect(onRefinementCreated).toHaveBeenCalledWith(created);
    await waitFor(() => expect(screen.queryByTestId("task-refine-dialog")).not.toBeInTheDocument());
  });

  it("keeps the draft on a 409 and retries only on an explicit second submit", async () => {
    setViewport(DESKTOP);
    vi.mocked(followUpTask).mockRejectedValueOnce(new Error("Cannot create a follow-up of FN-001: source-terminal"));
    const card = renderCard();

    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Follow-up" }));
    const textarea = screen.getByPlaceholderText("Describe the follow-up work here...");
    fireEvent.change(textarea, { target: { value: "a draft worth keeping" } });
    fireEvent.click(screen.getByTestId("task-refine-submit"));

    await waitFor(() => expect(followUpTask).toHaveBeenCalledTimes(1));
    // The composer stays open and the typed text survives; nothing retried on its own.
    expect(screen.getByTestId("task-refine-dialog")).toBeInTheDocument();
    expect((screen.getByPlaceholderText("Describe the follow-up work here...") as HTMLTextAreaElement).value)
      .toBe("a draft worth keeping");
    expect(followUpTask).toHaveBeenCalledTimes(1);

    vi.mocked(followUpTask).mockResolvedValueOnce({ id: "FN-901", column: "todo" } as never);
    fireEvent.click(screen.getByTestId("task-refine-submit"));
    await waitFor(() => expect(followUpTask).toHaveBeenCalledTimes(2));
  });

  it("refuses an empty or whitespace-only request without calling the server", () => {
    setViewport(DESKTOP);
    const card = renderCard();
    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Follow-up" }));

    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Describe the follow-up work here..."), { target: { value: "   \n\t " } });
    expect(screen.getByTestId("task-refine-submit")).toBeDisabled();
    expect(followUpTask).not.toHaveBeenCalled();
  });

  /*
  The unauthorized states must render NOTHING — not a disabled entry, not a separator, not an
  invisible click target. A leftover shell is the failure mode the Surface Enumeration rule names.
  */
  it.each([
    ["manual capture", { column: "ideas" }, { intake: true, manualIntake: true }],
    ["unknown lane with explicitly negative flags", { column: "parking" }, {
      intake: false, hold: false, countsTowardWip: false, mergeBlocker: false, humanReview: false, complete: false,
    }],
    ["planning with no plan review at all", { column: "todo" }, { hold: true }],
    ["planning whose approval was replaced by a pending round", {
      column: "todo",
      workflowStepResults: [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE" },
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "pending" },
      ],
    }, { hold: true }],
    ["planning being re-planned", {
      column: "todo",
      status: "needs-replan",
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE" }],
    }, { hold: true }],
  ])("offers no follow-up entry and no empty shell for %s", (_name, task, flags) => {
    setViewport(DESKTOP);
    const card = renderCard({ task: task as Partial<Task>, flags: flags as Record<string, boolean> });
    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });

    expect(screen.queryByRole("menuitem", { name: "Follow-up" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-action-follow-up")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-label="Follow-up"]')).toBeNull();
  });

  it("offers it for a planning card whose CURRENT plan review approves", () => {
    setViewport(DESKTOP);
    const card = renderCard({
      task: {
        column: "todo",
        workflowStepResults: [
          { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed", verdict: "REVISE" },
          { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE" },
        ],
      } as Partial<Task>,
      flags: { hold: true },
    });
    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Follow-up" })).toBeInTheDocument();
  });

  it("offers Follow-up instead of Refine on a REVIEW card, never both", () => {
    setViewport(DESKTOP);
    const card = renderCard({ task: { column: "in-review" }, flags: { mergeBlocker: true } });
    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Follow-up" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Refine" })).not.toBeInTheDocument();
  });

  it("renders no context menu at all on a read-only search result", () => {
    setViewport(DESKTOP);
    const card = renderCard({ interactionMode: "search-result" });
    fireEvent.contextMenu(card, { clientX: 24, clientY: 28 });
    expect(screen.queryByRole("menuitem", { name: "Follow-up" })).not.toBeInTheDocument();
    expect(followUpTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  FN-513 — the provenance chip. A follow-up keeps the refinement chip, its parent gate and its link;
  only the WORDING changes, because "Refines FN-1" misstates a card prepared from a task that had not
  finished. A malformed or absent marker degrades to the historical refinement wording.
  */
  it.each([
    ["a follow-up", { followUp: { version: 1 } }, "Follows up FN-1", "Follow-up of FN-1"],
    ["an ordinary refinement", undefined, "Refines FN-1", "Refinement of FN-1"],
    ["an unknown marker version", { followUp: { version: 99 } }, "Refines FN-1", "Refinement of FN-1"],
    ["a malformed marker", { followUp: "yes" }, "Refines FN-1", "Refinement of FN-1"],
  ])("labels the provenance chip for %s", (_name, sourceMetadata, text, accessibleName) => {
    setViewport(DESKTOP);
    renderCard({
      task: {
        column: "todo",
        sourceType: "task_refine",
        sourceParentTaskId: "FN-1",
        ...(sourceMetadata ? { sourceMetadata } : {}),
      } as Partial<Task>,
      flags: { hold: true },
    });

    expect(screen.getByText(text)).toBeInTheDocument();
    const chip = document.querySelector(".card-refine-chip") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe(accessibleName);
  });

  it("renders no chip at all when a follow-up marker carries no parent", () => {
    setViewport(DESKTOP);
    renderCard({
      task: { column: "todo", sourceType: "task_refine", sourceMetadata: { followUp: { version: 1 } } } as Partial<Task>,
      flags: { hold: true },
    });
    expect(document.querySelector(".card-refine-chip")).toBeNull();
    expect(screen.queryByText(/Follows up|Refines /)).toBeNull();
  });
});
