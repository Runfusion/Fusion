import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserModal } from "../FileBrowserModal";
import * as workspaceBrowserHook from "../../hooks/useWorkspaceFileBrowser";
import * as workspaceEditorHook from "../../hooks/useWorkspaceFileEditor";
import * as workspacesHook from "../../hooks/useWorkspaces";

vi.mock("../../hooks/useWorkspaceFileBrowser");
vi.mock("../../hooks/useWorkspaceFileEditor");
vi.mock("../../hooks/useWorkspaces");
vi.mock("../../hooks/useViewportMode", () => {
  const mode = () => (window.innerWidth <= 768 ? "mobile" : "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    isFullScreenSheetViewport: () => false,
    isShortViewport: () => false,
    getViewportMode: mode,
    isMobileViewport: () => mode() === "mobile",
    useViewportMode: mode,
  };
});

const mockUseWorkspaceFileBrowser = vi.mocked(workspaceBrowserHook.useWorkspaceFileBrowser);
const mockUseWorkspaceFileEditor = vi.mocked(workspaceEditorHook.useWorkspaceFileEditor);
const mockUseWorkspaces = vi.mocked(workspacesHook.useWorkspaces);

function mockSelectionRect() {
  const rect = new DOMRect(10, 20, 80, 12);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => rect),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: vi.fn(() => ({ 0: rect, length: 1, item: () => rect, [Symbol.iterator]: function* () { yield rect; } }) as DOMRectList),
  });
}

