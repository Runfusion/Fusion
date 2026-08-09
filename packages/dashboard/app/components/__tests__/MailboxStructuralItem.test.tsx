import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailboxKindBadge, MailboxStructuralItem } from "../MailboxStructuralItem";
import { decideApproval, fetchApprovalDetail } from "../../api";

vi.mock("../../api", () => ({ decideApproval: vi.fn(), fetchApprovalDetail: vi.fn() }));

describe("MailboxStructuralItem", () => {
  it("adds no shell or badge to ordinary mail", () => {
    const { container } = render(<><MailboxKindBadge metadata={{}} /><MailboxStructuralItem metadata={{}} /></>);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders report sections through the mailbox content pipeline", () => {
    render(<MailboxStructuralItem metadata={{ mailKind: "report", report: { title: "Release", sections: [{ heading: "Summary", body: "| A | B |\n| - | - |\n| 1 | 2 |" }] } }} />);
    expect(screen.getByTestId("mailbox-structural-report")).toHaveTextContent("Release");
    expect(screen.getByTestId("mailbox-report-section-body").querySelector("table")).toBeInTheDocument();
  });

  it("makes approval decisions single-shot and leaves missing requests read-only", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(fetchApprovalDetail).mockResolvedValue({ id: "approval-1", status: "pending" } as any);
    vi.mocked(decideApproval).mockResolvedValue({ id: "approval-1", status: "approved" } as any);
    const { rerender } = render(<MailboxStructuralItem projectId="project-1" metadata={{ mailKind: "approval", approvalRequestId: "approval-1" }} />);
    await user.type(await screen.findByTestId("mailbox-inline-approval-comment"), "looks good");
    await user.click(screen.getByTestId("mailbox-inline-approval-approve"));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("approval-1", { decision: "approve", comment: "looks good" }, "project-1"));
    expect(screen.queryByTestId("mailbox-inline-approval-approve")).not.toBeInTheDocument();
    rerender(<MailboxStructuralItem metadata={{ mailKind: "approval", approvalRequestId: "" }} />);
    expect(await screen.findByTestId("mailbox-approval-unresolvable")).toBeInTheDocument();
    expect(fetchApprovalDetail).toHaveBeenCalledTimes(1);
  });

  it.each(["approved", "denied", "completed"] as const)("renders %s approvals as terminal read-only state", async (status) => {
    vi.mocked(fetchApprovalDetail).mockResolvedValue({ id: "approval-terminal", status } as any);
    render(<MailboxStructuralItem metadata={{ mailKind: "approval", approvalRequestId: "approval-terminal" }} />);
    expect(await screen.findByTestId("mailbox-inline-approval-status")).toHaveTextContent(status);
    expect(screen.queryByTestId("mailbox-inline-approval-approve")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-inline-approval-deny")).not.toBeInTheDocument();
  });

  it("does not let a prior approval decision replace a newly selected approval", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    let resolveDecision!: (detail: any) => void;
    vi.mocked(fetchApprovalDetail)
      .mockResolvedValueOnce({ id: "approval-old", status: "pending" } as any)
      .mockResolvedValueOnce({ id: "approval-new", status: "pending" } as any);
    vi.mocked(decideApproval).mockImplementationOnce(() => new Promise((resolve) => { resolveDecision = resolve; }) as any);
    const { rerender } = render(<MailboxStructuralItem metadata={{ mailKind: "approval", approvalRequestId: "approval-old" }} />);
    await user.click(await screen.findByTestId("mailbox-inline-approval-approve"));
    const fetchCallsBeforeSwitch = vi.mocked(fetchApprovalDetail).mock.calls.length;
    rerender(<MailboxStructuralItem metadata={{ mailKind: "approval", approvalRequestId: "approval-new" }} />);
    await waitFor(() => expect(vi.mocked(fetchApprovalDetail).mock.calls.length).toBe(fetchCallsBeforeSwitch + 1));
    await screen.findByTestId("mailbox-inline-approval-approve");
    resolveDecision({ id: "approval-old", status: "approved" });
    await waitFor(() => expect(screen.getByTestId("mailbox-inline-approval-approve")).toBeInTheDocument());
  });

  it("does not let an old-project decision overwrite the active project approval", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    let resolveDecision!: (detail: any) => void;
    vi.mocked(fetchApprovalDetail).mockResolvedValue({ id: "approval-project", status: "pending" } as any);
    vi.mocked(decideApproval).mockImplementationOnce(() => new Promise((resolve) => { resolveDecision = resolve; }) as any);
    const { rerender } = render(<MailboxStructuralItem projectId="project-old" metadata={{ mailKind: "approval", approvalRequestId: "approval-project" }} />);
    await user.click(await screen.findByTestId("mailbox-inline-approval-approve"));
    rerender(<MailboxStructuralItem projectId="project-new" metadata={{ mailKind: "approval", approvalRequestId: "approval-project" }} />);
    await screen.findByTestId("mailbox-inline-approval-approve");
    resolveDecision({ id: "approval-project", status: "approved" });
    await waitFor(() => expect(screen.getByTestId("mailbox-inline-approval-approve")).toBeInTheDocument());
  });

  it("reports unresolvable fetched approvals without exposing a decision", async () => {
    vi.mocked(fetchApprovalDetail).mockRejectedValue(new Error("gone"));
    render(<MailboxStructuralItem metadata={{ mailKind: "approval", approvalRequestId: "missing" }} />);
    expect(await screen.findByTestId("mailbox-approval-unresolvable")).toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-inline-approval-approve")).not.toBeInTheDocument();
  });

  it("sends denial with the optional comment", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(fetchApprovalDetail).mockResolvedValue({ id: "approval-deny", status: "pending" } as any);
    vi.mocked(decideApproval).mockResolvedValue({ id: "approval-deny", status: "denied" } as any);
    render(<MailboxStructuralItem projectId="project-1" metadata={{ mailKind: "approval", approvalRequestId: "approval-deny" }} />);
    await user.type(await screen.findByTestId("mailbox-inline-approval-comment"), "needs revision");
    await user.click(screen.getByTestId("mailbox-inline-approval-deny"));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("approval-deny", { decision: "deny", comment: "needs revision" }, "project-1"));
    expect(screen.queryByTestId("mailbox-inline-approval-deny")).not.toBeInTheDocument();
  });
});
