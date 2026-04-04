import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskChangesTab } from "../TaskChangesTab";
import type { MergeDetails, Column } from "@fusion/core";

const mockFetchTaskDiff = vi.fn();
const mockFetchCommitDiff = vi.fn();

vi.mock("../../api", () => ({
  fetchTaskDiff: (...args: any[]) => mockFetchTaskDiff(...args),
  fetchCommitDiff: (...args: any[]) => mockFetchCommitDiff(...args),
}));

vi.mock("lucide-react", () => ({
  FileCode: () => null,
  ChevronDown: ({ size }: any) => <span data-testid="chevron-down" />,
  ChevronRight: ({ size }: any) => <span data-testid="chevron-right" />,
  AlertCircle: () => null,
  GitCommit: () => null,
}));

vi.mock("../../utils/highlightDiff", () => ({
  highlightDiff: (diff: string) => diff,
}));

vi.mock("../CommitDiffTab", () => ({
  parsePatch: (rawPatch: string) => {
    const files: Array<{
      path: string;
      status: "added" | "modified" | "deleted" | "unknown";
      additions: number;
      deletions: number;
      patch: string;
    }> = [];
    const parts = rawPatch.split(/(?=^diff --git )/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith("diff --git ")) continue;
      const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\/(.+)/m);
      const path = headerMatch ? headerMatch[2] : "unknown";
      let status: "added" | "modified" | "deleted" | "unknown" = "modified";
      if (trimmed.includes("new file mode")) status = "added";
      else if (trimmed.includes("deleted file mode")) status = "deleted";
      let additions = 0;
      let deletions = 0;
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
      files.push({ path, status, additions, deletions, patch: trimmed });
    }
    return files;
  },
}));

const SAMPLE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import express from "express";
+import cors from "cors";
 const app = express();
 app.listen(3000);
diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,2 @@
+export function hello() {}
+export function world() {}`;

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
  mockFetchCommitDiff.mockReset();
});

describe("TaskChangesTab — worktree-backed (non-done tasks)", () => {
  it("shows 'No worktree available' when no worktree and not done", () => {
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-progress"
      />,
    );
    expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
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
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
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
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
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
  it("loads diff from fetchCommitDiff for done task with commitSha", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });

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
    expect(mockFetchCommitDiff).toHaveBeenCalledWith("abc1234567890def");
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("shows commit metadata for done task", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });

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
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });

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
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
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
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: "" });

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

  it("shows error state when fetchCommitDiff fails", async () => {
    mockFetchCommitDiff.mockRejectedValue(new Error("Git error"));

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
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });

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
  it("in-progress without worktree shows worktree empty state, not commit path", () => {
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-progress"
        mergeDetails={MERGE_DETAILS}
      />,
    );
    expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
  });

  it("in-review without worktree shows worktree empty state", () => {
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="in-review"
        mergeDetails={MERGE_DETAILS}
      />,
    );
    expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
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
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
  });

  it("done task without commitSha falls through to worktree path", () => {
    render(
      <TaskChangesTab
        taskId="FN-001"
        worktree={undefined}
        column="done"
        mergeDetails={{}} // no commitSha
      />,
    );
    // Falls through to the !worktree check for non-commit-diff path
    expect(screen.getByText("No worktree available for this task.")).toBeTruthy();
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
  });
});
