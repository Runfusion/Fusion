import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChangedFilesModal } from "../ChangedFilesModal";
import * as changedFilesHook from "../../hooks/useChangedFiles";

vi.mock("../../hooks/useChangedFiles");

const mockUseChangedFiles = vi.mocked(changedFilesHook.useChangedFiles);

describe("ChangedFilesModal", () => {
  const mockOnClose = vi.fn();
  const mockSetSelectedFile = vi.fn();
  const mockResetSelection = vi.fn();

  const defaultFiles = [
    { path: "src/a.ts", status: "modified" as const, diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+hello" },
    { path: "src/b.ts", status: "added" as const, diff: "diff --git a/src/b.ts b/src/b.ts" },
  ];

  const defaultSelectedFile = defaultFiles[0];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    mockUseChangedFiles.mockReturnValue({
      files: defaultFiles,
      loading: false,
      error: null,
      selectedFile: defaultSelectedFile,
      setSelectedFile: mockSetSelectedFile,
      resetSelection: mockResetSelection,
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

    expect(mockSetSelectedFile).toHaveBeenCalledWith(defaultFiles[1]);
  });

  it("shows an empty state when there are no changed files", () => {
    mockUseChangedFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      selectedFile: null,
      setSelectedFile: mockSetSelectedFile,
      resetSelection: mockResetSelection,
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

  it("shows select prompt when no file is selected and files exist", () => {
    mockUseChangedFiles.mockReturnValue({
      files: defaultFiles,
      loading: false,
      error: null,
      selectedFile: null,
      setSelectedFile: mockSetSelectedFile,
      resetSelection: mockResetSelection,
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

    expect(screen.getByText("Select a file to view changes")).toBeInTheDocument();
  });

  it("shows error state from hook", () => {
    mockUseChangedFiles.mockReturnValue({
      files: [],
      loading: false,
      error: "Failed to load",
      selectedFile: null,
      setSelectedFile: mockSetSelectedFile,
      resetSelection: mockResetSelection,
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

    expect(screen.getByText("Failed to load")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    mockUseChangedFiles.mockReturnValue({
      files: [],
      loading: true,
      error: null,
      selectedFile: null,
      setSelectedFile: mockSetSelectedFile,
      resetSelection: mockResetSelection,
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

    expect(screen.getByText("Loading changed files…")).toBeInTheDocument();
  });

  it("resets selection when modal opens", () => {
    const { rerender } = render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={false}
        onClose={mockOnClose}
      />,
    );

    expect(mockResetSelection).not.toHaveBeenCalled();

    rerender(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(mockResetSelection).toHaveBeenCalledTimes(1);
  });

  describe("mobile navigation", () => {
    beforeEach(() => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(600);
    });

    it("shows file list pane on mobile when mobileView is list", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // Sidebar should have mobile active class
      const sidebar = document.querySelector(".changed-files-sidebar");
      expect(sidebar?.classList.contains("mobile")).toBe(true);
      expect(sidebar?.classList.contains("active")).toBe(true);

      // Content should have mobile class but NOT active
      const content = document.querySelector(".changed-files-content");
      expect(content?.classList.contains("mobile")).toBe(true);
      expect(content?.classList.contains("active")).toBe(false);
    });

    it("switches to diff view when a file is selected on mobile", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // Click on a file to select it
      fireEvent.click(screen.getByRole("listitem", { name: /src\/b.ts/i }));

      expect(mockSetSelectedFile).toHaveBeenCalledWith(defaultFiles[1]);
    });

    it("shows back button on mobile when viewing diff", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // When selectedFile is set, the mobile view should switch to diff
      // and show the back button. Since the hook returns selectedFile,
      // the component's isMobile+selectedFile effect will set mobileView to "diff"
      const backButton = screen.queryByLabelText("Back to file list");
      expect(backButton).toBeInTheDocument();
    });

    it("does not show back button on desktop", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();
    });

    it("shows selected file path in header on mobile diff view", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // The header should show the selected file path when in mobile diff view
      const headerPath = document.querySelector(".file-browser-header-path");
      expect(headerPath).toBeInTheDocument();
      expect(headerPath?.textContent).toBe("src/a.ts");
    });

    it("shows renamed file info on mobile diff view", () => {
      const renamedFile = {
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        status: "renamed" as const,
        diff: "diff --git a/src/old-name.ts b/src/new-name.ts",
      };

      mockUseChangedFiles.mockReturnValue({
        files: [renamedFile],
        loading: false,
        error: null,
        selectedFile: renamedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      expect(screen.getByText("Renamed from src/old-name.ts")).toBeInTheDocument();
    });

    it("renders diff viewer with theme-safe CSS classes on mobile", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // Diff viewer should use theme-aware classes
      const diffViewer = document.querySelector(".gm-diff-viewer");
      expect(diffViewer).toBeInTheDocument();

      const diffStat = document.querySelector(".gm-diff-stat");
      expect(diffStat).toBeInTheDocument();

      const diffPatch = document.querySelector(".gm-diff-patch");
      expect(diffPatch).toBeInTheDocument();
    });
  });

  describe("desktop layout", () => {
    beforeEach(() => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    });

    it("auto-selects first file on desktop when files are loaded", () => {
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
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

      // Desktop should auto-select the first file via useEffect
      expect(mockSetSelectedFile).toHaveBeenCalledWith(defaultFiles[0]);
    });

    it("does not add mobile class to panes on desktop", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const sidebar = document.querySelector(".changed-files-sidebar");
      expect(sidebar?.classList.contains("mobile")).toBe(false);

      const content = document.querySelector(".changed-files-content");
      expect(content?.classList.contains("mobile")).toBe(false);
    });
  });
});
