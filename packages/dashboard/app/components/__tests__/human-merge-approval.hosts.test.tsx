/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the delivery lock must be visible and actionable on EVERY shared host, and the removed column
control must leave no shell behind. These render the real shared model and the real badge.

Surface enumeration covered here:
  • the shared action menu across armed / unarmed / decided / rejected cards, plus the states where
    the entry must be HIDDEN (merge started, merge confirmed, terminal lane);
  • the badge on the board-card and list renders, including a card with no other metadata;
  • the removed column toggle: no input, label, shell or handler survives on any lane.
*/
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";

import { buildTaskActionMenuModel } from "../TaskContextMenu";
import { HumanMergeApprovalBadge, resolveHumanMergeApprovalBadgeState } from "../TaskCard";

const t = ((key: string, fallback?: string) => fallback ?? key) as never;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-514",
    title: "Verrou de livraison",
    column: "in-review",
    steps: [],
    dependencies: [],
    log: [],
    ...over,
  } as unknown as Task;
}

const ARMED = { enabled: true, generation: 1 };
const CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "w",
  reviewEpisodeId: "e",
  contentSignature: "c",
  targetSignature: "t",
};

function menuFor(over: Partial<Task> = {}, options: Record<string, unknown> = {}) {
  return buildTaskActionMenuModel({
    task: task(over),
    t,
    onToggleMergeApproval: vi.fn(),
    ...options,
  } as never);
}

function lockEntry(model: ReturnType<typeof buildTaskActionMenuModel>) {
  return model.actions.find((action) => action.id === "toggle-merge-approval");
}

describe("FN-514 — the shared task action menu", () => {
  it("offers the lock on a live card and labels it by the card's current state", () => {
    expect(lockEntry(menuFor())?.label).toBe("Require my approval to deliver");
    expect(lockEntry(menuFor({ humanMergeApproval: ARMED }))?.label).toBe("Remove delivery approval");
  });

  it.each(["triage", "todo", "in-progress", "in-review"])("offers it in the %s lane", (column) => {
    expect(lockEntry(menuFor({ column }))).toBeDefined();
  });

  it("offers it on a paused and on a failed card, which are still live", () => {
    expect(lockEntry(menuFor({ paused: true, userPaused: true }))).toBeDefined();
    expect(lockEntry(menuFor({ status: "failed", error: "boom" }))).toBeDefined();
  });

  it("offers it while the card merely sits in the merge queue", () => {
    /* Queued is NOT a started delivery: the operator must still be able to lock it. */
    expect(lockEntry(menuFor({ status: "queued" }))).toBeDefined();
  });

  it.each([
    ["a merge has started", { status: "merging" }],
    ["a PR merge has started", { status: "merging-pr" }],
    ["a merge fix is running", { status: "merging-fix" }],
    ["the delivery is confirmed", { mergeDetails: { mergeConfirmed: true, commitSha: "abc" } }],
    ["the card is complete", { column: "done" }],
  ])("hides it once %s", (_label, over) => {
    expect(lockEntry(menuFor(over as Partial<Task>))).toBeUndefined();
  });

  it("hides it in a renamed terminal lane resolved from workflow traits, not a column name", () => {
    expect(lockEntry(menuFor({ column: "shipped" }, { currentColumnFlags: { complete: true } }))).toBeUndefined();
    expect(lockEntry(menuFor({ column: "shipped" }, { currentColumnFlags: { humanReview: true } }))).toBeDefined();
  });

  it("renders nothing at all when the host supplies no handler", () => {
    const model = buildTaskActionMenuModel({ task: task({ humanMergeApproval: ARMED }), t } as never);
    expect(lockEntry(model)).toBeUndefined();
  });

  it("asks for the OPPOSITE of the current state when selected", () => {
    const onToggleMergeApproval = vi.fn();
    lockEntry(menuFor({ humanMergeApproval: ARMED }, { onToggleMergeApproval }))?.onSelect?.();
    expect(onToggleMergeApproval).toHaveBeenCalledWith(false);
    onToggleMergeApproval.mockClear();
    lockEntry(menuFor({}, { onToggleMergeApproval }))?.onSelect?.();
    expect(onToggleMergeApproval).toHaveBeenCalledWith(true);
  });
});

describe("FN-514 — the card and list badge", () => {
  it("shows nothing for a card without the lock, so no empty shell is produced", () => {
    expect(resolveHumanMergeApprovalBadgeState(task())).toBeNull();
    const { container } = render(<HumanMergeApprovalBadge task={task()} variant="card" />);
    expect(container.firstChild).toBeNull();
  });

  it.each(["card", "list"] as const)("renders an accessible armed badge on the %s surface", (variant) => {
    render(<HumanMergeApprovalBadge task={task({ humanMergeApproval: ARMED })} variant={variant} />);
    const badge = screen.getByTestId(`${variant}-human-merge-approval-badge`);
    expect(badge.getAttribute("data-state")).toBe("armed");
    expect(badge.getAttribute("aria-label")).toBe("Your approval is required before delivery");
  });

  it("distinguishes armed, decided and rejected so the board is readable at a glance", () => {
    expect(resolveHumanMergeApprovalBadgeState(task({ humanMergeApproval: ARMED }))).toBe("armed");
    expect(resolveHumanMergeApprovalBadgeState(task({
      humanMergeApproval: { ...ARMED, decision: { requestId: "r", action: "merge", deliveryAction: "merge", decidedBy: "o", decidedAt: "t", candidate: CANDIDATE } },
    }))).toBe("decided");
    expect(resolveHumanMergeApprovalBadgeState(task({
      humanMergeApproval: { ...ARMED, rejection: { requestId: "j", instruction: "i", rejectedBy: "o", rejectedAt: "t", candidate: CANDIDATE, remediationGeneration: 1, state: "pending" } },
    }))).toBe("rejected");
  });

  it("stops flagging a rejection once its corrections are published", () => {
    expect(resolveHumanMergeApprovalBadgeState(task({
      humanMergeApproval: { ...ARMED, rejection: { requestId: "j", instruction: "i", rejectedBy: "o", rejectedAt: "t", candidate: CANDIDATE, remediationGeneration: 1, state: "published" } },
    }))).toBe("armed");
  });

  it("treats a decision from a superseded lock generation as still awaiting a decision", () => {
    expect(resolveHumanMergeApprovalBadgeState(task({
      humanMergeApproval: { enabled: true, generation: 3, decision: { requestId: "r", action: "merge", deliveryAction: "merge", decidedBy: "o", decidedAt: "t", candidate: CANDIDATE } },
    }))).toBe("armed");
  });

  it("keeps the rejection obligation visible after the lock itself is removed", () => {
    expect(resolveHumanMergeApprovalBadgeState(task({
      humanMergeApproval: { enabled: false, generation: 2, rejection: { requestId: "j", instruction: "i", rejectedBy: "o", rejectedAt: "t", candidate: CANDIDATE, remediationGeneration: 1, state: "pending" } },
    }))).toBe("rejected");
  });
});
