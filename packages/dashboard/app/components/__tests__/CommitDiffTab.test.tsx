import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommitDiffTab } from "../CommitDiffTab";
import type { MergeDetails } from "@fusion/core";

const mockFetchCommitDiff = vi.fn();

vi.mock("../../api", () => ({
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
+export function world() {}
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const old = true;`;

const MERGE_DETAILS: MergeDetails = {
  commitSha: "abc1234567890def",
  filesChanged: 3,
  insertions: 3,
  deletions: 1,
  mergeCommitMessage: "Merge branch 'fusion/fn-001' into main",
  mergedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  mockFetchCommitDiff.mockReset();
});

describe("CommitDiffTab", () => {
  it("renders loading state initially", () => {
    mockFetchCommitDiff.mockReturnValue(new Promise(() => {})); // never resolves
    render(<CommitDiffTab commitSha="abc123" />);
    expect(screen.getByText("Loading commit diff...")).toBeTruthy();
  });

  it("renders error state when fetch fails", async () => {
    mockFetchCommitDiff.mockRejectedValue(new Error("Network error"));
    render(<CommitDiffTab commitSha="abc123" />);
    await waitFor(() => {
      expect(screen.getByText(/Error loading commit diff: Network error/)).toBeTruthy();
    });
  });

  it("renders empty state when no commit SHA", () => {
    render(<CommitDiffTab commitSha="" />);
    expect(screen.getByText("No commit SHA available.")).toBeTruthy();
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
  });

  it("renders file list with correct file paths and statuses after successful fetch", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
    render(<CommitDiffTab commitSha="abc123" mergeDetails={MERGE_DETAILS} />);

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    expect(screen.getByText("src/new-file.ts")).toBeTruthy();
    expect(screen.getByText("src/removed.ts")).toBeTruthy();

    // Check status badges - M for modified, A for added, D for deleted
    const statusElements = screen.getAllByTitle(/added|modified|deleted/);
    expect(statusElements).toHaveLength(3);
    expect(statusElements.find((el) => el.textContent === "M" && el.title === "modified")).toBeTruthy();
    expect(statusElements.find((el) => el.textContent === "A" && el.title === "added")).toBeTruthy();
    expect(statusElements.find((el) => el.textContent === "D" && el.title === "deleted")).toBeTruthy();
  });

  it("toggling file expansion shows/hides diff content", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
    const { container } = render(<CommitDiffTab commitSha="abc123" />);

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // First file should be auto-expanded
    let diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(1);

    // Click on first file to collapse it
    fireEvent.click(screen.getByText("src/app.ts"));
    diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(0);

    // Click on second file to expand it
    fireEvent.click(screen.getByText("src/new-file.ts"));
    diffBlocks = container.querySelectorAll(".changes-file-content");
    expect(diffBlocks.length).toBe(1);
  });

  it("displays merge commit metadata (SHA and message)", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
    render(<CommitDiffTab commitSha="abc1234567890def" mergeDetails={MERGE_DETAILS} />);

    await waitFor(() => {
      expect(screen.getByText("abc1234")).toBeTruthy(); // short SHA
    });
    expect(screen.getByText("Merge branch 'fusion/fn-001' into main")).toBeTruthy();
  });

  it("renders empty file list when patch has no diffs", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: "" });
    render(<CommitDiffTab commitSha="abc123" />);

    await waitFor(() => {
      expect(screen.getByText("No files changed in this commit.")).toBeTruthy();
    });
  });

  it("uses mergeDetails stats for summary when available", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
    render(<CommitDiffTab commitSha="abc123" mergeDetails={MERGE_DETAILS} />);

    await waitFor(() => {
      expect(screen.getByText("Files Changed (3)")).toBeTruthy();
    });
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });
});

describe("CommitDiffTab in TaskDetailModal", () => {
  // These tests verify tab visibility logic via the CommitDiffTab integration
  // Testing against the TaskDetailModal directly would require extensive mocking
  // Instead we verify the component renders correctly for valid/invalid props

  it("does not fetch when commitSha is empty (non-done task scenario)", () => {
    render(<CommitDiffTab commitSha="" />);
    expect(mockFetchCommitDiff).not.toHaveBeenCalled();
    expect(screen.getByText("No commit SHA available.")).toBeTruthy();
  });
});

describe("CommitDiffTab — compact spacing isolation", () => {
  it("does NOT render the TaskChangesTab compact modifier class", async () => {
    mockFetchCommitDiff.mockResolvedValue({ stat: "", patch: SAMPLE_PATCH });
    const { container } = render(<CommitDiffTab commitSha="abc123" mergeDetails={MERGE_DETAILS} />);

    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeTruthy();
    });

    // CommitDiffTab should not have the compact modifier — proves scoping isolation
    const compactList = container.querySelector(".task-changes-file-list--compact");
    expect(compactList).toBeNull();
  });
});
