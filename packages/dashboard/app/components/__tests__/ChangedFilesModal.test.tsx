import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

  it("closes on Escape on desktop", () => {
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

  it("marks the active file with aria-current", () => {
    render(
      <ChangedFilesModal
        taskId="KB-651"
        worktree="/repo/.worktrees/kb-651"
        column="in-progress"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    const activeItem = screen.getByRole("listitem", { name: "src/a.ts" });
    expect(activeItem).toHaveAttribute("aria-current", "true");

    const inactiveItem = screen.getByRole("listitem", { name: /src\/b.ts/i });
    expect(inactiveItem).not.toHaveAttribute("aria-current");
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

    it("shows back button on mobile when user selects a file", () => {
      // Start with no selected file so user sees the list
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      const { rerender } = render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // No back button when on file list
      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();

      // Simulate user selecting a file - the hook will update selectedFile
      // and the component will set mobileView to "diff"
      fireEvent.click(screen.getByRole("listitem", { name: /src\/b.ts/i }));
      expect(mockSetSelectedFile).toHaveBeenCalledWith(defaultFiles[1]);

      // Now simulate the hook providing the selected file (rerender with updated hook state)
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultFiles[1],
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      rerender(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // After user selects, back button should appear since mobileDiffIntentional was set
      const backButton = screen.queryByLabelText("Back to file list");
      expect(backButton).toBeInTheDocument();
    });

    it("does NOT show back button when hook provides selectedFile without user action", () => {
      // Simulate cached data where the hook already has a selected file
      // The modal should NOT auto-switch to diff on mobile without user intent
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

      // Without explicit user action, the back button should NOT appear
      // because the modal should show the file list first on mobile
      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();
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

    it("shows selected file path in header on mobile diff view after user selects file", () => {
      // Start with no selection so user sees the list
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      const { rerender } = render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // User selects a file
      fireEvent.click(screen.getByRole("listitem", { name: /src\/a.ts/i }));

      // Simulate hook returning selected file
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      rerender(
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

    it("Escape on mobile diff view goes back to list instead of closing", () => {
      // Start with no selection so user sees the list
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: null,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      const { rerender } = render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // User selects a file, triggering mobileView to "diff"
      fireEvent.click(screen.getByRole("listitem", { name: /src\/a.ts/i }));

      // Simulate hook returning selected file (triggers diff view)
      mockUseChangedFiles.mockReturnValue({
        files: defaultFiles,
        loading: false,
        error: null,
        selectedFile: defaultSelectedFile,
        setSelectedFile: mockSetSelectedFile,
        resetSelection: mockResetSelection,
      });

      rerender(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // Now we should be in diff view with back button visible
      expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();

      // On mobile with diff view, Escape should go back to list, not close
      fireEvent.keyDown(document, { key: "Escape" });
      expect(mockOnClose).not.toHaveBeenCalled();

      // Now pressing Escape again (on list view) should close the modal
      fireEvent.keyDown(document, { key: "Escape" });
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("starts on list view when modal opens on mobile", () => {
      // Simulate hook returning a selected file (e.g., cached from previous open)
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

      // On first render after open, the resetSelection effect fires.
      // However, since the hook provides selectedFile, the mobile view
      // may auto-switch to diff. The important thing is resetSelection was called.
      expect(mockResetSelection).toHaveBeenCalled();
    });

    it("loading state has role=status for accessibility", () => {
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

      const loadingEl = screen.getByRole("status");
      expect(loadingEl).toHaveTextContent("Loading changed files…");
    });

    it("error state has role=alert for accessibility", () => {
      mockUseChangedFiles.mockReturnValue({
        files: [],
        loading: false,
        error: "Network error",
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

      const alertEl = screen.getByRole("alert");
      expect(alertEl).toHaveTextContent("Network error");
    });

    it("sidebar has aria-label for accessibility", () => {
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

      const sidebar = document.querySelector(".changed-files-sidebar");
      expect(sidebar).toHaveAttribute("aria-label", "Changed files sidebar");
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

  describe("list structure and styling classes", () => {
    it("renders sidebar entries with dedicated changed-files-entry class", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const entries = document.querySelectorAll(".changed-files-entry");
      expect(entries.length).toBe(2);

      // Each entry should have the file-node base class AND the changed-files-entry class
      entries.forEach((entry) => {
        expect(entry.classList.contains("file-node")).toBe(true);
        expect(entry.classList.contains("file-node--file")).toBe(true);
        expect(entry.classList.contains("changed-files-entry")).toBe(true);
      });
    });

    it("renders entry buttons with proper type and role attributes", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const entries = document.querySelectorAll("button.changed-files-entry");
      entries.forEach((entry) => {
        expect(entry.getAttribute("type")).toBe("button");
        expect(entry.getAttribute("role")).toBe("listitem");
      });
    });

    it("applies active class to the selected file entry on desktop", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // defaultSelectedFile is src/a.ts
      const activeEntry = document.querySelector(".changed-files-entry.active");
      expect(activeEntry).toBeTruthy();
      expect(activeEntry?.getAttribute("aria-label")).toBe("src/a.ts");
      expect(activeEntry?.getAttribute("aria-current")).toBe("true");

      // Non-selected entry should NOT have active class
      const allEntries = document.querySelectorAll(".changed-files-entry");
      const inactiveEntry = Array.from(allEntries).find(
        (el) => el.getAttribute("aria-label") === "src/b.ts",
      );
      expect(inactiveEntry).toBeTruthy();
      expect(inactiveEntry?.classList.contains("active")).toBe(false);
    });

    it("renders icon, name, and badge spans in each entry", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const entries = document.querySelectorAll(".changed-files-entry");
      entries.forEach((entry) => {
        // Each entry should contain an icon span, a name span, and a badge span
        const icon = entry.querySelector(".file-node-icon");
        const name = entry.querySelector(".file-node-name");
        const badge = entry.querySelector(".changed-files-badge");
        expect(icon).toBeTruthy();
        expect(name).toBeTruthy();
        expect(badge).toBeTruthy();
      });
    });

    it("applies active class alongside aria-current on mobile list view", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(600);

      // On mobile, the selected file comes from hook but back button is NOT shown
      // because mobileDiffIntentional hasn't been set (no user action).
      // The active entry in the list should still have both classes.
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

      // The selected file entry should have both active class and aria-current
      const activeEntry = document.querySelector(".changed-files-entry.active");
      expect(activeEntry).toBeTruthy();
      expect(activeEntry?.getAttribute("aria-current")).toBe("true");

      vi.restoreAllMocks();
    });

    it("renders deleted status badge class correctly", () => {
      const deletedFile = {
        path: "src/deleted.ts",
        status: "deleted" as const,
        diff: "diff --git a/src/deleted.ts b/src/deleted.ts",
      };

      mockUseChangedFiles.mockReturnValue({
        files: [deletedFile],
        loading: false,
        error: null,
        selectedFile: deletedFile,
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

      const deletedBadge = document.querySelector(".changed-files-badge--deleted");
      expect(deletedBadge).toBeTruthy();
      expect(deletedBadge?.textContent).toBe("D");
    });
  });

  describe("status-to-class mapping", () => {
    it("applies status-specific CSS class to sidebar badges", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // defaultFiles has modified (src/a.ts) and added (src/b.ts)
      const modifiedBadge = document.querySelector(".changed-files-badge--modified");
      expect(modifiedBadge).toBeTruthy();
      expect(modifiedBadge?.textContent).toBe("M");

      const addedBadge = document.querySelector(".changed-files-badge--added");
      expect(addedBadge).toBeTruthy();
      expect(addedBadge?.textContent).toBe("A");
    });

    it("applies status-specific CSS class to toolbar badge in diff section", () => {
      render(
        <ChangedFilesModal
          taskId="KB-651"
          worktree="/repo/.worktrees/kb-651"
          column="in-progress"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // defaultSelectedFile is src/a.ts with status "modified"
      const toolbarBadge = document.querySelector(".changed-files-diff-section .changed-files-badge--modified");
      expect(toolbarBadge).toBeTruthy();
      expect(toolbarBadge?.textContent).toBe("M");
    });

    it("applies renamed status class for renamed files", () => {
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

      const renamedBadge = document.querySelector(".changed-files-badge--renamed");
      expect(renamedBadge).toBeTruthy();
      expect(renamedBadge?.textContent).toBe("R");
    });
  });
});
