import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskChangesTab } from "../TaskChangesTab";
import type { MergeDetails, Column } from "@fusion/core";

const mockFetchTaskDiff = vi.fn();

vi.mock("../../api", () => ({
  fetchTaskDiff: (...args: any[]) => mockFetchTaskDiff(...args),
}));

vi.mock("lucide-react", () => ({
  FileCode: () => null,
  ChevronDown: ({ size }: any) => <span data-testid="chevron-down" />,
  ChevronRight: ({ size }: any) => <span data-testid="chevron-right" />,
  ChevronLeft: ({ size }: any) => <span data-testid="chevron-left" />,
  AlertCircle: () => null,
  GitCommit: () => null,
}));

vi.mock("../../utils/highlightDiff", () => ({
  highlightDiff: (diff: string) => diff,
}));

const DONE_TASK_DIFF = {
  files: [
    { path: "src/app.ts", status: "modified" as const, additions: 1, deletions: 0, patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n import express from \"express\";\n+import cors from \"cors\";" },
    { path: "src/new-file.ts", status: "added" as const, additions: 2, deletions: 0, patch: "diff --git a/src/new-file.ts b/src/new-file.ts\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+export function hello() {}\n+export function world() {}" },
  ],
  stats: { filesChanged: 2, additions: 3, deletions: 0 },
};

const MERGE_DETAILS: MergeDetails = {
  commitSha: "abc1234567890def",
  filesChanged: 2,
  insertions: 3,
  deletions: 0,
  mergeCommitMessage: "Merge branch 'fusion/fn-001' into main",
  mergedAt: "2026-01-15T10:30:00Z",
};

beforeEach(() => {
  mockFetchTaskDiff.mockReset();
});

describe("TaskChangesTab — worktree-backed (non-done tasks)", () => {
  it("shows 'No worktree available' when no worktree and not done", async () => {
    mockFetchTaskDiff.mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-progress"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    });
  });

  it("loads diff from fetchTaskDiff for in-progress task with worktree", async () => {
    mockFetchTaskDiff.mockResolvedValue({
      files: [
        { path: "src/app.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@" },
      ],
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
    });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree="/path/to/worktree"
        column="in-progress"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });
    expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-001", undefined, undefined);
  });

  it("loads diff from fetchTaskDiff for in-review task with worktree", async () => {
    mockFetchTaskDiff.mockResolvedValue({
      files: [
        { path: "src/app.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@" },
      ],
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
    });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree="/path/to/worktree"
        column="in-review"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });
    expect(mockFetchTaskDiff).toHaveBeenCalled();
  });

  it("shows 'No files modified' when worktree diff returns empty", async () => {
    mockFetchTaskDiff.mockResolvedValue({
      files: [],
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree="/path/to/worktree"
        column="in-progress"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No files modified.")).toBeTruthy();
    });
  });

  it("shows error state when fetchTaskDiff fails", async () => {
    mockFetchTaskDiff.mockRejectedValue(new Error("Network error"));

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree="/path/to/worktree"
        column="in-progress"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Error loading changes: Network error/)).toBeTruthy();
    });
  });

  it("shows loading state initially", () => {
    mockFetchTaskDiff.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree="/path/to/worktree"
        column="in-progress"
      />,
    );
    expect(screen.getByText("Loading changes...")).toBeTruthy();
  });
});

describe("TaskChangesTab — commit-backed (done tasks)", () => {
  it("loads diff from fetchTaskDiff for done task with commitSha", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });
    expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-001", undefined, undefined);
  });

  it("shows commit metadata for done task", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("abc1234")).toBeTruthy(); // short SHA
    });
    expect(screen.getByText("Merge branch 'fusion/fn-001' into main")).toBeTruthy();
    expect(screen.getByText(/Merged .+/)).toBeTruthy();
  });

  it("uses mergeDetails stats for summary", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Files Changed (2)")).toBeTruthy();
    });
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("-0")).toBeTruthy();
  });

  it("toggling file expansion shows/hides diff content", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);
    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // First file should be auto-expanded
    let diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(1);

    // Click to collapse
    fireEvent.click(screen.getByText("src/app.ts"));
    diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(0);

    // Click on second file to expand
    fireEvent.click(screen.getByText("src/new-file.ts"));
    diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(1);
  });

  it("shows 'No files modified' with commit-specific hint when patch is empty", async () => {
    mockFetchTaskDiff.mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No files modified.")).toBeTruthy();
    });
    expect(screen.getByText("No file changes were recorded in the merge commit.")).toBeTruthy();
  });

  it("shows error state when fetchTaskDiff fails", async () => {
    mockFetchTaskDiff.mockRejectedValue(new Error("Git error"));

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Error loading changes: Git error/)).toBeTruthy();
    });
  });

  it("renders commit SHA metadata even when only commitSha is set", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={{ commitSha: "abc1234567890def" }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // SHA metadata should render since commitSha is present
    expect(container.querySelector(".commit-diff-meta")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy(); // short SHA
    // But message and timestamp should NOT be present since they're not set
    expect(container.querySelector(".commit-diff-message")).toBeNull();
    expect(container.querySelector(".commit-diff-timestamp")).toBeNull();
  });
});

