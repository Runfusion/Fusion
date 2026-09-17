/*
FNXC:PlanApproval 2026-09-16-05:01:
FN-448 — the board card no longer mounts a full-bleed "Need Your Review" overlay. A card waiting for
a human plan decision stays readable and announces the wait through its header status badge
("Needs you", blinking warning paint), while opening the card leads to Task Detail where the decision
is taken. The List notice is unchanged and is exercised here through a direct render of its own
variant, because it is inline, hides no row content, and still carries the direct Approve action.
*/
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { Task } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { approvePlan } = vi.hoisted(() => ({ approvePlan: vi.fn() }));
vi.mock("../../api", () => ({
  approvePlan,
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));

import { PlanApprovalNotice, TaskCard } from "../TaskCard";
import { readAppFile } from "../../test/cssFixture";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-212",
    title: "Approval hold",
    description: "Review before execution",
    prompt: "# Plan\n\n## Steps\n",
    column: "triage",
    status: "awaiting-approval",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-08-28T06:24:00.000Z",
    updatedAt: "2026-08-28T06:24:00.000Z",
    ...overrides,
  } as Task;
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  approvePlan.mockReset();
  HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({ width: 420, height: 240, top: 0, left: 0, right: 420, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }));
});
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  vi.restoreAllMocks();
});

function renderCard(
  row = task(),
  addToast = vi.fn(),
  taskColumnFlags?: ComponentProps<typeof TaskCard>["taskColumnFlags"],
  onOpenDetail = vi.fn(),
) {
  const utils = render(<TaskCard task={row} projectId="project-1" onOpenDetail={onOpenDetail} addToast={addToast} taskColumnFlags={taskColumnFlags} />);
  return { addToast, onOpenDetail, ...utils };
}