function selectNodeText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("FileBrowserModal", () => {
  const mockOnClose = vi.fn();
  const mockOnWorkspaceChange = vi.fn();
  const mockSave = vi.fn().mockResolvedValue(undefined);
  const mockSetContent = vi.fn();
  const mockSetPath = vi.fn();
  const mockRefresh = vi.fn();

  const defaultBrowserState = {
    entries: [
      { name: "file1.ts", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      { name: "folder1", type: "directory" as const, mtime: "2024-01-01" },
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

    mockUseWorkspaceFileBrowser.mockReturnValue(defaultBrowserState);
    mockUseWorkspaceFileEditor.mockReturnValue(defaultEditorState);
    mockUseWorkspaces.mockReturnValue({
      projectName: "kb",
      workspaces: [
        { id: "FN-001", label: "FN-001", title: "Task One", worktree: "/repo/.worktrees/kb-001", kind: "task" },
        { id: "FN-002", label: "FN-002", title: "Task Two", worktree: "/repo/.worktrees/kb-002", kind: "task" },
      ],
      loading: false,
      error: null,
    });

    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders project-root modal title and workspace selector", () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    expect(screen.getByText("Files — Project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /kb/i })).toBeInTheDocument();
    expect(mockUseWorkspaceFileBrowser).toHaveBeenCalledWith("project", true, undefined);
  });

  it("shows Files — Project create and search controls only for the project workspace", async () => {
    const { rerender } = render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByRole("button", { name: "Create new file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new folder" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search project files" })).toBeInTheDocument();

    rerender(
      <FileBrowserModal
        initialWorkspace="FN-001"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("searchbox", { name: "Search project files" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create new file" })).toBeNull();
      expect(screen.getByRole("button", { name: /^New$/i })).toBeInTheDocument();
    });
  });

  it("keeps Files — Project controls available in the narrow mobile list pane", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });
    window.dispatchEvent(new Event("resize"));

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".file-browser-modal--narrow")).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Search project files" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create new file" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create new folder" })).toBeInTheDocument();
    });
  });

  it("opens a file in the editor when selected", async () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByText("file1.ts"));

    await waitFor(() => {
      expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument();
    });

    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "file1.ts", true, undefined, true);
  });

  it("shows the auto-save toggle for desktop text editor files", async () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByText("file1.ts"));
    await waitFor(() => expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));

    expect(screen.getByTestId("file-editor-auto-save-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the auto-save toggle in the narrow mobile editor view", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });
    window.dispatchEvent(new Event("resize"));

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByText("file1.ts"));

    await waitFor(() => {
      expect(document.querySelector(".file-browser-modal--narrow")).toBeInTheDocument();
      expect(screen.getByTestId("file-editor-auto-save-toggle")).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("does not show the auto-save toggle for preview-only files", async () => {
    mockUseWorkspaceFileBrowser.mockReturnValue({
      ...defaultBrowserState,
      entries: [{ name: "preview.png", type: "file", size: 1024, mtime: "2024-01-01" }],
    });
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.click(screen.getByText("preview.png"));

    await waitFor(() => expect(document.querySelector("img.file-browser-preview-media--image")).toBeInTheDocument());
    expect(screen.queryByTestId("file-editor-auto-save-toggle")).not.toBeInTheDocument();
    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "preview.png", false, undefined, false);
  });

  it("sends selected code text from the embedded editor to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onSendSelectionToTask={onSendSelectionToTask}
      />,
    );

    fireEvent.click(screen.getByText("file1.ts"));
    await waitFor(() => expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument());
    selectNodeText(document.querySelector(".cm-content") as Node);

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Investigate this file." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: file1.ts"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("console.log"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Investigate this file."));
  });

  it("sends selected markdown preview text from the embedded editor to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      content: "# Heading\n\nPreview body",
      originalContent: "# Heading\n\nPreview body",
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile="README.md"
        isOpen={true}
        onClose={mockOnClose}
        onSendSelectionToTask={onSendSelectionToTask}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("README.md").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
    fireEvent.click(screen.getByRole("button", { name: /preview mode/i }));
    selectNodeText(await screen.findByText("Preview body"));

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Turn preview note into work." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: README.md"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Preview body"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Turn preview note into work."));
  });

  it("opens with an initial file selected", async () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile="packages/dashboard/app/App.tsx"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("packages/dashboard/app/App.tsx").length).toBeGreaterThan(0);
    });

    expect(mockSetPath).toHaveBeenCalledWith("packages/dashboard/app");
    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "packages/dashboard/app/App.tsx", true, undefined, true);
  });

  it("opens root-level absolute initial files at filesystem root", async () => {
    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile="/README.md"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("/README.md").length).toBeGreaterThan(0);
    });

    expect(mockSetPath).toHaveBeenCalledWith("/");
    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "/README.md", true, undefined, true);
  });

  it("switches workspace and notifies parent", async () => {
    const user = userEvent.setup();
    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    expect(mockOnWorkspaceChange).toHaveBeenCalledWith("FN-002");
  });

  it("keeps an errored nested selected file open on desktop after switching workspaces", async () => {
    const user = userEvent.setup();
    const nestedFile = "packages/dashboard/app/App.tsx";
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      error: "Could not load App.tsx",
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile={nestedFile}
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText(`Editor for ${nestedFile}`)).toBeInTheDocument());
    expect(screen.getByText("Could not load App.tsx")).toBeInTheDocument();
    mockSetPath.mockClear();

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    await waitFor(() => {
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("FN-002", nestedFile, true, undefined, true);
    });
    expect(screen.getByLabelText(`Editor for ${nestedFile}`)).toBeInTheDocument();
    expect(screen.getByText("Could not load App.tsx")).toBeInTheDocument();
    expect(document.querySelector(".file-browser-content.mobile")).toBeNull();
    expect(mockSetPath).toHaveBeenCalledWith("packages/dashboard/app");
    expect(mockOnWorkspaceChange).toHaveBeenCalledWith("FN-002");
  });

  it("replaces an errored selected file with newly loaded content after switching workspaces", async () => {
    const user = userEvent.setup();
    const nestedFile = "packages/dashboard/app/App.tsx";
    mockUseWorkspaceFileEditor.mockImplementation((workspace, filePath) => {
      if (workspace === "FN-002" && filePath === nestedFile) {
        return {
          ...defaultEditorState,
          content: "console.log('loaded from task worktree');",
          originalContent: "console.log('loaded from task worktree');",
          error: null,
        };
      }

      if (filePath === nestedFile) {
        return {
          ...defaultEditorState,
          content: "",
          originalContent: "",
          error: "Could not load App.tsx",
        };
      }

      return defaultEditorState;
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile={nestedFile}
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    await waitFor(() => expect(screen.getByText("Could not load App.tsx")).toBeInTheDocument());
    mockSetPath.mockClear();

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    await waitFor(() => {
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("FN-002", nestedFile, true, undefined, true);
    });
    expect(screen.queryByText("Could not load App.tsx")).not.toBeInTheDocument();
    expect(document.querySelector(".cm-content")?.textContent).toContain("console.log('loaded from task worktree');");
    expect(mockSetPath).toHaveBeenCalledWith("packages/dashboard/app");
  });

  it("keeps mobile on the errored nested selected file after switching workspaces", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });
    const user = userEvent.setup();
    const nestedFile = "packages/dashboard/app/App.tsx";
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      error: "Could not load App.tsx",
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile={nestedFile}
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByLabelText("Back to file list")).toBeInTheDocument());
    expect(screen.getByLabelText(`Editor for ${nestedFile}`)).toBeInTheDocument();
    mockSetPath.mockClear();

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    await waitFor(() => {
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("FN-002", nestedFile, true, undefined, true);
    });
    expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
    expect(screen.getByLabelText(`Editor for ${nestedFile}`)).toBeInTheDocument();
    expect(document.querySelector(".file-browser-content.mobile.active")).not.toBeNull();
    expect(document.querySelector(".file-browser-sidebar.mobile.active")).toBeNull();
    expect(mockSetPath).toHaveBeenCalledWith("packages/dashboard/app");
    expect(mockOnWorkspaceChange).toHaveBeenCalledWith("FN-002");
  });

  it("keeps the placeholder after switching workspaces with no selected file", async () => {
    const user = userEvent.setup();

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        onWorkspaceChange={mockOnWorkspaceChange}
      />,
    );

    expect(screen.getByText("Select a file to edit")).toBeInTheDocument();
    mockUseWorkspaceFileEditor.mockClear();

    await user.click(screen.getByRole("button", { name: /kb/i }));
    await user.click(screen.getByRole("button", { name: /FN-002 Task Two/i }));

    await waitFor(() => {
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("FN-002", null, true, undefined, true);
    });
    expect(screen.getByText("Select a file to edit")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Editor for /)).not.toBeInTheDocument();
    expect(mockSetPath).not.toHaveBeenCalledWith(expect.stringContaining("packages/dashboard/app"));
    expect(mockOnWorkspaceChange).toHaveBeenCalledWith("FN-002");
  });

  it("shows back button in mobile editor view", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));
    fireEvent.click(screen.getByText("file1.ts"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
    });
  });

  it("shows full editor toolbar actions directly in the narrow mobile file view", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      content: "# Heading\n\nBody",
      originalContent: "# Heading\n\nBody",
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        initialFile="README.md"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /toggle editor options/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preview mode/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle line numbers/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
  });

  it("switches between mobile editor layout and two-pane layout from floating modal width", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalWindowResizeObserver = window.ResizeObserver;
    const observedElements: Array<{ element: Element; callback: ResizeObserverCallback }> = [];
    const MockResizeObserver = class ResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        observedElements.push({ element, callback: this.callback });
      }
      unobserve() {}
      disconnect() {}
    };
    globalThis.ResizeObserver = MockResizeObserver;
    window.ResizeObserver = MockResizeObserver;

    try {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1024,
      });

      render(
        <FileBrowserModal
          initialWorkspace="project"
          initialFile="file1.ts"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const modal = document.querySelector(".file-browser-modal") as HTMLElement;
      expect(modal).toBeInTheDocument();
      await waitFor(() => expect(observedElements.some((entry) => entry.element === modal)).toBe(true));
      Object.defineProperty(modal, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 420, height: 700, top: 0, left: 0, bottom: 700, right: 420, x: 0, y: 0, toJSON: () => ({}) }),
      });

      await act(async () => {
        observedElements.find((entry) => entry.element === modal)?.callback([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(modal).toHaveClass("file-browser-modal--narrow");
      });
      expect(document.querySelector(".file-browser-content.mobile.active")).not.toBeNull();
      expect(document.querySelector(".file-browser-sidebar.mobile.active")).toBeNull();

      Object.defineProperty(modal, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 980, height: 700, top: 0, left: 0, bottom: 700, right: 980, x: 0, y: 0, toJSON: () => ({}) }),
      });

      await act(async () => {
        observedElements.find((entry) => entry.element === modal)?.callback([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(modal).not.toHaveClass("file-browser-modal--narrow");
      });
      expect(document.querySelector(".file-browser-content.mobile")).toBeNull();
      expect(document.querySelector(".file-browser-sidebar.mobile")).toBeNull();
      expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      window.ResizeObserver = originalWindowResizeObserver;
    }
  });

  it("keeps mobile close button visible and clickable", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    const closeButton = document.querySelector("button.modal-close");
    expect(closeButton).toBeInTheDocument();
    expect(closeButton).toBeVisible();

    fireEvent.click(closeButton!);
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it("close button is visible on mobile after selecting a file with a long path", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    // Provide a file with a long path name
    const longFileName = "packages/dashboard/app/components/SomeVeryLongComponentName.tsx";
    mockUseWorkspaceFileBrowser.mockReturnValue({
      ...defaultBrowserState,
      entries: [
        { name: longFileName, type: "file" as const, size: 2048, mtime: "2024-01-01" },
      ],
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    // Select the long-named file
    fireEvent.click(screen.getByText(longFileName));

    // Verify the file path appears in the header
    await waitFor(() => {
      const pathEl = document.querySelector(".file-browser-header-path");
      expect(pathEl).toBeInTheDocument();
      expect(pathEl?.textContent).toBe(longFileName);
    });

    const closeButton = document.querySelector("button.modal-close");
    expect(closeButton).toBeInTheDocument();
    expect(closeButton).toBeVisible();

    // Clicking the close button should trigger onClose
    fireEvent.click(closeButton!);
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it("long file path is truncated on mobile", async () => {
    // Read CSS file directly to verify the overflow/ellipsis rules
    // (JSDOM doesn't apply stylesheets, so computed style checks won't work)
    const { loadAllAppCss } = await import("../../test/cssFixture");
    const cssContent = loadAllAppCss();

    // Extract mobile media query blocks
    function extractMobileMediaBlocks(content: string): string {
      const blocks: string[] = [];
      const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
      let match;

      while ((match = regex.exec(content)) !== null) {
        const startIdx = match.index + match[0].length;
        let braceCount = 1;
        let endIdx = startIdx;

        while (braceCount > 0 && endIdx < content.length) {
          if (content[endIdx] === "{") braceCount += 1;
          if (content[endIdx] === "}") braceCount -= 1;
          endIdx += 1;
        }

        if (braceCount === 0) {
          blocks.push(content.slice(startIdx, endIdx - 1));
        }
      }

      return blocks.join("\n");
    }

    const mobileBlock = extractMobileMediaBlocks(cssContent);

    // Find the file-browser-header-path rule within mobile blocks
    const pathMatch = mobileBlock.match(
      /\.file-browser-header-path\s*\{([^}]*)\}/,
    );
    expect(pathMatch).not.toBeNull();

    const pathRules = pathMatch![1];
    expect(pathRules).toContain("text-overflow: ellipsis");
    expect(pathRules).toContain("white-space: nowrap");
    expect(pathRules).toContain("overflow: hidden");
    expect(pathRules).toContain("max-width: 50vw");
  });

  it("keeps the mobile file modal header easy to drag by touch", async () => {
    const { loadAllAppCss } = await import("../../test/cssFixture");
    const cssContent = loadAllAppCss();
    const baseHeaderRules = cssContent.match(/\.file-browser-modal-header\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(baseHeaderRules).toContain("touch-action: none");
    expect(baseHeaderRules).toContain("min-height: 48px");

    function extractMobileMediaBlocks(content: string): string {
      const blocks: string[] = [];
      const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
      let match;

      while ((match = regex.exec(content)) !== null) {
        const startIdx = match.index + match[0].length;
        let braceCount = 1;
        let endIdx = startIdx;

        while (braceCount > 0 && endIdx < content.length) {
          if (content[endIdx] === "{") braceCount += 1;
          if (content[endIdx] === "}") braceCount -= 1;
          endIdx += 1;
        }

        if (braceCount === 0) {
          blocks.push(content.slice(startIdx, endIdx - 1));
        }
      }

      return blocks.join("\n");
    }

    const mobileBlock = extractMobileMediaBlocks(cssContent);
    const mobileHeaderRules = mobileBlock.match(/\.file-browser-modal-header\s*\{([^}]*)\}/)?.[1] ?? "";
    const mobileHandleRules = mobileBlock.match(/\.file-browser-modal-header::before\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(mobileHeaderRules).toContain("min-height: 56px");
    expect(mobileHeaderRules).toContain("padding-block: calc(var(--space-md) + var(--space-xs)) var(--space-md)");
    expect(mobileHandleRules).toContain("position: absolute");
    expect(mobileHandleRules).toContain("background: color-mix(in srgb, var(--text-muted) 44%, transparent)");
  });

  it("closes on Escape and saves on Cmd+S", () => {
    mockUseWorkspaceFileEditor.mockReturnValue({
      ...defaultEditorState,
      hasChanges: true,
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "s", metaKey: true });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("renders hidden files and directories from the file listing", () => {
    mockUseWorkspaceFileBrowser.mockReturnValue({
      ...defaultBrowserState,
      entries: [
        { name: ".env.example", type: "file", size: 42, mtime: "2024-01-01" },
        { name: ".github", type: "directory", mtime: "2024-01-01" },
        { name: "src", type: "directory", mtime: "2024-01-01" },
      ],
    });

    render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    expect(screen.getByText(".env.example")).toBeInTheDocument();
    expect(screen.getByText(".github")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  describe("resizable sidebar split", () => {
    it("renders desktop resize handle with separator ARIA attributes", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-valuemin", "180");
      expect(handle).toHaveAttribute("aria-valuemax", "500");
      expect(handle).toHaveAttribute("aria-valuenow", "280");
      expect(handle).toHaveAttribute("tabindex", "0");
    });

    it("updates sidebar width while dragging the resize handle", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = document.querySelector(".file-browser-sidebar");
      expect(sidebar).not.toBeNull();

      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 360 });

      expect(sidebar).toHaveStyle({ width: "360px" });
      expect(handle).toHaveAttribute("aria-valuenow", "360");
    });

    it("does not render resize handle in mobile view", () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 375,
      });

      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      fireEvent(window, new Event("resize"));
      expect(screen.queryByRole("separator", { name: "Resize sidebar" })).not.toBeInTheDocument();
    });

    it("clamps sidebar width between min and max bounds", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = document.querySelector(".file-browser-sidebar");
      expect(sidebar).not.toBeNull();

      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: -1000 });
      expect(sidebar).toHaveStyle({ width: "180px" });

      fireEvent.pointerMove(document, { pointerId: 1, clientX: 2000 });
      expect(sidebar).toHaveStyle({ width: "500px" });
      expect(handle).toHaveAttribute("aria-valuenow", "500");
    });

    it("persists final sidebar width to localStorage on pointer up", () => {
      let onPointerMove: ((event: PointerEvent) => void) | null = null;
      let onPointerUp: ((event: PointerEvent) => void) | null = null;
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");

      addEventListenerSpy.mockImplementation((type, listener, options) => {
        if (type === "pointermove") {
          onPointerMove = listener as (event: PointerEvent) => void;
        }
        if (type === "pointerup") {
          onPointerUp = listener as (event: PointerEvent) => void;
        }
        return EventTarget.prototype.addEventListener.call(document, type, listener as EventListener, options);
      });

      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 280 });

      expect(onPointerMove).not.toBeNull();
      expect(onPointerUp).not.toBeNull();

      act(() => {
        onPointerMove?.({ clientX: 345, pointerId: 1 } as PointerEvent);
        onPointerUp?.({ pointerId: 1 } as PointerEvent);
      });

      expect(localStorage.getItem("fusion:file-browser-sidebar-width")).toBe("345");
    });

    it("supports keyboard resize with arrow keys and persists updated width", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = document.querySelector(".file-browser-sidebar");
      expect(sidebar).not.toBeNull();

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(sidebar).toHaveStyle({ width: "300px" });
      expect(handle).toHaveAttribute("aria-valuenow", "300");
      expect(localStorage.getItem("fusion:file-browser-sidebar-width")).toBe("300");

      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(sidebar).toHaveStyle({ width: "280px" });
      expect(handle).toHaveAttribute("aria-valuenow", "280");
      expect(localStorage.getItem("fusion:file-browser-sidebar-width")).toBe("280");
    });

    it("clamps keyboard resize within min and max bounds", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = document.querySelector(".file-browser-sidebar");
      expect(sidebar).not.toBeNull();

      for (let i = 0; i < 30; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowLeft" });
      }
      expect(sidebar).toHaveStyle({ width: "180px" });
      expect(handle).toHaveAttribute("aria-valuenow", "180");

      for (let i = 0; i < 30; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowRight" });
      }
      expect(sidebar).toHaveStyle({ width: "500px" });
      expect(handle).toHaveAttribute("aria-valuenow", "500");
    });

    it("ignores non-arrow keys when resizing from keyboard", () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = document.querySelector(".file-browser-sidebar");
      expect(sidebar).not.toBeNull();

      fireEvent.keyDown(handle, { key: "Enter" });

      expect(sidebar).toHaveStyle({ width: "280px" });
      expect(handle).toHaveAttribute("aria-valuenow", "280");
      expect(localStorage.getItem("fusion:file-browser-sidebar-width")).toBeNull();
    });

    it("defines focus-visible styling for the resize handle", async () => {
      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();

      expect(css).toMatch(/\.file-browser-resize-handle:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring-strong\);/);
    });
  });

  describe("browser-native file previews", () => {
    const renderWithEntries = (entries: typeof defaultBrowserState.entries, props: Partial<ComponentProps<typeof FileBrowserModal>> = {}) => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries,
      });

      return render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
          {...props}
        />,
      );
    };

    const selectFile = async (name: string) => {
      await act(async () => {
        fireEvent.click(screen.getByText(name));
      });
    };

    it.each([
      {
        name: "screenshot.png",
        role: "img" as const,
        selector: "img.file-browser-preview-media--image",
        attribute: "src",
      },
      {
        name: "clip.mp4",
        role: null,
        selector: "video.file-browser-preview-media--video",
        attribute: "src",
      },
      {
        name: "voice.mp3",
        role: null,
        selector: "audio.file-browser-preview-media--audio",
        attribute: "src",
      },
      {
        name: "manual.pdf",
        role: null,
        selector: "iframe.file-browser-preview-media--pdf",
        attribute: "src",
      },
    ])("renders $name with the native project preview element", async ({ name, role, selector, attribute }) => {
      mockUseWorkspaceFileEditor.mockReturnValue({
        ...defaultEditorState,
        hasChanges: true,
      });
      renderWithEntries([
        { name, type: "file" as const, size: 102400, mtime: "2024-01-01" },
      ]);

      await selectFile(name);

      const preview = role === "img"
        ? screen.getByRole(role, { name })
        : document.querySelector(selector);
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveAttribute(attribute, expect.stringContaining(encodeURIComponent(name)));
      expect(preview).toHaveAttribute(attribute, expect.stringContaining("workspace=project"));
      expect(preview).toHaveAttribute(attribute, expect.stringContaining("inline=1"));
      if (selector.startsWith("video") || selector.startsWith("audio")) {
        expect(preview).toHaveAttribute("controls");
        expect(preview).toHaveAttribute("aria-label", `Preview for ${name}`);
      }
      if (selector.startsWith("iframe")) {
        expect(preview).toHaveAttribute("title", `Preview for ${name}`);
      }

      expect(screen.getByText("Preview only")).toBeInTheDocument();
      expect(screen.queryByText(/Binary file — read only/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(new RegExp(`Editor for ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle editor options/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Discard/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
      expect(document.querySelector(".file-editor-wrapper")).not.toBeInTheDocument();
      expect(document.querySelector(".file-browser-footer")).not.toBeInTheDocument();
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", name, false, undefined, false);
    });

    it("renders task-workspace preview URLs with project scoping", async () => {
      renderWithEntries([
        { name: "movie.mov", type: "file" as const, size: 204800, mtime: "2024-01-01" },
      ], {
        initialWorkspace: "FN-001",
        projectId: "proj-1",
      });

      await selectFile("movie.mov");

      const video = document.querySelector("video.file-browser-preview-media--video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", expect.stringContaining("workspace=FN-001"));
      expect(video).toHaveAttribute("src", expect.stringContaining("projectId=proj-1"));
      expect(video).toHaveAttribute("src", expect.stringContaining("inline=1"));
      expect(video).toHaveAttribute("src", expect.stringContaining("movie.mov"));
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("FN-001", "movie.mov", false, "proj-1", false);
    });

    it("previews uppercase and nested PDF paths without loading editor content", async () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          initialFile="docs/MANUAL.PDF"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => expect(document.querySelector("iframe.file-browser-preview-media--pdf")).toBeInTheDocument());
      const pdf = document.querySelector("iframe.file-browser-preview-media--pdf");
      expect(pdf).toHaveAttribute("src", expect.stringContaining(encodeURIComponent("docs/MANUAL.PDF")));
      expect(pdf).toHaveAttribute("src", expect.stringContaining("inline=1"));
      expect(pdf).toHaveAttribute("title", "Preview for docs/MANUAL.PDF");
      expect(mockSetPath).toHaveBeenCalledWith("docs");
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "docs/MANUAL.PDF", false, undefined, false);
    });

    it("keeps text files editable with save and discard controls", async () => {
      mockUseWorkspaceFileEditor.mockReturnValue({
        ...defaultEditorState,
        hasChanges: true,
      });

      renderWithEntries([
        { name: "file1.ts", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      ]);

      await selectFile("file1.ts");

      expect(screen.getByLabelText("Editor for file1.ts")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Discard/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "file1.ts", true, undefined, true);
    });

    it("keeps unknown binary files in the read-only editor fallback", async () => {
      renderWithEntries([
        { name: "archive.zip", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      ]);

      await selectFile("archive.zip");

      expect(screen.getByText(/Binary file — read only/)).toBeInTheDocument();
      expect(screen.getByLabelText("Editor for archive.zip")).toBeInTheDocument();
      expect(document.querySelector(".file-browser-preview")).not.toBeInTheDocument();
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "archive.zip", true, undefined, false);
    });

    it("keeps the no-selected-file placeholder until a previewable file is selected", async () => {
      renderWithEntries([
        { name: "voice.mp3", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      ]);

      expect(screen.getByText("Select a file to edit")).toBeInTheDocument();
      expect(document.querySelector(".file-browser-preview")).not.toBeInTheDocument();

      await selectFile("voice.mp3");

      expect(screen.queryByText("Select a file to edit")).not.toBeInTheDocument();
      expect(document.querySelector("audio.file-browser-preview-media--audio")).toBeInTheDocument();
    });

    it("updates preview-only state across repeated selections", async () => {
      renderWithEntries([
        { name: "manual.pdf", type: "file" as const, size: 1024, mtime: "2024-01-01" },
        { name: "clip.mp4", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      ]);

      await selectFile("manual.pdf");
      expect(document.querySelector("iframe.file-browser-preview-media--pdf")).toBeInTheDocument();

      await selectFile("clip.mp4");
      expect(document.querySelector("iframe.file-browser-preview-media--pdf")).not.toBeInTheDocument();
      const video = document.querySelector("video.file-browser-preview-media--video");
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("src", expect.stringContaining("clip.mp4"));
      expect(video).toHaveAttribute("src", expect.stringContaining("inline=1"));
      expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "clip.mp4", false, undefined, false);
    });

    it("renders preview-only files in the mobile editor pane with back navigation", async () => {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 375,
      });

      renderWithEntries([
        { name: "voice.mp3", type: "file" as const, size: 1024, mtime: "2024-01-01" },
      ]);

      fireEvent(window, new Event("resize"));
      await selectFile("voice.mp3");

      expect(screen.getByLabelText("Back to file list")).toBeInTheDocument();
      const audio = document.querySelector("audio.file-browser-preview-media--audio");
      expect(audio).toBeInTheDocument();
      expect(audio).toHaveAttribute("src", expect.stringContaining("inline=1"));
      expect(document.querySelector(".file-browser-content.mobile.active")).toBeInTheDocument();
    });
  });

  describe("line number toggle", () => {
    const clickFileEntry = async (name: string) => {
      const fileEntry = screen.getAllByText(name).find((element) => element.classList.contains("file-node-name"));
      expect(fileEntry).toBeTruthy();

      await act(async () => {
        fireEvent.click(fileEntry!);
      });
    };

    it("renders an editor toggle and persists preference per project", async () => {
      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
          projectId="proj-1"
        />,
      );

      await clickFileEntry("file1.ts");

      fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
      const toggle = screen.getByRole("button", { name: /toggle line numbers/i });
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(localStorage.getItem("kb:proj-1:kb-files-line-numbers")).toBe("true");
    });

    it("loads persisted preference when project changes", async () => {
      localStorage.setItem("kb:proj-a:kb-files-line-numbers", "true");
      localStorage.setItem("kb:proj-b:kb-files-line-numbers", "false");

      const { rerender } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
          projectId="proj-a"
        />,
      );

      await clickFileEntry("file1.ts");

      fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
      expect(screen.getByRole("button", { name: /toggle line numbers/i })).toHaveAttribute("aria-pressed", "true");

      rerender(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
          projectId="proj-b"
        />,
      );

      await clickFileEntry("file1.ts");

      if (!screen.queryByRole("button", { name: /toggle line numbers/i })) {
        fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
      }
      expect(screen.getByRole("button", { name: /toggle line numbers/i })).toHaveAttribute("aria-pressed", "false");
    });

    it("only shows gutter for editable text files", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "editable.ts", type: "file" as const, size: 64, mtime: "2024-01-01" },
          { name: "readme.pdf", type: "file" as const, size: 64, mtime: "2024-01-01" },
        ],
      });

      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText("editable.ts"));
      });

      fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
      fireEvent.click(screen.getByRole("button", { name: /toggle line numbers/i }));
      expect(document.querySelector(".cm-gutters")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText("readme.pdf"));
      });

      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
      expect(document.querySelector(".cm-gutters")).not.toBeInTheDocument();
    });
  });

  describe("modal height constraint regression", () => {
    it("max-height uses calc() to stay within viewport padding", async () => {
      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();

      // Extract the first .file-browser-modal block (desktop base styles)
      // Match from ".file-browser-modal {" to its closing "}"
      const blockMatch = css.match(
        /\.file-browser-modal\s*\{[^}]*max-height:\s*([^;]+);/,
      );
      expect(blockMatch).toBeTruthy();
      const maxHeightValue = blockMatch![1].trim();

      // The max-height must use calc() with the overlay-padding-top variable
      // so the modal fits within the visible viewport. We accept either
      // 100vh or 100dvh (the latter accounts for mobile dynamic viewport
      // chrome and is preferred for the resize-aware modals).
      expect(maxHeightValue).toContain("calc(");
      expect(maxHeightValue).toContain("--overlay-padding-top");
      expect(maxHeightValue).toMatch(/100d?vh/);
    });

    it("height and max-height together do not exceed viewport on desktop", async () => {
      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();

      const blockMatch = css.match(
        /\.file-browser-modal\s*\{([^}]*)\}/,
      );
      expect(blockMatch).toBeTruthy();
      const block = blockMatch![1];

      // Extract height value
      const heightMatch = block.match(/height:\s*([^;]+);/);
      expect(heightMatch).toBeTruthy();
      const heightValue = heightMatch![1].trim();

      // height should be a reasonable vh value (≤ 85vh for desktop)
      const heightNum = parseFloat(heightValue);
      expect(heightNum).toBeGreaterThan(0);
      expect(heightNum).toBeLessThanOrEqual(85);

      // max-height must be present and use calc()
      const maxHeightMatch = block.match(/max-height:\s*([^;]+);/);
      expect(maxHeightMatch).toBeTruthy();
      expect(maxHeightMatch![1].trim()).toContain("calc(");
    });

    it("mobile styles use 100dvh for full-screen behavior", async () => {
      const { loadAllAppCss } = await import("../../test/cssFixture");
      const css = loadAllAppCss();

      // Extract mobile media query blocks (similar to existing pattern)
      function extractMobileMediaBlocks(content: string): string {
        const blocks: string[] = [];
        const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
        let match;

        while ((match = regex.exec(content)) !== null) {
          const startIdx = match.index + match[0].length;
          let braceCount = 1;
          let endIdx = startIdx;

          while (braceCount > 0 && endIdx < content.length) {
            if (content[endIdx] === "{") braceCount += 1;
            if (content[endIdx] === "}") braceCount -= 1;
            endIdx += 1;
          }

          if (braceCount === 0) {
            blocks.push(content.slice(startIdx, endIdx - 1));
          }
        }

        return blocks.join("\n");
      }

      const mobileBlock = extractMobileMediaBlocks(css);

      // Find the file-browser-modal rule within mobile blocks
      const modalMatch = mobileBlock.match(
        /\.file-browser-modal\s*\{([^}]*)\}/,
      );
      expect(modalMatch).not.toBeNull();

      const modalRules = modalMatch![1];
      // Mobile should use 100dvh for height/max-height
      expect(modalRules).toContain("100dvh");
    });
  });
});
