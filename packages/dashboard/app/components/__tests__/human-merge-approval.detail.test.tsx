/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0/P1 remediation — the decision panel MOUNTED IN ITS REAL HOST.

Review found the feature had no test that rendered the panel at all: the only UI suite asserted the
context-menu model and the card badge. This one mounts the production `TaskDetailModal`, drives the
real `useTaskMergeApproval` hook against controlled API responses, and asserts the operator contract
the specification fixes:

  • the panel appears ONLY from the server's availability answer, never from a status guess;
  • exactly ONE field and exactly THREE buttons — «Create PR», «Merge», «Reject» — in that order,
    with no «Approve» button and no destination selector;
  • each button issues its OWN command, so «Create PR» never merges;
  • a positive note may be empty; a rejection may not, in the UI and at the API;
  • Enter in the field inserts a newline and never submits a merge;
  • an unavailable action stays visible and disabled with an accessible reason, while Reject stays
    available — it does not depend on GitHub;
  • an error preserves the typed draft, and typing does not remount the field.
*/
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalApi = vi.hoisted(() => ({
  fetchTaskMergeApproval: vi.fn(),
  submitTaskMergeDecision: vi.fn(),
  setTaskMergeApprovalLock: vi.fn(),
}));

vi.mock("../../api/tasks/task-merge-approval.js", () => approvalApi);

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();
void noopMove;

const CAPABILITIES_ALL = [
  { action: "create-pr" as const, enabled: true },
  { action: "merge" as const, enabled: true },
  { action: "reject" as const, enabled: true },
];

function decisionPoint(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    available: true,
    candidateToken: "tok-1",
    capabilities: CAPABILITIES_ALL,
    revision: "2026-09-17T10:00:00Z",
    ...over,
  };
}

function renderDetail(taskOverrides: Record<string, unknown> = {}) {
  const task = makeTask({ id: "FN-514", column: "in-review", ...taskOverrides } as never);
  return render(
    <TaskDetailModal
      task={task}
      projectId="project-123"
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={vi.fn()}
      onTaskUpdated={vi.fn()}
    />,
  );
}

