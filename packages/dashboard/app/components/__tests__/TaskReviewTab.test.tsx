import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";

const apiMocks = vi.hoisted(() => ({
  fetchTaskReview: vi.fn(),
  refreshTaskReview: vi.fn(),
  reviseTaskReviewItems: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchTaskReview: apiMocks.fetchTaskReview,
  refreshTaskReview: apiMocks.refreshTaskReview,
  reviseTaskReviewItems: apiMocks.reviseTaskReviewItems,
}));

describe("TaskReviewTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders direct-mode empty state when no reviewer feedback exists", async () => {
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: { source: "reviewer-agent", items: [], addressing: [] },
      automationStatus: null,
      emptyMessage: "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.",
    });

    render(<TaskReviewTab task={makeTask({ reviewState: undefined })} addToast={vi.fn()} />);
    expect(await screen.findByText("No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  });

  it("calls refresh endpoint and updates rendered PR content in place", async () => {
    const addToast = vi.fn();
    const task = makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [], refreshStatus: "ready" } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.refreshTaskReview.mockResolvedValue({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "APPROVED", reviewers: [{ login: "octocat", state: "APPROVED" }], blockingReasons: [], checks: [] },
        items: [{ id: "ri-2", body: "Looks good", author: { login: "octocat" }, createdAt: new Date().toISOString() }],
        addressing: [],
        refreshStatus: "ready",
      },
      automationStatus: null,
    });
    render(<TaskReviewTab task={task} addToast={addToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(apiMocks.refreshTaskReview).toHaveBeenCalledWith(task.id, undefined);
    expect(await screen.findByText("APPROVED")).toBeInTheDocument();
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("Review refreshed", "success");
  });

  it("shows in-flight refresh state while refresh is pending", async () => {
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    const task = makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.refreshTaskReview.mockReturnValue(refreshPromise as Promise<never>);

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

    resolveRefresh?.({ reviewState: task.reviewState, automationStatus: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });

  it("shows scoped refresh error when refresh response reports error state", async () => {
    const addToast = vi.fn();
    const task = makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.refreshTaskReview.mockResolvedValue({
      reviewState: {
        ...task.reviewState,
        refreshStatus: "error",
        refreshError: "GitHub rate limit reached",
      },
      automationStatus: null,
      prInfo: task.prInfo,
    });

    render(<TaskReviewTab task={task} addToast={addToast} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("GitHub rate limit reached")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("GitHub rate limit reached", "error");
  });

  it("renders PR decision and status modifiers", async () => {
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

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    await screen.findByText("CHANGES_REQUESTED");
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

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    apiMocks.reviseTaskReviewItems.mockResolvedValue({ task, reviewState: task.reviewState });
    apiMocks.refreshTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, [expect.objectContaining({ id: "ri-1", source: "pr-review" })], undefined);
  });

  it("refreshes and updates direct-mode reviewer-agent content", async () => {
    const addToast = vi.fn();
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { summary: "No feedback" },
        items: [],
        addressing: [],
      },
      automationStatus: null,
      emptyMessage: null,
    });
    apiMocks.refreshTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "APPROVE", reviewType: "code", summary: "Ship it" },
        items: [
          {
            id: "reviewer-code-2",
            body: "## Code Review:\n\n### Verdict:\nAPPROVE",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            reviewType: "code",
            verdict: "APPROVE",
            step: 3,
            summary: "code review Step 3: APPROVE",
          },
        ],
        addressing: [],
        refreshStatus: "ready",
      },
      automationStatus: null,
    });

    render(<TaskReviewTab task={task} addToast={addToast} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect((await screen.findAllByText("APPROVE")).length).toBeGreaterThan(0);
    expect(screen.getByText("Step 3")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("Review refreshed", "success");
  });

  it("renders reviewer-agent entries in direct mode", async () => {
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-code-1",
            body: "## Code Review:\n\n### Verdict:\nREVISE",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            reviewType: "code",
            verdict: "REVISE",
            step: 2,
            summary: "code review Step 2: REVISE",
          },
        ],
        addressing: [{ itemId: "reviewer-code-1", status: "in-progress", selectedAt: new Date().toISOString() }],
      },
      automationStatus: null,
      emptyMessage: null,
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByText("reviewer-agent")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.getAllByText("REVISE").length).toBeGreaterThan(0);
  });

  it("submits reviewer-agent selections through same revision action", async () => {
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [{ id: "reviewer-code-1", body: "Fix the failing test", author: { login: "reviewer-agent" }, createdAt: new Date().toISOString(), summary: "Fix failing test" }],
        addressing: [],
      },
      automationStatus: null,
      emptyMessage: null,
    });
    apiMocks.reviseTaskReviewItems.mockResolvedValue({ task: makeTask(), reviewState: { source: "reviewer-agent", items: [], addressing: [] } });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, [expect.objectContaining({ id: "reviewer-code-1", source: "reviewer-agent" })], undefined);
  });
});
