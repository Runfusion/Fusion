/*
FNXC:DashboardTests 2026-06-14-08:31:
FN-6441 rescued this orphaned component test after standalone dashboard-app execution passed without assertion, timeout, or source-code changes. Keep it registered through the app backfill lane so task-review UI regressions cannot silently fall out of quality coverage again.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskReviewTab } from "../TaskReviewTab";
import { makeTask } from "./TaskDetailModal.test-helpers";
import { loadAllAppCss } from "../../test/cssFixture";

const REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY = "fn-task-review-markdown";

const apiMocks = vi.hoisted(() => ({
  fetchTaskReview: vi.fn(),
  refreshTaskReview: vi.fn(),
  reviseTaskReviewItems: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchTaskReview: apiMocks.fetchTaskReview,
  refreshTaskReview: apiMocks.refreshTaskReview,
  reviseTaskReviewItems: apiMocks.reviseTaskReviewItems,
  updateTask: apiMocks.updateTask,
}));

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

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

    await renderWithAct(<TaskReviewTab task={makeTask({ reviewState: undefined })} addToast={vi.fn()} />);
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
    await renderWithAct(<TaskReviewTab task={task} addToast={addToast} />);
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

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);
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

    await renderWithAct(<TaskReviewTab task={task} addToast={addToast} />);

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
    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    expect(await screen.findByText("No review items yet.")).toBeInTheDocument();
  });

  it("shows load error when initial review fetch fails", async () => {
    apiMocks.fetchTaskReview.mockRejectedValue(new Error("boom"));

    await renderWithAct(<TaskReviewTab task={makeTask()} addToast={vi.fn()} />);

    expect(await screen.findByText("Failed to load review data.")).toBeInTheDocument();
  });

  it("renders PR decision, status modifiers, and populated layout hooks", async () => {
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
          },
        ],
        addressing: [{ itemId: "ri-1", status: "failed", selectedAt: new Date().toISOString() }],
      },
    });

    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });
    const { container } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await screen.findByText("CHANGES_REQUESTED");
    expect(screen.getByText("failed").className).toContain("task-review-tab__status--failed");
    expect(container.querySelector(".task-review-tab__header")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__summary-group")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__actions")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__refresh-meta")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__list")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__item-header")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__item-selection")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__item-meta-list")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__body")).not.toBeNull();
  });

  it("keeps review body outside the checkbox label and preserves selection on body clicks", async () => {
    const task = makeTask({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-plain-click-1",
            body: "plain review body",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            summary: "Plain body click target",
          },
        ],
        addressing: [],
      },
    });

    window.localStorage.setItem(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, "false");
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    const { container } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    const body = container.querySelector(".task-review-tab__body");
    expect(body).not.toBeNull();
    expect(body?.closest("label")).toBeNull();

    fireEvent.click(body as HTMLElement);
    expect(checkbox).not.toBeChecked();
  });

  it("renders markdown mode body outside label and clicking links does not toggle selection", async () => {
    const task = makeTask({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-markdown-click-1",
            body: "[example](https://example.com)",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            summary: "Markdown body click target",
          },
        ],
        addressing: [],
      },
    });

    window.localStorage.setItem(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, "true");
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    const { container } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox");
    const link = await screen.findByRole("link", { name: "example" });
    expect(container.querySelector(".task-review-tab__body")?.closest("label")).toBeNull();
    expect(link.closest("label")).toBeNull();

    fireEvent.click(link);
    expect(checkbox).not.toBeChecked();
  });

  it("renders plain mode body outside label when markdown rendering is disabled", async () => {
    const task = makeTask({
      reviewState: {
        source: "reviewer-agent",
        summary: { verdict: "REVISE", reviewType: "code", summary: "Needs fixes" },
        items: [
          {
            id: "reviewer-plain-click-2",
            body: "[example](https://example.com)",
            author: { login: "reviewer-agent" },
            createdAt: new Date().toISOString(),
            summary: "Plain mode item",
          },
        ],
        addressing: [],
      },
    });

    window.localStorage.setItem(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, "false");
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    const { container } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await screen.findByText("Plain mode item");
    await act(async () => {});
    const body = container.querySelector("pre.task-review-tab__body");
    expect(body).not.toBeNull();
    expect(body?.closest("label")).toBeNull();
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

    const { container, unmount } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await screen.findByText("Markdown body");
    expect(container.querySelector("strong")?.textContent).toBe("bold");

    fireEvent.click(screen.getByTestId("task-review-markdown-toggle"));

    await waitFor(() => expect(container.querySelector("pre.task-review-tab__body")?.textContent).toContain("**bold**"));
    expect(window.localStorage.getItem(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY)).toBe("false");
    expect(container.querySelector("strong")).toBeNull();

    unmount();
    const rerendered = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

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

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

    await act(async () => {
      fireEvent.click(await screen.findByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    });

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

    await renderWithAct(<TaskReviewTab task={task} addToast={addToast} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect((await screen.findAllByText("APPROVE")).length).toBeGreaterThan(0);
    expect(screen.getByText("code review Step 3: APPROVE")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("Review refreshed", "success");
  });

  it("renders reviewer-agent entries in direct mode with populated layout hooks", async () => {
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

    const { container } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByText("code review Step 2: REVISE")).toBeInTheDocument();
    expect(screen.getAllByText("REVISE").length).toBeGreaterThan(0);
    expect(container.querySelector(".task-review-tab__item-header")).not.toBeNull();
    expect(container.querySelector(".task-review-tab__item-meta-list")).not.toBeNull();
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

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);

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

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByText("Fix edge case")).toBeInTheDocument();
    expect(screen.getByText(/Error: Patch failed/)).toBeInTheDocument();
  });

  it("keeps mobile actions wrapping contract, stacks header groups, and prevents body overflow regressions", async () => {
    const css = await loadAllAppCss();
    const taskReviewCss = css.slice(css.indexOf(".task-review-tab"));
    const mobileMediaStart = taskReviewCss.indexOf("@media (max-width: 768px)");
    expect(mobileMediaStart).toBeGreaterThanOrEqual(0);
    const mobileCss = taskReviewCss.slice(mobileMediaStart);
    const baseSummaryWrapRule = taskReviewCss.match(/\.task-review-tab__summary-wrap\s*\{[^}]*\}/)?.[0] ?? "";
    const baseBodyRule = taskReviewCss.match(/\.task-review-tab__body\s*\{[^}]*\}/)?.[0] ?? "";

    expect(baseSummaryWrapRule).toMatch(/flex\s*:\s*1\s+1\s+20rem\s*;/);
    expect(baseSummaryWrapRule).not.toMatch(/flex\s*:\s*0\s+0\s+auto\s*;/);
    expect(mobileCss).toMatch(/\.task-review-tab__header\s*\{[^}]*flex-direction\s*:\s*column\s*;[^}]*\}/);
    expect(mobileCss).toMatch(/\.task-review-tab__summary-wrap\s*\{[^}]*flex\s*:\s*0\s+0\s+auto\s*;[^}]*\}/);
    expect(mobileCss).toMatch(/\.task-review-tab__summary-wrap,\s*\.task-review-tab__actions,\s*\.task-review-tab__auto-merge-control\s*\{[^}]*width\s*:\s*100%\s*;[^}]*\}/);
    expect(mobileCss).toMatch(/\.task-review-tab__actions\s*\{[^}]*justify-content\s*:\s*flex-start\s*;[^}]*\}/);
    expect(mobileCss).toMatch(/\.task-review-tab__actions\s+\.btn\s*\{[^}]*width\s*:\s*100%\s*;[^}]*\}/);
    expect(mobileCss).toMatch(/\.task-review-tab__body\s*\{[^}]*padding\s*:\s*var\(--space-sm\)\s*;[^}]*\}/);
    expect(mobileCss).not.toMatch(/\.task-review-tab__actions\s+\.btn\s*\{[^}]*flex\s*:\s*1\s*;[^}]*\}/);

    expect(baseBodyRule).toMatch(/overflow-wrap\s*:\s*anywhere\s*;/);
    expect(baseBodyRule).toMatch(/overflow-x\s*:\s*auto\s*;/);
    expect(taskReviewCss).toMatch(/\.task-review-tab__item\s*\{[^}]*padding\s*:\s*var\(--card-padding\)\s*;[^}]*\}/);
  });

  it("preserves review header structure across sources and empty or populated states", async () => {
    const cases = [
      {
        task: makeTask({ id: "FN-100" }),
        response: {
          reviewState: {
            source: "reviewer-agent" as const,
            summary: { summary: "reviewer-agent", verdict: "REVISE", reviewType: "code" },
            items: [],
            addressing: [],
          },
          automationStatus: null,
          emptyMessage: "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.",
        },
        summaryText: "reviewer-agent · 0 review item(s)",
        emptyText: "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.",
      },
      {
        task: makeTask({ id: "FN-101" }),
        response: {
          reviewState: {
            source: "reviewer-agent" as const,
            summary: { summary: "Needs fixes", verdict: "REVISE", reviewType: "code" },
            items: [{ id: "reviewer-item-1", body: "Fix failing test", author: { login: "reviewer-agent" }, createdAt: new Date().toISOString(), summary: "Fix failing test" }],
            addressing: [],
          },
          automationStatus: null,
          emptyMessage: null,
        },
        summaryText: "Needs fixes · 1 review item(s)",
        itemText: "Fix failing test",
      },
      {
        task: makeTask({ id: "FN-102" }),
        response: {
          reviewState: {
            source: "pull-request" as const,
            summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] },
            items: [],
            addressing: [],
          },
          automationStatus: null,
          emptyMessage: null,
        },
        summaryText: "REVIEW_REQUIRED · 0 review item(s)",
        emptyText: "No review items yet.",
      },
      {
        task: makeTask({ id: "FN-103" }),
        response: {
          reviewState: {
            source: "pull-request" as const,
            summary: { reviewDecision: "APPROVED", reviewers: [], blockingReasons: [], checks: [] },
            items: [{ id: "pr-item-1", body: "Looks good", author: { login: "octocat" }, createdAt: new Date().toISOString(), summary: "Looks good" }],
            addressing: [],
          },
          automationStatus: null,
          emptyMessage: null,
        },
        summaryText: "APPROVED · 1 review item(s)",
        itemText: "Looks good",
      },
    ];

    apiMocks.fetchTaskReview
      .mockResolvedValueOnce(cases[0].response)
      .mockResolvedValueOnce(cases[1].response)
      .mockResolvedValueOnce(cases[2].response)
      .mockResolvedValueOnce(cases[3].response);

    const { container, rerender } = await renderWithAct(<TaskReviewTab task={cases[0].task} addToast={vi.fn()} />);

    for (const [index, testCase] of cases.entries()) {
      if (index > 0) {
        rerender(<TaskReviewTab task={testCase.task} addToast={vi.fn()} />);
      }

      expect(await screen.findByText(testCase.summaryText)).toBeInTheDocument();
      expect(container.querySelector(".task-review-tab__header")).not.toBeNull();
      expect(container.querySelector(".task-review-tab__summary-wrap")).not.toBeNull();
      expect(container.querySelector(".task-review-tab__summary-group")).not.toBeNull();
      expect(container.querySelector(".task-review-tab__actions")).not.toBeNull();

      if (testCase.emptyText) {
        expect(screen.getByText(testCase.emptyText)).toBeInTheDocument();
      }

      if (testCase.itemText) {
        expect(screen.getAllByText(testCase.itemText).length).toBeGreaterThan(0);
      }
    }
  });

  it.each([
    {
      name: "shows when task override turns auto-merge off while project default is on",
      taskAutoMerge: false,
      autoMergeEnabled: true,
      shouldShow: true,
    },
    {
      name: "hides when task override turns auto-merge on while project default is off",
      taskAutoMerge: true,
      autoMergeEnabled: false,
      shouldShow: false,
    },
    {
      name: "hides when task follows an enabled project default",
      taskAutoMerge: undefined,
      autoMergeEnabled: true,
      shouldShow: false,
    },
    {
      name: "shows when task follows a disabled project default",
      taskAutoMerge: undefined,
      autoMergeEnabled: false,
      shouldShow: true,
    },
  ])("create PR action $name", async ({ taskAutoMerge, autoMergeEnabled, shouldShow }) => {
    const onRequestCreatePr = vi.fn();
    const task = makeTask({ column: "in-review", prInfo: undefined, autoMerge: taskAutoMerge });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    await renderWithAct(
      <TaskReviewTab
        task={task}
        addToast={vi.fn()}
        prAuthAvailable
        onRequestCreatePr={onRequestCreatePr}
        autoMergeEnabled={autoMergeEnabled}
      />,
    );

    await screen.findByRole("button", { name: "Refresh" });

    if (!shouldShow) {
      expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
      expect(onRequestCreatePr).not.toHaveBeenCalled();
      return;
    }

    fireEvent.click(screen.getByTestId("task-review-create-pr"));
    expect(onRequestCreatePr).toHaveBeenCalledTimes(1);
  });

  it("hides create PR action outside in-review column", async () => {
    const task = makeTask({ column: "todo", prInfo: undefined });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} prAuthAvailable onRequestCreatePr={vi.fn()} />);

    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
  });

  it("hides create PR action when prInfo already exists", async () => {
    const task = makeTask({
      column: "in-review",
      prInfo: {
        number: 1,
        title: "Existing PR",
        url: "https://example.com/pr/1",
        status: "open",
        headBranch: "fusion/FN-1",
        baseBranch: "main",
      },
    });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} prAuthAvailable onRequestCreatePr={vi.fn()} />);

    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
  });

  it("hides create PR action when auth is unavailable", async () => {
    const task = makeTask({ column: "in-review", prInfo: undefined });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} prAuthAvailable={false} onRequestCreatePr={vi.fn()} />);

    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
  });

  it("hides create PR action when task follows an enabled project default", async () => {
    const task = makeTask({ column: "in-review", prInfo: undefined, autoMerge: undefined });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} prAuthAvailable onRequestCreatePr={vi.fn()} autoMergeEnabled />);

    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
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

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    });

    expect(apiMocks.reviseTaskReviewItems).toHaveBeenCalledWith(task.id, [expect.objectContaining({ id: "reviewer-code-1", source: "reviewer-agent" })], undefined);
  });

  it("updates per-task auto-merge preference for on/off/follow default", async () => {
    const onTaskUpdated = vi.fn();
    const task = makeTask({ autoMerge: undefined, reviewState: { source: "pull-request", items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    apiMocks.updateTask.mockResolvedValueOnce({ ...task, autoMerge: true });
    apiMocks.updateTask.mockResolvedValueOnce({ ...task, autoMerge: false });
    apiMocks.updateTask.mockResolvedValueOnce({ ...task, autoMerge: undefined });

    await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);

    const select = await screen.findByTestId("task-review-auto-merge-select");
    fireEvent.change(select, { target: { value: "on" } });
    await waitFor(() => expect(apiMocks.updateTask).toHaveBeenCalledWith(task.id, { autoMerge: true }, undefined));

    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(apiMocks.updateTask).toHaveBeenCalledWith(task.id, { autoMerge: false }, undefined));

    fireEvent.change(select, { target: { value: "follow-default" } });
    await waitFor(() => expect(apiMocks.updateTask).toHaveBeenCalledWith(task.id, { autoMerge: null }, undefined));

    expect(onTaskUpdated).toHaveBeenCalledTimes(3);
  });

  it("shows effective auto-merge hint for in-review tasks using global default", async () => {
    const inReviewTask = makeTask({ column: "in-review", autoMerge: undefined, reviewState: { source: "pull-request", items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: inReviewTask.reviewState, automationStatus: null, emptyMessage: null });

    const { rerender } = await renderWithAct(<TaskReviewTab task={inReviewTask} addToast={vi.fn()} autoMergeEnabled />);
    expect(await screen.findByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent("Effective: Auto-merge on — frozen on entry to review");

    rerender(<TaskReviewTab task={inReviewTask} addToast={vi.fn()} autoMergeEnabled={false} />);
    await waitFor(() => expect(screen.getByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent("Effective: Auto-merge off — frozen on entry to review"));
  });

  it("keeps the review tab visible when global auto-merge changes while task detail is open", async () => {
    const inReviewTask = makeTask({ column: "in-review", autoMerge: undefined, reviewState: { source: "pull-request", items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: inReviewTask.reviewState, automationStatus: null, emptyMessage: null });

    const { rerender } = await renderWithAct(
      <TaskReviewTab
        task={inReviewTask}
        addToast={vi.fn()}
        prAuthAvailable
        onRequestCreatePr={vi.fn()}
        autoMergeEnabled={false}
      />,
    );

    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByTestId("task-review-auto-merge-select")).toBeInTheDocument();
    expect(screen.getByTestId("task-review-create-pr")).toBeInTheDocument();
    expect(screen.getByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent(
      "Effective: Auto-merge off — frozen on entry to review",
    );

    rerender(
      <TaskReviewTab
        task={inReviewTask}
        addToast={vi.fn()}
        prAuthAvailable
        onRequestCreatePr={vi.fn()}
        autoMergeEnabled
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
      expect(screen.getByTestId("task-review-auto-merge-select")).toBeInTheDocument();
      expect(screen.queryByTestId("task-review-create-pr")).toBeNull();
      expect(screen.getByTestId("task-review-auto-merge-effective-hint")).toHaveTextContent(
        "Effective: Auto-merge on — frozen on entry to review",
      );
    });
  });

  it("reflects current per-task auto-merge selection", async () => {
    const task = makeTask({ autoMerge: true, reviewState: { source: "pull-request", items: [], addressing: [] } });
    apiMocks.fetchTaskReview.mockResolvedValue({ reviewState: task.reviewState, automationStatus: null, emptyMessage: null });

    const { rerender } = await renderWithAct(<TaskReviewTab task={task} addToast={vi.fn()} />);
    expect(await screen.findByTestId("task-review-auto-merge-select")).toHaveValue("on");

    rerender(<TaskReviewTab task={makeTask({ autoMerge: false, reviewState: { source: "pull-request", items: [], addressing: [] } })} addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("task-review-auto-merge-select")).toHaveValue("off"));
  });
});