describe("FN-514 — the delivery decision panel in Task Detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalApi.submitTaskMergeDecision.mockResolvedValue({ task: {}, action: "merge", replayed: false });
    approvalApi.setTaskMergeApprovalLock.mockResolvedValue({ task: {}, replayed: false });
  });

  it("does not render before the server says a decision is due", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint({
      available: false,
      unavailableReason: "blocked",
      blocker: "task has incomplete or failed pre-merge workflow steps",
    }));
    renderDetail();
    await waitFor(() => expect(approvalApi.fetchTaskMergeApproval).toHaveBeenCalled());
    expect(screen.queryByTestId("human-merge-approval-controls")).toBeNull();
  });

  it("does not render for a card with no delivery lock", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint({ enabled: false, available: false }));
    renderDetail();
    await waitFor(() => expect(approvalApi.fetchTaskMergeApproval).toHaveBeenCalled());
    expect(screen.queryByTestId("human-merge-approval-controls")).toBeNull();
  });

  it("renders exactly one field and the three direct commands in order, with no Approve or selector", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();

    const panel = await screen.findByTestId("human-merge-approval-controls");
    expect(within(panel).getAllByRole("textbox")).toHaveLength(1);

    const buttons = within(panel).getAllByRole("button").map((button) => button.textContent?.trim());
    expect(buttons).toEqual(["Create PR", "Merge", "Reject"]);
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /approve/i })).toBeNull();
    // The banner is the SINGLE placement: no duplicate field anywhere else in the modal.
    expect(screen.getAllByTestId("human-merge-approval-message")).toHaveLength(1);
  });

  it("sends the chosen command and nothing else — Create PR never merges", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    await userEvent.click(screen.getByTestId("human-merge-approval-create-pr"));

    await waitFor(() => expect(approvalApi.submitTaskMergeDecision).toHaveBeenCalledTimes(1));
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1]).toMatchObject({
      action: "create-pr",
      candidateToken: "tok-1",
    });
    // No note is required for a positive command.
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1].message).toBeUndefined();
  });

  it("sends a merge command with the optional note attached", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    await userEvent.type(screen.getByTestId("human-merge-approval-message"), "Bon pour livraison");
    await userEvent.click(screen.getByTestId("human-merge-approval-merge"));

    await waitFor(() => expect(approvalApi.submitTaskMergeDecision).toHaveBeenCalledTimes(1));
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1]).toMatchObject({
      action: "merge",
      message: "Bon pour livraison",
    });
  });

  it("refuses an empty rejection in the UI and never reaches the API", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    expect(screen.getByTestId("human-merge-approval-reject")).toBeDisabled();
    expect(screen.getByTestId("human-merge-approval-reject-hint")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("human-merge-approval-reject"));
    expect(approvalApi.submitTaskMergeDecision).not.toHaveBeenCalled();

    // Whitespace alone is not an instruction.
    await userEvent.type(screen.getByTestId("human-merge-approval-message"), "   ");
    expect(screen.getByTestId("human-merge-approval-reject")).toBeDisabled();

    await userEvent.type(screen.getByTestId("human-merge-approval-message"), "refais la navigation");
    await userEvent.click(screen.getByTestId("human-merge-approval-reject"));
    await waitFor(() => expect(approvalApi.submitTaskMergeDecision).toHaveBeenCalledTimes(1));
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1]).toMatchObject({ action: "reject" });
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1].message).toContain("refais la navigation");
  });

  it("never merges because Enter was pressed in the field", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    const field = screen.getByTestId("human-merge-approval-message") as HTMLTextAreaElement;
    await userEvent.type(field, "première ligne{Enter}seconde ligne");
    expect(approvalApi.submitTaskMergeDecision).not.toHaveBeenCalled();
    expect(field.value).toContain("\n");
  });

  it("activates only the focused button under keyboard control", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    screen.getByTestId("human-merge-approval-create-pr").focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(approvalApi.submitTaskMergeDecision).toHaveBeenCalledTimes(1));
    expect(approvalApi.submitTaskMergeDecision.mock.calls[0]![1].action).toBe("create-pr");
  });

  it("explains an unavailable Create PR without ever disabling Reject", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint({
      capabilities: [
        { action: "create-pr", enabled: false, reason: "github-auth-unavailable" },
        { action: "merge", enabled: true },
        { action: "reject", enabled: true },
      ],
    }));
    renderDetail();
    const panel = await screen.findByTestId("human-merge-approval-controls");

    const createPr = screen.getByTestId("human-merge-approval-create-pr");
    expect(createPr).toBeVisible();
    expect(createPr).toBeDisabled();
    // The reason is accessible, not merely visual.
    const describedBy = createPr.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(panel.querySelector(`#${CSS.escape(describedBy!)}`)?.textContent)
      .toContain("GitHub is not connected");

    // Reject does not depend on GitHub; a local merge stays available too.
    await userEvent.type(screen.getByTestId("human-merge-approval-message"), "refais");
    expect(screen.getByTestId("human-merge-approval-reject")).toBeEnabled();
    expect(screen.getByTestId("human-merge-approval-merge")).toBeEnabled();
  });

  it("keeps the typed draft and the same field node when a command fails", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    approvalApi.submitTaskMergeDecision.mockRejectedValue(new Error("This task changed since the page was loaded"));
    renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    const field = screen.getByTestId("human-merge-approval-message");
    await userEvent.type(field, "refais la navigation mobile");
    await userEvent.click(screen.getByTestId("human-merge-approval-reject"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This task changed since the page was loaded"));
    // The instruction is NOT retyped, and the textarea is the same DOM node (no remount mid-typing).
    expect(screen.getByTestId("human-merge-approval-message")).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("refais la navigation mobile");
  });

  it("shows the open pull request link without claiming the card is delivered", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint());
    renderDetail({
      humanMergeApproval: {
        enabled: true,
        generation: 1,
        decision: {
          requestId: "r1",
          action: "create-pr",
          deliveryAction: "create-pr",
          decidedBy: "dashboard-operator",
          decidedAt: "t",
          candidate: { lockGeneration: 1, workflowSignature: "w", reviewEpisodeId: "e", contentSignature: "c", targetSignature: "t" },
          receipt: { state: "succeeded", at: "t", prNumber: 42, prUrl: "https://github.test/acme/widgets/pull/42" },
        },
      },
    });
    await screen.findByTestId("human-merge-approval-controls");

    expect(screen.getByTestId("human-merge-approval-pr-link")).toHaveTextContent("https://github.test/acme/widgets/pull/42");
    // A handoff is not a merge: a further explicit command is still offered.
    expect(screen.getByTestId("human-merge-approval-merge")).toBeEnabled();
  });

  it("stays mounted while a rejection is being corrected, and reports the state", async () => {
    approvalApi.fetchTaskMergeApproval.mockResolvedValue(decisionPoint({
      available: false,
      unavailableReason: "rejection-in-progress",
    }));
    renderDetail({
      humanMergeApproval: {
        enabled: true,
        generation: 1,
        remediationGeneration: 1,
        rejection: {
          requestId: "j1",
          instruction: "refais",
          rejectedBy: "op",
          rejectedAt: "t",
          candidate: { lockGeneration: 1, workflowSignature: "w", reviewEpisodeId: "e", contentSignature: "c", targetSignature: "t" },
          remediationGeneration: 1,
          state: "analyzing",
        },
      },
    });

    const state = await screen.findByTestId("human-merge-approval-correction-state");
    expect(state).toHaveTextContent("Working out how to correct the rejected delivery");
  });

  it("does not reuse a previous card's candidate token when the task changes", async () => {
    approvalApi.fetchTaskMergeApproval.mockImplementation(async (taskId: string) =>
      decisionPoint({ candidateToken: `tok-${taskId}` }));

    const { rerender } = renderDetail();
    await screen.findByTestId("human-merge-approval-controls");

    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-515", column: "in-review" } as never)}
        projectId="project-123"
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        onTaskUpdated={vi.fn()}
      />,
    );

    await waitFor(() => expect(approvalApi.fetchTaskMergeApproval).toHaveBeenCalledWith("FN-515", "project-123"));
    await userEvent.click(await screen.findByTestId("human-merge-approval-merge"));
    await waitFor(() => expect(approvalApi.submitTaskMergeDecision).toHaveBeenCalled());
    const [taskId, payload] = approvalApi.submitTaskMergeDecision.mock.calls[0]!;
    expect(taskId).toBe("FN-515");
    expect(payload.candidateToken).toBe("tok-FN-515");
  });
});
