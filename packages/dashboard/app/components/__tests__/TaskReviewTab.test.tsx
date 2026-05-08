import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";

const apiMocks = vi.hoisted(() => ({
  refreshTaskReview: vi.fn(),
  reviseTaskReviewItems: vi.fn(),
}));

vi.mock("../../api", () => ({
  refreshTaskReview: apiMocks.refreshTaskReview,
  reviseTaskReviewItems: apiMocks.reviseTaskReviewItems,
}));

describe("TaskReviewTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when review is missing", () => {
    render(<TaskReviewTab task={makeTask({ reviewState: undefined })} addToast={vi.fn()} />);
    expect(screen.getByText("GitHub PR review details are only available when auto-merge uses Pull Request mode. Reviewer-agent feedback will appear here in direct mode.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  });

  it("calls refresh endpoint", async () => {
    const task = makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [] } });
    apiMocks.refreshTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(apiMocks.refreshTaskReview).toHaveBeenCalledWith(task.id, undefined);
  });

  it("renders PR decision and status modifiers", () => {
    const task = makeTask({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [
          {
            id: "ri-1",
            body: "Fix null handling",
            author: { login: "reviewer" },
            createdAt: new Date().toISOString(),
          },
        ],
        addressing: [{ itemId: "ri-1", status: "failed", selectedAt: new Date().toISOString() }],
      },
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(screen.getByText("CHANGES_REQUESTED")).toBeInTheDocument();
    expect(screen.getByText("failed").className).toContain("task-review-tab__status--failed");
  });

  it("renders review items and queues revision for selected entries", async () => {
    const task = makeTask({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [
          {
            id: "ri-1",
            body: "Fix null handling",
            author: { login: "reviewer" },
            createdAt: new Date().toISOString(),
          },
        ],
        addressing: [{ itemId: "ri-1", status: "queued", selectedAt: new Date().toISOString() }],
      },
    });

    apiMocks.reviseTaskReviewItems.mockResolvedValue({ task, reviewState: task.reviewState });
    apiMocks.refreshTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, ["ri-1"], undefined);
  });
});
