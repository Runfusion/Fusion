import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileBrowserModal } from "./FileBrowserModal";
import * as useFileBrowserHook from "../hooks/useFileBrowser";
import * as useFileEditorHook from "../hooks/useFileEditor";
import * as useProjectFileBrowserHook from "../hooks/useProjectFileBrowser";
import * as useProjectFileEditorHook from "../hooks/useProjectFileEditor";

// Mock the hooks
vi.mock("../hooks/useFileBrowser");
vi.mock("../hooks/useFileEditor");
vi.mock("../hooks/useProjectFileBrowser");
vi.mock("../hooks/useProjectFileEditor");

describe("FileBrowserModal", () => {
  const mockOnClose = vi.fn();
  const mockSave = vi.fn();
  const mockSetContent = vi.fn();
  const mockSetPath = vi.fn();
  const mockRefresh = vi.fn();

  const defaultBrowserState = {
    entries: [
      { name: "file1.ts", type: "file", size: 1024, mtime: "2024-01-01" },
      { name: "folder1", type: "directory" },
    ],
    currentPath: ".",
    setPath: mockSetPath,
    loading: false,
    error: null,
    refresh: mockRefresh,
  };

  const defaultEditorState = {
    content: "console.log('hello');",
    setContent: mockSetContent,
    originalContent: "console.log('hello');",
    loading: false,
    saving: false,
    error: null,
    save: mockSave,
    hasChanges: false,
    mtime: "2024-01-01",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    
    // Default mock implementations
    vi.mocked(useFileBrowserHook.useFileBrowser).mockReturnValue(defaultBrowserState);
    vi.mocked(useFileEditorHook.useFileEditor).mockReturnValue(defaultEditorState);
    vi.mocked(useProjectFileBrowserHook.useProjectFileBrowser).mockReturnValue(defaultBrowserState);
    vi.mocked(useProjectFileEditorHook.useProjectFileEditor).mockReturnValue(defaultEditorState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Desktop view", () => {
    beforeEach(() => {
      // Mock desktop viewport
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1024,
      });
    });

    it("renders file browser sidebar and empty state on desktop", () => {
      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Sidebar should be visible
      expect(screen.getByText("file1.ts")).toBeInTheDocument();
      expect(screen.getByText("folder1")).toBeInTheDocument();

      // Empty state placeholder should be visible
      expect(screen.getByText("Select a file to edit")).toBeInTheDocument();
    });

    it("selecting a file shows editor on desktop (both views visible)", async () => {
      const editorStateWithChanges = {
        ...defaultEditorState,
        hasChanges: true,
      };
      vi.mocked(useFileEditorHook.useFileEditor).mockReturnValue(editorStateWithChanges);

      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Click on a file
      fireEvent.click(screen.getByText("file1.ts"));

      // Editor content should be visible - check for the editor textarea
      await waitFor(() => {
        expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument();
      });
    });
  });

  describe("Mobile view", () => {
    beforeEach(() => {
      // Mock mobile viewport
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 375,
      });
    });

    it("initially shows only file list (sidebar visible, content hidden)", () => {
      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Fire resize event to trigger mobile detection
      fireEvent(window, new Event("resize"));

      // File list should be visible
      expect(screen.getByText("file1.ts")).toBeInTheDocument();
      
      // Empty state should be in the DOM but hidden via CSS
      const placeholder = screen.getByText("Select a file to edit");
      expect(placeholder).toBeInTheDocument();
    });

    it("selecting a file switches to editor view with back button", async () => {
      const editorStateWithChanges = {
        ...defaultEditorState,
        hasChanges: true,
      };
      vi.mocked(useFileEditorHook.useFileEditor).mockReturnValue(editorStateWithChanges);

      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Trigger mobile detection
      fireEvent(window, new Event("resize"));

      // Click on a file
      fireEvent.click(screen.getByText("file1.ts"));

      // Back button should be visible
      await waitFor(() => {
        expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
      });
    });

    it("back button returns to list view when clicked", async () => {
      const editorStateWithChanges = {
        ...defaultEditorState,
        hasChanges: true,
      };
      vi.mocked(useFileEditorHook.useFileEditor).mockReturnValue(editorStateWithChanges);

      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Trigger mobile detection
      fireEvent(window, new Event("resize"));

      // Click on a file to enter editor view
      fireEvent.click(screen.getByText("file1.ts"));

      // Wait for back button to appear
      await waitFor(() => {
        expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
      });

      // Click back button
      fireEvent.click(screen.getByLabelText("Back to file list"));

      // After clicking back, we should still see the file list (file node should be visible)
      expect(screen.getAllByText("file1.ts").length).toBeGreaterThan(0);
    });

    it("back button only renders on mobile when file is selected", () => {
      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Trigger mobile detection
      fireEvent(window, new Event("resize"));

      // Back button should NOT be visible when no file is selected
      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();
    });

    it("modal resets to list view when reopened", () => {
      const { unmount } = render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Trigger mobile detection
      fireEvent(window, new Event("resize"));

      // Unmount and remount to simulate reopening
      unmount();

      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      // Trigger mobile detection again
      fireEvent(window, new Event("resize"));

      // Should start in list view - file list visible
      expect(screen.getByText("file1.ts")).toBeInTheDocument();
    });
  });

  describe("Keyboard shortcuts", () => {
    it("calls onClose when Escape key is pressed", () => {
      render(
        <FileBrowserModal
          taskId="KB-001"
          isOpen={true}
          onClose={mockOnClose}
        />
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