describe("TaskCard awaiting-approval presentation", () => {
  /*
  FN-448 symptom reproduction: before the fix, this exact fixture rendered
  `plan-approval-card-FN-212` covering the whole card with "Need Your Review".
  */
  it.each([
    ["an ordinary manual hold in the intake column", task(), undefined],
    ["a hold parked by the shipped workflow", task({ column: "todo", awaitingApprovalReason: null }), { intake: false, hold: true }],
    ["a legacy release-authorization hold", task({ column: "triage", awaitingApprovalReason: "release-authorization" }), undefined],
    ["the no-flags first paint", task({ column: "todo", awaitingApprovalReason: null }), undefined],
  ])("shows the Needs you badge and no overlay for %s", (_label, row, flags) => {
    const { container } = renderCard(row, vi.fn(), flags as ComponentProps<typeof TaskCard>["taskColumnFlags"]);

    expect(screen.queryByTestId("plan-approval-card-FN-212")).toBeNull();
    expect(screen.queryByText("Need Your Review")).toBeNull();

    const badge = screen.getByTestId("card-awaiting-approval-FN-212");
    expect(badge).toHaveTextContent("Needs you");
    expect(badge.className).toContain("awaiting-approval");
    expect(badge.className).not.toContain("awaiting-approval--plan-review-replan-cap");
    expect(badge.getAttribute("title")).toMatch(/needs your approval/i);

    // The card's own content stays readable — nothing covers it any more.
    expect(within(container).getByText("Approval hold")).toBeVisible();
  });

  it("keeps the distinct replan-cap escalation message instead of Needs you", () => {
    renderCard(task({ column: "in-review", awaitingApprovalReason: "plan-review-replan-cap" }));

    const badge = screen.getByTestId("card-awaiting-approval-FN-212");
    expect(badge).toHaveTextContent("Review budget exhausted");
    expect(badge.className).toContain("awaiting-approval--plan-review-replan-cap");
    expect(badge.getAttribute("data-awaiting-approval-reason")).toBe("plan-review-replan-cap");
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.queryByTestId("plan-approval-card-FN-212")).toBeNull();
  });

  it("renders no awaiting badge for a status-null card in a hold column", () => {
    renderCard(task({ column: "todo", status: null as unknown as Task["status"], awaitingApprovalReason: null }), vi.fn(), { intake: false, hold: true });

    expect(screen.queryByTestId("card-awaiting-approval-FN-212")).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });

  it("does not render an ordinary approval hold badge in a WIP column", () => {
    renderCard(task({ column: "in-progress", awaitingApprovalReason: null }), vi.fn(), { countsTowardWip: true });

    expect(screen.queryByTestId("plan-approval-card-FN-212")).toBeNull();
  });

  it("lets the external Blocked overlay win over the approval presentation", () => {
    renderCard(task({
      status: "blocked",
      paused: true,
      pausedReason: "external-block",
      externalBlock: {
        origin: "host-environment",
        code: "ENOSPC",
        message: "disk full",
        source: "agent-declaration",
        blockedAt: "2026-08-28T06:24:00.000Z",
        resume: { column: "triage" },
      },
    }));

    expect(screen.getByTestId("external-block-card-FN-212")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-approval-card-FN-212")).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });
});

/*
The notice itself survives for List rows only. These cases render its own variant directly, which is
how ListView mounts it.
*/
describe("PlanApprovalNotice list variant", () => {
  it("renders Need Your Review with Approve as its only action", () => {
    render(<PlanApprovalNotice task={task()} variant="list" projectId="project-1" addToast={vi.fn()} isPlanningLane />);

    const notice = screen.getByTestId("plan-approval-list-FN-212");
    expect(notice).toHaveTextContent("Need Your Review");
    expect(within(notice).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(notice).getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the distinct replan-cap copy", () => {
    render(<PlanApprovalNotice task={task({ column: "in-review", awaitingApprovalReason: "plan-review-replan-cap" })} variant="list" projectId="project-1" addToast={vi.fn()} isPlanningLane />);

    expect(screen.getByTestId("plan-approval-list-FN-212")).toHaveTextContent("Plan Review did not converge");
  });

  it("approves a slim list row without a prompt", async () => {
    approvePlan.mockResolvedValue(task({ status: undefined, column: "todo" }));
    const addToast = vi.fn();
    render(<PlanApprovalNotice task={task({ prompt: undefined, column: "todo", awaitingApprovalReason: null })} variant="list" projectId="project-1" addToast={addToast} isPlanningLane />);

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() => expect(approvePlan).toHaveBeenCalledWith("FN-212", "project-1"));
    expect(addToast).toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("returns the approval control to enabled after a server refusal", async () => {
    const message = "Cannot approve plan: PROMPT.md must be readable to create the immutable spec lock";
    approvePlan.mockRejectedValue(new Error(message));
    const addToast = vi.fn();
    render(<PlanApprovalNotice task={task({ prompt: undefined, column: "todo", awaitingApprovalReason: null })} variant="list" projectId="project-1" addToast={addToast} isPlanningLane />);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining(message), "error"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("opens the task record for a messaged human decision", () => {
    const onOpenTaskRecord = vi.fn();
    const armed = task({ humanPlanApproval: { enabled: true } } as Partial<Task>);
    render(<PlanApprovalNotice task={armed} variant="list" projectId="project-1" addToast={vi.fn()} isPlanningLane onOpenTaskRecord={onOpenTaskRecord} />);

    const review = screen.getByTestId("plan-approval-open-decision-list-FN-212");
    expect(review).toBeEnabled();
    fireEvent.click(review);
    expect(onOpenTaskRecord).toHaveBeenCalledTimes(1);
  });
});

describe("plan approval stylesheet contract", () => {
  const cardCss = readAppFile("components/TaskCard.css");
  const listCss = readAppFile("components/ListView.css");

  it("no longer ships the removed full-card overlay rule", () => {
    expect(cardCss).not.toContain("plan-approval-notice--card");
  });

  it("blinks the Needs you badge with warning paint on the card", () => {
    expect(cardCss).toMatch(/\.card-status-badge\.awaiting-approval \{[^}]*color: var\(--color-warning\);[^}]*animation: needs-you-blink/);
    expect(cardCss).toMatch(/@keyframes needs-you-blink/);
  });

  it("blinks the Needs you badge with warning paint in the list", () => {
    expect(listCss).toMatch(/\.list-status-badge--needs-you \{[^}]*color: var\(--color-warning\);[^}]*animation: list-needs-you-blink/);
    expect(listCss).toMatch(/@keyframes list-needs-you-blink/);
  });

  it.each([
    ["TaskCard.css", () => cardCss, ".card-status-badge.awaiting-approval"],
    ["ListView.css", () => listCss, ".list-status-badge--needs-you"],
  ])("cancels the blink under reduced motion in %s", (_label, read, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(read()).toMatch(new RegExp(`@media \\(prefers-reduced-motion: reduce\\) \\{\\s*${escaped} \\{\\s*animation: none;`));
  });

  it("keeps the mobile touch target for the surviving list notice actions", () => {
    expect(cardCss).toMatch(/@media \(max-width: 768px\)[\s\S]*\.plan-approval-notice__actions \.btn[\s\S]*min-(?:width|inline-size): var\(--touch-target-min-size\);[\s\S]*min-(?:height|block-size): var\(--touch-target-min-size\);/);
  });

  it("uses no raw pixel, hex, or rgba value in the new badge paint", () => {
    const needsYouBlocks = [
      cardCss.slice(cardCss.indexOf(".card-status-badge.awaiting-approval {")).split("}")[0],
      listCss.slice(listCss.indexOf(".list-status-badge--needs-you {")).split("}")[0],
    ];
    for (const block of needsYouBlocks) {
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(block).not.toMatch(/rgba?\(/);
      expect(block).not.toMatch(/\b\d+px\b/);
    }
  });
});
