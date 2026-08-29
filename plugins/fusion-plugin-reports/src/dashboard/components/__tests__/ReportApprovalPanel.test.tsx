import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportApprovalPanel } from "../ReportApprovalPanel.js";

vi.mock("../../api.js", () => ({
  approveReport: vi.fn(async () => ({ ...baseReport, approvalState: "approved" })),
  rejectReport: vi.fn(async () => ({ ...baseReport, approvalState: "rejected" })),
  publishReport: vi.fn(async () => ({ ...baseReport, approvalState: "published" })),
}));

const baseReport: any = {
  id: "rep_1",
  approvalState: "awaiting_approval",
  approvalHistory: [],
  status: "review_complete",
};

afterEach(() => cleanup());

describe("ReportApprovalPanel", () => {
  it("renders actions for awaiting approval and posts approve", async () => {
    const onReportChange = vi.fn();
    render(<ReportApprovalPanel report={baseReport} onReportChange={onReportChange} />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(onReportChange).toHaveBeenCalled());
  });

  it("renders publish action for approved", () => {
    render(<ReportApprovalPanel report={{ ...baseReport, approvalState: "approved" }} onReportChange={vi.fn()} />);
    expect(screen.getByText("Publish")).toBeInTheDocument();
  });

  it("read-only for rejected", () => {
    render(<ReportApprovalPanel report={{ id: "rep_1", status: "review_complete", approvalState: "rejected", approvalHistory: [{ action: "reject", decidedAt: "now", decidedBy: "u" }] } as any} onReportChange={vi.fn()} />);
    expect(screen.queryByText("Publish")).toBeNull();
    expect(screen.getByText(/reject by/i)).toBeInTheDocument();
  });
});
