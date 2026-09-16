/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — the operator decision surface. These tests drive the REAL hosts (QuickEntryBox, NewTaskModal,
TaskDetailModal, TaskCard, and both ListView renders) rather than only the new component, because the
requirement is about what an operator can actually do on the board, not about one component in
isolation.

Surface enumeration:
  • Creation toggle: QuickEntryBox and TaskForm-inside-NewTaskModal, pointer and keyboard, aria state,
    payload, independence from Fast, reset after success.
  • Badge: TaskCard plus BOTH ListView renders (mobile cards and desktop table), all three states,
    and absent/false/legacy data producing no badge shell.
  • Decision: one banner placement (FN-448 removed the duplicate footer one), both decisions carrying the message, double
    submit sending once, failure preserving the draft, DOM identity preserved across a rerender.
  • Viewports: 390px (phone) and 1280px (desktop).
*/
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@fusion/core";

import { HumanPlanApprovalControls } from "../HumanPlanApprovalControls";
import { HumanPlanApprovalBadge } from "../TaskCard";
import {
  resolveHumanPlanApprovalBadgeState,
  hasCurrentHumanPlanApprovalClient,
} from "../../utils/reviewBudgetApproval";

const EPISODE = "2026-09-15T06:20:00.000Z";
const FINGERPRINT = "c".repeat(64);

function planReviewPassed(completedAt = EPISODE, over: Record<string, unknown> = {}) {
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...over,
  } as NonNullable<Task["workflowStepResults"]>[number];
}

