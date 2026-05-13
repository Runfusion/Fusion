import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";

const REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY = "fn-task-review-markdown";

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
    window.localStorage.clear();
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
    expect(screen.getAllByText("Looks good").length).toBeGreaterThan(0);
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

  it("renders PR-mode empty state when no review items are available", async () => {
    const task = makeTask({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] },
        items: [],
        addressing: [],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    expect(await screen.findByText("No review items yet.")).toBeInTheDocument();
  });

  it("shows load error when initial review fetch fails", async () => {
    apiMocks.fetchTaskReview.mockRejectedValue(new Error("boom"));

    render(<TaskReviewTab task={makeTask()} addToast={vi.fn()} />);

    expect(await screen.findByText("Failed to load review data.")).toBeInTheDocument();
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

  it("FN-4137 keeps markdown body clicks from toggling the review-item checkbox", async () => {
    const task = makeTask({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-markdown-click-1",
            body: "**bold**\n\n[details](https://example.test/review)",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            summary: "Markdown body click target",
          },
        ],
        addressing: [],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(screen.getByText("bold"));

    expect(checkbox).not.toBeChecked();
  });

  it("renders markdown by default and persists plain-text toggle preference", async () => {
    const task = makeTask({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-markdown-1",
            body: "**bold**\n\n- item one",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            summary: "Markdown body",
          },
        ],
        addressing: [],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    const { container, unmount } = render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await screen.findByText("Markdown body");
    expect(container.querySelector("strong")?.textContent).toBe("bold");

    fireEvent.click(screen.getByTestId("task-review-markdown-toggle"));

    await waitFor(() => expect(container.querySelector("pre.task-review-tab__body")?.textContent).toContain("**bold**"));
    expect(window.localStorage.getItem(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY)).toBe("false");
    expect(container.querySelector("strong")).toBeNull();

    unmount();
    const rerendered = render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await screen.findByText("Markdown body");
    await waitFor(() => expect(rerendered.container.querySelector("pre.task-review-tab__body")?.textContent).toContain("**bold**"));
    expect(screen.getByTestId("task-review-markdown-toggle")).toHaveTextContent("Plain");
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
            path: "src/parser.ts",
            summary: "Parser guard is missing",
            threadId: "thread-1",
            line: 42,
            url: "https://example.test/thread/1",
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

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, [expect.objectContaining({
      id: "ri-1",
      source: "pr-review",
      threadId: "thread-1",
      filePath: "src/parser.ts",
      lineNumber: 42,
      author: "reviewer",
      summary: "Parser guard is missing",
      url: "https://example.test/thread/1",
    })], undefined);
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
    expect(screen.getByText("code review Step 3: APPROVE")).toBeInTheDocument();
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
    expect(await screen.findByText("code review Step 2: REVISE")).toBeInTheDocument();
    expect(screen.getAllByText("REVISE").length).toBeGreaterThan(0);
  });

  it("renders all persisted addressing progress states from snapshots", async () => {
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs updates" },
        items: [],
        addressing: [
          {
            itemId: "ri-queued",
            status: "queued",
            selectedAt: new Date().toISOString(),
            snapshot: { itemId: "ri-queued", sourceMode: "direct", source: "reviewer-agent", summary: "queued item", body: "queued body" },
          },
          {
            itemId: "ri-progress",
            status: "in-progress",
            selectedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            snapshot: { itemId: "ri-progress", sourceMode: "direct", source: "reviewer-agent", summary: "in progress item", body: "in progress body" },
          },
          {
            itemId: "ri-addressed",
            status: "addressed",
            selectedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            snapshot: { itemId: "ri-addressed", sourceMode: "direct", source: "reviewer-agent", summary: "addressed item", body: "addressed body" },
          },
          {
            itemId: "ri-failed",
            status: "failed",
            selectedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: "Patch failed",
            snapshot: { itemId: "ri-failed", sourceMode: "direct", source: "reviewer-agent", summary: "failed item", body: "failed body" },
          },
        ],
      },
      automationStatus: null,
      emptyMessage: null,
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);

    expect(await screen.findByText("queued item")).toBeInTheDocument();
    expect(screen.getByText("in progress item")).toBeInTheDocument();
    expect(screen.getByText("addressed item")).toBeInTheDocument();
    expect(screen.getByText("failed item")).toBeInTheDocument();
    expect(screen.queryByText("No review items yet.")).not.toBeInTheDocument();
    expect(screen.getByText(/Error: Patch failed/)).toBeInTheDocument();

    expect(screen.getByText("queued").className).toContain("task-review-tab__status--queued");
    expect(screen.getByText("in-progress").className).toContain("task-review-tab__status--in-progress");
    expect(screen.getByText("addressed").className).toContain("task-review-tab__status--addressed");
    expect(screen.getByText("failed").className).toContain("task-review-tab__status--failed");
  });

  it("renders persisted addressing snapshot entries after reload", async () => {
    const task = makeTask();
    apiMocks.fetchTaskReview.mockResolvedValue({
      reviewState: {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [],
        addressing: [{
          itemId: "ri-stale",
          status: "failed",
          selectedAt: new Date().toISOString(),
          error: "Patch failed",
          snapshot: {
            itemId: "ri-stale",
            sourceMode: "pull-request",
            source: "pr-review",
            summary: "Fix edge case",
            body: "Fix edge case in parser",
          },
        }],
      },
      automationStatus: null,
      emptyMessage: null,
    });

    render(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByText("Fix edge case")).toBeInTheDocument();
    expect(screen.getByText(/Error: Patch failed/)).toBeInTheDocument();
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
