import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@fusion/core";
import { TaskContextMenu, buildTaskActionMenuModel } from "../TaskContextMenu";

const t = ((key: string, fallback: string, vars?: Record<string, string>) => {
  if (!vars) return fallback;
  return fallback.replace(/{{(\w+)}}/g, (_, name: string) => vars[name] ?? "");
}) as any;
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7255",
    title: "Context menu task",
    column: "in-progress",
    status: undefined as any,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

function actionIds(task: Task, overrides: Partial<Parameters<typeof buildTaskActionMenuModel>[0]> = {}): string[] {
  return buildTaskActionMenuModel({ task, t, ...overrides }).actions.map((action) => action.id);
}

describe("TaskContextMenu shared task action model", () => {
  it("mirrors Retry, Reset, and Delete availability across lifecycle states", () => {
    const onRetry = vi.fn();
    const onTogglePause = vi.fn();
    expect(actionIds(makeTask({ column: "triage" }), { onRetry, onTogglePause })).toEqual(["retry", "pause", "delete"]);
    expect(buildTaskActionMenuModel({ task: makeTask({ column: "triage" }), t, onRetry, onTogglePause }).shouldShowActionsMenu).toBe(true);
    /* FNXC:TaskRefine 2026-09-14-22:23: FN-400 — hosts now pass a local dialog trigger here rather than a detail-open route. */
    expect(actionIds(makeTask({ column: "in-review" }), { onRetry, onReset: vi.fn(), onOpenRefine: vi.fn(), onTogglePause })).toEqual(["refine", "retry", "pause", "reset", "delete"]);
    expect(actionIds(makeTask({ column: "done" }), { onRetry, onReset: vi.fn(), onOpenRefine: vi.fn() })).toEqual(["refine", "delete"]);
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  FN-513 — where Follow-up appears, and where it must leave NOTHING behind.

  The two facts that matter are complementarity (a review lane shows Follow-up INSTEAD OF Refine, so
  no menu ever carries two near-identical composers) and strictness of the Planning exception (only a
  CURRENT approving plan review qualifies). The descriptor is also absent — not disabled — wherever
  it does not apply, because a disabled shell is a dead affordance.
  */
  describe("FN-513 Follow-up descriptor", () => {
    const handlers = { onOpenRefine: vi.fn(), onOpenFollowUp: vi.fn() };
    const approved = [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed" as const, verdict: "APPROVE" as const }];

    const ids = (task: Partial<Task>, currentColumnFlags?: Record<string, boolean>) =>
      actionIds(makeTask(task), { ...handlers, ...(currentColumnFlags ? { currentColumnFlags: currentColumnFlags as never } : {}) });

    it("replaces Refine in implementation and review lanes, and keeps Refine on terminal ones", () => {
      expect(ids({ column: "in-progress" }, { countsTowardWip: true })).toContain("follow-up");
      expect(ids({ column: "in-progress" }, { countsTowardWip: true })).not.toContain("refine");
      expect(ids({ column: "Relecture" }, { humanReview: true })).toContain("follow-up");
      expect(ids({ column: "Relecture" }, { humanReview: true })).not.toContain("refine");
      expect(ids({ column: "Livr\u00e9" }, { complete: true })).toContain("refine");
      expect(ids({ column: "Livr\u00e9" }, { complete: true })).not.toContain("follow-up");
    });

    it("resolves renamed lanes by trait, with explicit flags beating the column id", () => {
      // A column NAMED like a review lane but explicitly declared terminal is terminal.
      expect(ids({ column: "in-review" }, { complete: true })).toContain("refine");
      expect(ids({ column: "in-review" }, { complete: true })).not.toContain("follow-up");
      // A column named "done" that really is an implementation lane offers Follow-up.
      expect(ids({ column: "done" }, { countsTowardWip: true })).toContain("follow-up");
    });

    it("applies the strict Planning exception", () => {
      expect(ids({ column: "todo" }, { hold: true })).not.toContain("follow-up");
      expect(ids({ column: "todo", workflowStepResults: approved }, { hold: true })).toContain("follow-up");
      // An approval a later round replaced does not qualify.
      expect(ids({
        column: "todo",
        workflowStepResults: [...approved, { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed" as const, verdict: "REVISE" as const }],
      }, { hold: true })).not.toContain("follow-up");
      // A live replan does not qualify either.
      expect(ids({ column: "todo", status: "needs-replan" as never, workflowStepResults: approved }, { hold: true })).not.toContain("follow-up");
      // Manual capture has nothing planned to follow up on.
      expect(ids({ column: "ideas", workflowStepResults: approved }, { intake: true, manualIntake: true })).not.toContain("follow-up");
    });

    it("is absent — not disabled — when the host wires no handler or the state is unsupported", () => {
      const noHandler = buildTaskActionMenuModel({ task: makeTask({ column: "in-progress" }), t, currentColumnFlags: { countsTowardWip: true } as never });
      expect(noHandler.actions.map((action) => action.id)).not.toContain("follow-up");

      const unsupported = buildTaskActionMenuModel({
        task: makeTask({ column: "parking" }),
        t,
        currentColumnFlags: { intake: false, hold: false, countsTowardWip: false, mergeBlocker: false, humanReview: false, complete: false } as never,
        ...handlers,
      });
      expect(unsupported.actions.find((action) => action.id === "follow-up")).toBeUndefined();
      expect(unsupported.actions.some((action) => action.disabled && action.id === "follow-up")).toBe(false);
    });

    it("invokes exactly the host's follow-up handler when selected", () => {
      const onOpenFollowUp = vi.fn();
      const onOpenRefine = vi.fn();
      const model = buildTaskActionMenuModel({
        task: makeTask({ column: "in-progress" }),
        t,
        currentColumnFlags: { countsTowardWip: true } as never,
        onOpenFollowUp,
        onOpenRefine,
      });
      model.actions.find((action) => action.id === "follow-up")!.onSelect!();
      expect(onOpenFollowUp).toHaveBeenCalledTimes(1);
      expect(onOpenRefine).not.toHaveBeenCalled();
    });
  });

  it("offers Bypass failed review for live and eligible archived pre-merge failures only", () => {
    const onBypassReview = vi.fn();
    const archivedFailure = {
      workflowStepId: "plan-review",
      phase: "pre-merge" as const,
      status: "skipped" as const,
      remediationArchivedAt: "2026-09-02T00:00:00.000Z",
      remediationArchivedFromStatus: "failed" as const,
    };
    const withBypass = (workflowStepResults: Task["workflowStepResults"], overrides: Partial<Task> = {}) => actionIds(
      makeTask({ column: "in-review", workflowStepResults, ...overrides }),
      { onBypassReview },
    );

    expect(withBypass([archivedFailure])).toContain("bypass-review");
    expect(withBypass([{ ...archivedFailure, status: "failed", remediationArchivedAt: undefined }])).toContain("bypass-review");
    expect(withBypass([{ ...archivedFailure, bypassedBy: "operator" }])).not.toContain("bypass-review");
    expect(withBypass([{ ...archivedFailure, remediationArchivedFromStatus: "passed" }])).not.toContain("bypass-review");
    expect(withBypass([{ ...archivedFailure, phase: "post-merge" }])).not.toContain("bypass-review");
    expect(withBypass([archivedFailure], { column: "in-progress" })).not.toContain("bypass-review");
    expect(actionIds(makeTask({ column: "in-review", workflowStepResults: [archivedFailure] }))).not.toContain("bypass-review");
  });

  it("offers exactly the supported recovery actions", () => {
    const supported = buildTaskActionMenuModel({
      task: makeTask({ column: "in-progress" }),
      t,
      onRetry: vi.fn(),
      onReset: vi.fn(),
      onTogglePause: vi.fn(),
    });
    expect(supported.actions.map((action) => action.id)).toEqual(["retry", "pause", "reset", "delete"]);
  });

  it("offers Retry for every mutable live column, including pending recovery", () => {
    const onRetry = vi.fn();
    const onReset = vi.fn();
    const onTogglePause = vi.fn();
    for (const task of [makeTask(), makeTask({ status: null as any, nextRecoveryAt: new Date(Date.now() + 60_000).toISOString() })]) {
      expect(actionIds(task, { onRetry, onReset, onTogglePause })).toEqual(["retry", "pause", "reset", "delete"]);
    }
    expect(actionIds(makeTask({ column: "done" }), { onRetry, onReset })).toEqual(["delete"]);
  });

  /*
  FNXC:TaskContextMenu 2026-09-15-10:40:
  FN-417: the engine plans automatically, so NO column shape produces a `plan` descriptor any more.
  Replaces "exposes Plan only for pre-execution hold columns with a host callback", whose subject
  (the `plan` descriptor and its `isPreExecutionHoldColumn` gate) was deleted with the affordance.
  The previously eligible shapes are enumerated here so a re-added descriptor fails loudly, and each
  case is anchored positively so the assertion cannot pass by producing an empty menu.
  */
  it("never produces a Plan action, for any column shape", () => {
    const shapes: Array<[string, string, Record<string, boolean> | undefined]> = [
      ["legacy intake id", "triage", undefined],
      ["no resolved flags yet (first paint)", "backlog", undefined],
      ["renamed intake lane", "ideas", { intake: true }],
      ["renamed hold lane", "backlog", { hold: true }],
      ["merged planning lane", "todo", { intake: true, hold: true }],
      ["mid-flight column NAMED triage", "triage", { intake: false, hold: false, countsTowardWip: true }],
    ];

    for (const [label, column, flags] of shapes) {
      const ids = buildTaskActionMenuModel({
        task: makeTask({ column: column as never }),
        t,
        currentColumnFlags: flags as never,
        onDelete: vi.fn(),
      } as never).actions.map((action: { id: string }) => action.id);
      expect(ids, label).not.toContain("plan");
      // Positive anchor: the menu is genuinely built for this shape, not empty.
      expect(ids, label).toContain("delete");
    }
  });

  it("exposes GitHub tracking enablement only for untracked tasks with a host callback", () => {
    const onEnableGithubTracking = vi.fn();
    const untracked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: undefined }),
      t,

      onEnableGithubTracking,
    });
    const disabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: false } as any }),
      t,

      onEnableGithubTracking,
    });
    const enabled = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true } as any }),
      t,

      onEnableGithubTracking,
    });
    const linked = buildTaskActionMenuModel({
      task: makeTask({ githubTracking: { enabled: true, issue: { owner: "o", repo: "r", number: 1 } } as any }),
      t,

      onEnableGithubTracking,
    });
    const noCallback = buildTaskActionMenuModel({ task: makeTask(), t });

    expect(untracked.actions.find((action) => action.id === "enable-github-tracking")?.label).toBe("Enable GitHub tracking");
    expect(untracked.actions.map((action) => action.id)).toEqual(["enable-github-tracking", "delete"]);
    expect(disabled.actions.map((action) => action.id)).toContain("enable-github-tracking");
    expect(enabled.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(linked.actions.map((action) => action.id)).not.toContain("enable-github-tracking");
    expect(noCallback.actions.map((action) => action.id)).not.toContain("enable-github-tracking");

    untracked.actions.find((action) => action.id === "enable-github-tracking")?.onSelect?.();
    expect(onEnableGithubTracking).toHaveBeenCalledTimes(1);
  });

  it("exposes wired pause, unpause, and paused-by-agent note with detail labels", () => {
    const onTogglePause = vi.fn();
    const active = buildTaskActionMenuModel({ task: makeTask(), t, onTogglePause });
    expect(active.actions.map((action) => action.id)).toEqual(["pause", "delete"]);
    expect(active.actions.find((action) => action.id === "pause")?.label).toBe("Pause");

    const paused = buildTaskActionMenuModel({
      task: makeTask({ paused: true, pausedByAgentId: "agent-1" } as Partial<Task>),
      t,
      onTogglePause,
    });
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "unpause",
      "Unpause",
      undefined,
    ]);
    expect(paused.actions.map((action) => [action.id, action.label, action.tone])).toContainEqual([
      "paused-by-agent",
      "Paused by agent",
      "note",
    ]);
  });

  it("does not expose move transitions in lifecycle action models", () => {
    for (const column of ["in-progress", "in-review"] as const) {
      const model = buildTaskActionMenuModel({ task: makeTask({ column }), t });
      expect(model).not.toHaveProperty("moveTransitions");
      expect(model.actions.map((action) => action.id)).not.toContainEqual(expect.stringMatching(/^move-/));
    }
  });

  /*
  FNXC:TaskContextMenu 2026-09-15-10:40:
  FN-417: merge completion is OPT-IN. Without `includeMergeCompletionAction` — the shape every task
  context menu host uses — an in-review card yields no review action at all; Task Detail opts in and
  gets the unchanged footer descriptor. The PR-flow verdicts are unaffected either way.
  */
  it("withholds merge completion unless the host opts in", () => {
    // Auto-merge lane: "Merge & Close" is withheld.
    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review" }),
      t,
      onMerge: vi.fn(),
    }).reviewAction).toBeUndefined();

    // Manual-PR lane with an already-merged PR: "Finish & Close" is withheld.
    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", prInfo: { status: "merged" } as any }),
      t,
      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      onMerge: vi.fn(),
    }).reviewAction).toBeUndefined();

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review" }),
      t,
      includeMergeCompletionAction: true,
    }).reviewAction).toMatchObject({ id: "merge", label: "Merge & Close" });

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", prInfo: { status: "merged" } as any }),
      t,
      includeMergeCompletionAction: true,
      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
    }).reviewAction).toMatchObject({ id: "merge", label: "Finish & Close" });
  });

  it("mirrors in-review manual PR status actions without opting into merge completion", () => {
    const onMerge = vi.fn();
    const onStartPrReview = vi.fn();
    const startPrReviewAction = buildTaskActionMenuModel({
      task: makeTask({ column: "in-review" }),
      t,

      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      onMerge,
      onStartPrReview,
    }).reviewAction;
    expect(startPrReviewAction).toMatchObject({ id: "start-pr-review", label: "Start PR Review" });
    startPrReviewAction?.onSelect?.();
    expect(onStartPrReview).toHaveBeenCalledTimes(1);
    expect(onMerge).not.toHaveBeenCalled();

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", prInfo: { status: "open" } as any }),
      t,

      mergeStrategy: "pull-request",
      autoMergeEnabled: false,
      isCheckingPrStatus: true,
    }).reviewAction).toMatchObject({ id: "check-pr-status", label: "Check PR Status", disabled: true });

    expect(buildTaskActionMenuModel({
      task: makeTask({ column: "in-review", status: "merging-pr" as any }),
      t,

      prAutomationLabel: "Merging PR…",
    }).reviewAction).toMatchObject({ id: "pr-automation", label: "Merging PR…", disabled: true });
  });

  it("renders descriptors and delegates selection to injected host handlers", () => {
    const onDelete = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[{ id: "delete", label: "Delete", tone: "danger", onSelect: onDelete }]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("keeps action markup unchanged when optional test and pressed metadata is absent", () => {
    render(<TaskContextMenu actions={[{ id: "plain", label: "Plain action" }]} />);

    const action = screen.getByRole("menuitem", { name: "Plain action" });
    expect(action).not.toHaveAttribute("data-testid");
    expect(action).not.toHaveAttribute("aria-pressed");
  });

  it("forwards test ids to action and note items without making notes selectable", () => {
    const onActionSelect = vi.fn();
    const onNoteSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[
          { id: "action", label: "Action", testId: "menu-action" },
          { id: "note", label: "Section heading", tone: "note", testId: "menu-note", onSelect: onNoteSelect },
        ]}
        onActionSelect={onActionSelect}
      />,
    );

    expect(screen.getByTestId("menu-action")).toHaveRole("menuitem", { name: "Action" });
    const note = screen.getByTestId("menu-note");
    expect(note).toHaveRole("note");
    fireEvent.click(note);
    expect(onActionSelect).not.toHaveBeenCalled();
    expect(onNoteSelect).not.toHaveBeenCalled();
  });

  it("renders aria-pressed only when an action descriptor defines pressed", () => {
    render(
      <TaskContextMenu
        actions={[
          { id: "on", label: "On", pressed: true },
          { id: "off", label: "Off", pressed: false },
          { id: "unset", label: "Unset" },
        ]}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "On" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("menuitem", { name: "Off" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("menuitem", { name: "Unset" })).not.toHaveAttribute("aria-pressed");
  });

  it("selects enabled touch menu items on pointer release exactly once", () => {
    const onPause = vi.fn();
    const onActionSelect = vi.fn();
    render(
      <TaskContextMenu
        actions={[
          { id: "pause", label: "Pause", onSelect: onPause },
          { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
          { id: "note", label: "Paused by agent", tone: "note", disabled: true, onSelect: vi.fn() },
        ]}
        onActionSelect={onActionSelect}
      />,
    );

    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Pause" }), { pointerType: "touch", pointerId: 1 });

    expect(onActionSelect).toHaveBeenCalledTimes(1);
    expect(onActionSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "Disabled" })).toBeDisabled();
    expect(screen.getByText("Paused by agent")).toHaveAttribute("role", "note");
  });

  it("focuses the first enabled action and supports arrow-key roving", () => {
    render(
      <TaskContextMenu
        actions={[
          { id: "disabled", label: "Disabled", disabled: true },
          { id: "pause", label: "Pause" },
          { id: "delete", label: "Delete", tone: "danger" },
        ]}
      />,
    );

    const pause = screen.getByRole("menuitem", { name: "Pause" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(pause).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(del).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(pause).toHaveFocus();
  });

  it("renders generic submenus without coupling them to task movement", () => {
    const onSelect = vi.fn();
    render(<TaskContextMenu actions={[{ id: "more", label: "More", items: [{ id: "nested", label: "Nested", onSelect }] }]} />);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "More" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Nested" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("uses one navigable Alpha menu with a native homemade Alpha submenu", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<><><TaskContextMenu actions={[{ id: "pause", label: "Pause" }, { id: "delete", label: "Delete" }, { id: "more", label: "More", items: [{ id: "nested", label: "Nested", onSelect }] }]} /></></>);
    const pause = screen.getByRole("menuitem", { name: "Pause" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    pause.focus();
    await user.keyboard("{ArrowDown}");
    expect(del).toHaveFocus();
    const more = screen.getByRole("menuitem", { name: "More" });
    more.focus();
    await user.keyboard("{ArrowRight}");
    const nested = await screen.findByRole("menuitem", { name: "Nested" });
    expect(nested.closest('[data-ui="menu"]')?.querySelector('[data-ui="menu"]')).toBeNull();
    await user.click(nested);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-10:20 (PR #2626 review — greptile P2):
The intake-only vs intake+hold distinction, covered per workflow SHAPE rather than per column id.

`shouldShowActionsMenu` follows the generated action list, so a pure intake lane remains an
operator-recoverable planning stage rather than a hidden menu special case. Cover both trait and
legacy fallbacks so first paint never withdraws the shared actions.
*/
describe("shouldShowActionsMenu by workflow shape (not by column id)", () => {
  const model = (column: string, flags: Record<string, boolean>) =>
    buildTaskActionMenuModel({
      task: makeTask({ column: column as never }),
      t,
      currentColumnFlags: flags as never,
    }).shouldShowActionsMenu;

  it("SHOWS the menu on a Coding (Ideas) capture — intake with no hold, non-legacy id", () => {
    expect(model("ideas", { intake: true })).toBe(true);
  });

  it("SHOWS the menu on a merged Planning column — intake AND hold", () => {
    // Post-U11 the default Planning column carries both traits. Cards rest here waiting for
    // capacity and do have real actions, so suppressing would remove affordances that existed
    // when this was the separate `todo` lane.
    expect(model("todo", { intake: true, hold: true })).toBe(true);
  });

  it("SHOWS the menu on a hold-only lane, as the pre-merge `todo` column did", () => {
    expect(model("todo", { hold: true })).toBe(true);
  });

  it("SHOWS on a RENAMED pure-intake lane, proving no id is consulted", () => {
    expect(model("backlog", { intake: true })).toBe(true);
  });
});

