import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChangedFilesModal } from "../ChangedFilesModal";
import * as changedFilesHook from "../../hooks/useChangedFiles";

vi.mock("../../hooks/useChangedFiles");

const mockUseChangedFiles = vi.mocked(changedFilesHook.useChangedFiles);

describe("ChangedFilesModal", () => {
  const mockOnClose = vi.fn();
  const mockSetSelectedFile = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mockUseChangedFiles.mockReturnValue({
      files: [
        { path: "src/a.ts", status: "modified", diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+hello" },
        { path: "src/b.ts", status: "added", diff: "diff --git a/src/b.ts b/src/b.ts" },
      ],
      loading: false,
      error: null,
      selectedFile: { path: "src/a.ts", status: "modified", diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+hello" },
      setSelectedFile: mockSetSelectedFile,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders changed files and selected diff", () => {
    render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByText("Changed Files — KB-651")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "src/a.ts" })).toBeInTheDocument();
    expect(screen.getByLabelText("Diff for src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(/\+hello/)).toBeInTheDocument();
  });

  it("allows selecting another file from the sidebar", () => {
    render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByRole("listitem", { name: /src\/b.ts/i }));

    expect(mockSetSelectedFile).toHaveBeenCalledWith({ path: "src/b.ts", status: "added", diff: "diff --git a/src/b.ts b/src/b.ts" });
  });

  it("shows an empty state when there are no changed files", () => {
    mockUseChangedFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      selectedFile: null,
      setSelectedFile: mockSetSelectedFile,
    });

    render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByText("No files changed")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});
