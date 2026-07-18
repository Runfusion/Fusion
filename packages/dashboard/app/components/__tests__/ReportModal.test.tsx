import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportModal } from "../ReportModal";
import * as api from "../../api";

vi.mock("../../api", () => ({
  reportDraft: vi.fn(),
  reportFile: vi.fn(),
  reportHelp: vi.fn(),
}));

const reportDraft = vi.mocked(api.reportDraft);
const reportFile = vi.mocked(api.reportFile);

describe("ReportModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows an actionable error and retry affordance when preparing a report fails", async () => {
    reportDraft.mockRejectedValueOnce(new Error("offline"));
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not prepare");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();

    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reportDraft).toHaveBeenCalledTimes(2));
  });

  it("preserves an editable draft and makes filing failures retryable", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    reportFile.mockRejectedValueOnce(new Error("offline"));
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review your report");
    fireEvent.click(screen.getByRole("button", { name: "File report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("draft is still here");
    expect(screen.getByRole("button", { name: "File report" })).toBeEnabled();
  });

  it("shows an editable draft and requires confirmation before endorsing a duplicate", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "duplicate-found", issue: { number: 22, url: "https://example.test/22", title: "Existing issue" }, report: { userPrompt: "It crashes", body: "## Summary\nIt crashes", context: {} } });
    reportFile.mockResolvedValueOnce({ kind: "endorsed", url: "https://example.test/comments/1" });
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review data point for a similar open issue");
    expect(reportFile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Report summary"), { target: { value: "It crashes after saving" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and add data point" }));

    await waitFor(() => expect(reportFile).toHaveBeenCalledWith(expect.objectContaining({
      endorseIssueNumber: 22,
      report: expect.objectContaining({ userPrompt: "It crashes after saving" }),
    })));
  });

  it("shows a roadmap match inline without a filing or dead-link affordance", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "roadmap-match", roadmap: { featureId: "RF-1", title: "Offline report queue", description: "Keep reports available while offline" } });
    render(<ReportModal actionType="idea" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What would you like Fusion to do?"), { target: { value: "Keep reports while offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Already on the roadmap")).toBeInTheDocument();
    expect(screen.getByText("Offline report queue")).toBeInTheDocument();
    expect(screen.getByText("Keep reports available while offline")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /file/i })).not.toBeInTheDocument();
  });

  it("lets people return to the guided prompt after an unavailable response", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "unavailable", message: "GitHub is not connected" });
    render(<ReportModal actionType="feedback" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What would you like to share?"), { target: { value: "A thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Return to prompt" }));
    expect(screen.getByLabelText("What would you like to share?")).toBeInTheDocument();
  });

  it("keeps the original derivation marker when the review prompt is edited", async () => {
    reportDraft.mockResolvedValueOnce({ kind: "draft-ready", report: { userPrompt: "It crashes", sourcePrompt: "It crashes", body: "## Summary\nIt crashes\n\n## Environment\nCollected context", context: {} } });
    reportFile.mockResolvedValueOnce({ kind: "filed", url: "https://example.test/1" });
    render(<ReportModal actionType="bug" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It crashes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Review your report");
    fireEvent.change(screen.getByLabelText("Report summary"), { target: { value: "It crashes after saving" } });
    fireEvent.click(screen.getByRole("button", { name: "File report" }));

    await waitFor(() => expect(reportFile).toHaveBeenCalledOnce());
    expect(reportFile).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({
      userPrompt: "It crashes after saving",
      sourcePrompt: "It crashes",
      body: expect.stringContaining("## Environment"),
    }) }));
  });
});