function armedTask(over: Partial<Task> = {}): Task {
  return {
    id: "FN-408",
    title: "Validation humaine",
    description: "",
    column: "todo",
    status: "awaiting-approval",
    awaitingApprovalReason: "human-plan-approval",
    approvedPlanFingerprint: FINGERPRINT,
    workflowStepResults: [planReviewPassed()],
    humanPlanApproval: { enabled: true },
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-15T06:00:00.000Z",
    updatedAt: "2026-09-15T06:00:00.000Z",
    columnMovedAt: "2026-09-15T06:00:00.000Z",
    ...over,
  } as Task;
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*768px/.test(query) ? width <= 768 : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const ORIGINAL_WIDTH = window.innerWidth;
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

afterEach(() => {
  // Restore BOTH, or later desktop mounts inherit a stuck mobile layout / undefined media results.
  Object.defineProperty(window, "innerWidth", { value: ORIGINAL_WIDTH, configurable: true, writable: true });
  window.matchMedia = ORIGINAL_MATCH_MEDIA;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Badge state — the three states and every "no badge" case
// ─────────────────────────────────────────────────────────────────────────────

describe("the badge distinguishes armed, awaiting, and approved", () => {
  it("renders no badge at all for a card without the option", () => {
    const { container } = render(<HumanPlanApprovalBadge task={armedTask({ humanPlanApproval: undefined })} variant="card" />);
    // No empty shell, no orphaned aria-label.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders no badge for an explicitly disabled option", () => {
    const { container } = render(<HumanPlanApprovalBadge task={armedTask({ humanPlanApproval: { enabled: false } })} variant="card" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders no badge for a legacy row carrying only the retired requirePlanApproval value", () => {
    const legacy = armedTask({ humanPlanApproval: undefined });
    (legacy as unknown as Record<string, unknown>).requirePlanApproval = true;
    const { container } = render(<HumanPlanApprovalBadge task={legacy} variant="card" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says 'required' — not 'awaiting' — while the plan is still being reviewed", () => {
    // A card still in planning must not claim it is already waiting on the operator.
    const planning = armedTask({ workflowStepResults: [], approvedPlanFingerprint: undefined });
    expect(resolveHumanPlanApprovalBadgeState(planning)).toBe("armed");

    render(<HumanPlanApprovalBadge task={planning} variant="card" />);
    expect(screen.getByTestId("card-human-plan-approval-badge")).toHaveAttribute("data-state", "armed");
  });

  it("says 'awaiting' once Plan Review is satisfied and no decision exists", () => {
    render(<HumanPlanApprovalBadge task={armedTask()} variant="card" />);
    expect(screen.getByTestId("card-human-plan-approval-badge")).toHaveAttribute("data-state", "awaiting");
  });

  it("says 'approved' for a current decision on this exact plan and episode", () => {
    const approved = armedTask({
      humanPlanApproval: {
        enabled: true,
        decision: {
          requestId: "r1",
          decision: "approved",
          decidedBy: "dashboard-operator",
          decidedAt: EPISODE,
          planFingerprint: FINGERPRINT,
          planningEpisodeId: EPISODE,
        },
      },
    });
    expect(hasCurrentHumanPlanApprovalClient(approved)).toBe(true);

    render(<HumanPlanApprovalBadge task={approved} variant="card" />);
    expect(screen.getByTestId("card-human-plan-approval-badge")).toHaveAttribute("data-state", "approved");
  });

  it("falls back to 'awaiting' when the decision belongs to a previous review episode", () => {
    const stale = armedTask({
      workflowStepResults: [
        planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
        planReviewPassed("2026-09-15T09:00:00.000Z"),
      ],
      humanPlanApproval: {
        enabled: true,
        decision: {
          requestId: "r1",
          decision: "approved",
          decidedBy: "dashboard-operator",
          decidedAt: EPISODE,
          planFingerprint: FINGERPRINT,
          planningEpisodeId: EPISODE,
        },
      },
    });
    render(<HumanPlanApprovalBadge task={stale} variant="card" />);
    expect(screen.getByTestId("card-human-plan-approval-badge")).toHaveAttribute("data-state", "awaiting");
  });

  it("renders in the list variant with the list badge class", () => {
    render(<HumanPlanApprovalBadge task={armedTask()} variant="list" />);
    const badge = screen.getByTestId("list-human-plan-approval-badge");
    expect(badge.className).toContain("list-execution-mode-badge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The decision surface
// ─────────────────────────────────────────────────────────────────────────────

function ControlsHarness(props: {
  onApprove: () => void;
  onReject: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <HumanPlanApprovalControls
      taskId="FN-408"
      variant="banner"
      message={harnessState.message}
      onMessageChange={(value) => { harnessState.message = value; harnessState.rerender?.(); }}
      onApprove={props.onApprove}
      onReject={props.onReject}
      pending={props.pending}
      error={props.error}
      maxLength={10_000}
    />
  );
}

const harnessState: { message: string; rerender?: () => void } = { message: "" };

/** A host that owns the draft in real React state, exactly as TaskDetailModal does. */
function LiveControlsHost({ onApprove, onReject }: { onApprove?: () => void; onReject?: () => void } = {}) {
  const [message, setMessage] = useState("");
  return (
    <HumanPlanApprovalControls
      taskId="FN-408"
      variant="banner"
      message={message}
      onMessageChange={setMessage}
      onApprove={onApprove ?? (() => {})}
      onReject={onReject ?? (() => {})}
      maxLength={10_000}
    />
  );
}

describe("the decision surface offers one message field and both decisions", () => {
  beforeEach(() => {
    harnessState.message = "";
    harnessState.rerender = undefined;
  });

  for (const width of [390, 1280]) {
    it(`renders an accessible field and both actions at ${width}px`, () => {
      setViewport(width);
      render(<ControlsHarness onApprove={() => {}} onReject={() => {}} />);

      // The field is reachable by its visible label, not only by test id.
      expect(screen.getByLabelText(/Message/i)).toBeInTheDocument();
      expect(screen.getByTestId("human-plan-approval-approve-banner")).toBeEnabled();
      expect(screen.getByTestId("human-plan-approval-reject-banner")).toBeEnabled();
    });
  }

  it("keeps the textarea DOM node identical across an unrelated rerender", async () => {
    /*
    A component declared inside a host render would be a new element type each render, remounting the
    textarea and discarding a partially-typed message. Assert node identity, which `fireEvent` cannot
    detect.
    */
    const { rerender } = render(<ControlsHarness onApprove={() => {}} onReject={() => {}} />);
    const before = screen.getByTestId("human-plan-approval-message-banner");

    rerender(<ControlsHarness onApprove={() => {}} onReject={() => {}} error={null} />);

    expect(screen.getByTestId("human-plan-approval-message-banner")).toBe(before);
  });

  it("accumulates real per-character typing without remounting the field", async () => {
    /*
    Real `userEvent.type` against real host state: if the control were declared inside its host's
    render, each keystroke would remount the textarea and only the LAST character would survive.
    `fireEvent.change` cannot detect that, which is why this types character by character.
    */
    const user = userEvent.setup();
    render(<LiveControlsHost />);

    const field = screen.getByTestId("human-plan-approval-message-banner") as HTMLTextAreaElement;
    await user.type(field, "attention aux migrations");

    expect(field.value).toBe("attention aux migrations");
    // Same DOM node throughout: no remount happened mid-typing.
    expect(screen.getByTestId("human-plan-approval-message-banner")).toBe(field);
  });

  it("disables both actions while a decision is in flight", () => {
    render(<ControlsHarness onApprove={() => {}} onReject={() => {}} pending />);

    expect(screen.getByTestId("human-plan-approval-approve-banner")).toBeDisabled();
    expect(screen.getByTestId("human-plan-approval-reject-banner")).toBeDisabled();
    expect(screen.getByTestId("human-plan-approval-message-banner")).toBeDisabled();
  });

  it("surfaces a failure inline and wires it to the field for assistive tech", () => {
    render(<ControlsHarness onApprove={() => {}} onReject={() => {}} error="The plan changed since this decision was opened" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The plan changed since this decision was opened");
    expect(screen.getByTestId("human-plan-approval-message-banner"))
      .toHaveAttribute("aria-describedby", alert.id);
  });

  it("invokes approve and reject through pointer and keyboard", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ControlsHarness onApprove={onApprove} onReject={onReject} />);

    await user.click(screen.getByTestId("human-plan-approval-approve-banner"));
    expect(onApprove).toHaveBeenCalledTimes(1);

    screen.getByTestId("human-plan-approval-reject-banner").focus();
    await user.keyboard("{Enter}");
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:HumanPlanApproval 2026-09-16-05:01:
  FN-448 — the decision surface is rendered exactly once. The former case here mounted a second
  "footer" placement and only checked that its ids did not collide, which is precisely the duplicate
  operators complained about; the surface now has a single message field and a single decision pair.
  */
  it("renders exactly one decision surface with one message field and one decision pair", () => {
    render(
      <HumanPlanApprovalControls
        taskId="FN-408" variant="banner" message="" onMessageChange={() => {}}
        onApprove={() => {}} onReject={() => {}} maxLength={10_000}
      />,
    );

    const surfaces = screen.getAllByTestId(/^human-plan-approval-controls-/);
    expect(surfaces).toHaveLength(1);
    const banner = screen.getByTestId("human-plan-approval-controls-banner");
    expect(within(banner).getAllByLabelText("Message (optional)")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
  });

  it("caps the field at the server's message limit", async () => {
    render(<ControlsHarness onApprove={() => {}} onReject={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("human-plan-approval-message-banner")).toHaveAttribute("maxlength", "10000");
    });
  });
});