describe("TaskChangesTab — regression: non-done tasks still use worktree path", () => {
  it("in-progress without worktree shows worktree empty state, not commit path", async () => {
    mockFetchTaskDiff.mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-progress"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    });
  });

  it("in-review without worktree shows worktree empty state", async () => {
    mockFetchTaskDiff.mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-review"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    });
  });

  it("todo task never loads diff even with mergeDetails", () => {
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="todo"
        mergeDetails={MERGE_DETAILS}
      />,
    );
    expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("done task without commitSha calls fetchTaskDiff (server handles it)", async () => {
    mockFetchTaskDiff.mockResolvedValue({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={{}} // no commitSha
      />,
    );

    await waitFor(() => {
      expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-001", undefined, undefined);
    });
  });
});

describe("TaskChangesTab — status-to-class mapping", () => {
  it("applies semantic status class for each file status", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // src/app.ts is modified, src/new-file.ts is added
    const statusBadges = container.querySelectorAll(".changes-file-status");
    expect(statusBadges.length).toBeGreaterThanOrEqual(2);

    // Verify semantic status classes are present
    const modifiedBadge = container.querySelector(".changes-file-status--modified");
    expect(modifiedBadge).toBeTruthy();
    expect(modifiedBadge?.textContent).toBe("M");

    const addedBadge = container.querySelector(".changes-file-status--added");
    expect(addedBadge).toBeTruthy();
    expect(addedBadge?.textContent).toBe("A");
  });

  it("uses CSS classes instead of inline styles for status colors", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // Status badges should NOT have inline style attributes (colors come from CSS)
    const statusBadges = container.querySelectorAll(".changes-file-status");
    for (const badge of Array.from(statusBadges)) {
      expect(badge.getAttribute("style")).toBeNull();
    }
  });

  it("renders stat summary with diff-add and diff-del classes", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Files Changed (2)")).toBeTruthy();
    });

    const statSummary = container.querySelector(".changes-stat-summary");
    expect(statSummary).toBeTruthy();

    const addStat = statSummary?.querySelector(".diff-add");
    expect(addStat).toBeTruthy();

    const delStat = statSummary?.querySelector(".diff-del");
    expect(delStat).toBeTruthy();
  });
});

describe("TaskChangesTab — file navigation", () => {
  it("renders Previous and Next navigation buttons", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Files Changed (2)")).toBeTruthy();
    });

    expect(screen.getByLabelText("Previous file")).toBeTruthy();
    expect(screen.getByLabelText("Next file")).toBeTruthy();
  });

  it("shows file position indicator in current/total format", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });
  });

  it("disables Previous button on first file", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    expect(screen.getByLabelText("Previous file")).toBeDisabled();
  });

  it("enables Next button on first file", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    expect(screen.getByLabelText("Next file")).not.toBeDisabled();
  });

  it("navigates to next file when Next is clicked", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    // Click Next
    fireEvent.click(screen.getByLabelText("Next file"));

    // Indicator should update to 2/2
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("disables Next button on last file", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    // Navigate to last file
    fireEvent.click(screen.getByLabelText("Next file"));

    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.getByLabelText("Next file")).toBeDisabled();
    expect(screen.getByLabelText("Previous file")).not.toBeDisabled();
  });

  it("navigates back to previous file when Previous is clicked", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);

    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    // Go to next, then back
    fireEvent.click(screen.getByLabelText("Next file"));
    expect(screen.getByText("2/2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Previous file"));
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("expands only the navigated file", async () => {
    mockFetchTaskDiff.mockResolvedValue(DONE_TASK_DIFF);
    const { container } = render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={MERGE_DETAILS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeTruthy();
    });

    // Initially only first file expanded
    expect(container.querySelectorAll(".changes-file-content")).toHaveLength(1);

    // Navigate to second file
    fireEvent.click(screen.getByLabelText("Next file"));

    // Still only one file expanded (the second one)
    expect(container.querySelectorAll(".changes-file-content")).toHaveLength(1);
  });
});
