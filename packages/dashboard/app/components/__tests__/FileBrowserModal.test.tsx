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

    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "file1.ts", true, undefined);
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
    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "packages/dashboard/app/App.tsx", true, undefined);
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

  it("keeps mobile close button visible and clickable", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 375,
    });

    const { container } = render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    fireEvent(window, new Event("resize"));

    const closeButton = container.querySelector("button.modal-close");
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

    const { container } = render(
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
      const pathEl = container.querySelector(".file-browser-header-path");
      expect(pathEl).toBeInTheDocument();
      expect(pathEl?.textContent).toBe(longFileName);
    });

    const closeButton = container.querySelector("button.modal-close");
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
      const { container } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = container.querySelector(".file-browser-sidebar");
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
      const { container } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = container.querySelector(".file-browser-sidebar");
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
      const { container } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = container.querySelector(".file-browser-sidebar");
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
      const { container } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = container.querySelector(".file-browser-sidebar");
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
      const { container } = render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      const handle = screen.getByRole("separator", { name: "Resize sidebar" });
      const sidebar = container.querySelector(".file-browser-sidebar");
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

  describe("image file preview", () => {
    it("renders image preview for .png files instead of editor", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "screenshot.png", type: "file" as const, size: 102400, mtime: "2024-01-01" },
        ],
      });

      render(
        <FileBrowserModal
          initialWorkspace="project"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      // Select the image file
      await act(async () => {
        fireEvent.click(screen.getByText("screenshot.png"));
      });

      // Should render an image preview
      const imagePreview = screen.getByRole("img", { name: "screenshot.png" });
      expect(imagePreview).toBeInTheDocument();
      expect(imagePreview).toHaveAttribute("src", expect.stringContaining("screenshot.png"));

      // Should NOT render the text editor
      expect(screen.queryByLabelText(/Editor for screenshot.png/)).not.toBeInTheDocument();
    });

    it("renders image preview for .jpg files instead of editor", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "photo.jpg", type: "file" as const, size: 204800, mtime: "2024-01-01" },
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
        fireEvent.click(screen.getByText("photo.jpg"));
      });

      const imagePreview = screen.getByRole("img", { name: "photo.jpg" });
      expect(imagePreview).toBeInTheDocument();
    });

    it("renders image preview for .gif files instead of editor", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "animation.gif", type: "file" as const, size: 51200, mtime: "2024-01-01" },
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
        fireEvent.click(screen.getByText("animation.gif"));
      });

      const imagePreview = screen.getByRole("img", { name: "animation.gif" });
      expect(imagePreview).toBeInTheDocument();
    });

    it("renders image preview for .webp files instead of editor", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "image.webp", type: "file" as const, size: 76800, mtime: "2024-01-01" },
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
        fireEvent.click(screen.getByText("image.webp"));
      });

      const imagePreview = screen.getByRole("img", { name: "image.webp" });
      expect(imagePreview).toBeInTheDocument();
    });

    it("hides save/discard actions for image files", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "test.png", type: "file" as const, size: 1024, mtime: "2024-01-01" },
        ],
      });

      // Mock editor state with changes
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

      await act(async () => {
        fireEvent.click(screen.getByText("test.png"));
      });

      // Should NOT show Discard or Save buttons for images
      expect(screen.queryByRole("button", { name: /Discard/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    });

    it("still shows save/discard actions for text files with changes", async () => {
      // Mock editor state with changes
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

      // Select a text file
      await act(async () => {
        fireEvent.click(screen.getByText("file1.ts"));
      });

      // Should show Discard and Save buttons
      expect(screen.getByRole("button", { name: /Discard/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument();
    });

    it("renders file editor for non-image binary files like .pdf", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "document.pdf", type: "file" as const, size: 1024000, mtime: "2024-01-01" },
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
        fireEvent.click(screen.getByText("document.pdf"));
      });

      // Should show binary indicator
      expect(screen.getByText(/Binary file — read only/)).toBeInTheDocument();

      // Should NOT render an image preview
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("image preview uses workspace-safe URL pattern", async () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({
        ...defaultBrowserState,
        entries: [
          { name: "test.png", type: "file" as const, size: 1024, mtime: "2024-01-01" },
        ],
      });

      render(
        <FileBrowserModal
          initialWorkspace="FN-001"
          isOpen={true}
          onClose={mockOnClose}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByText("test.png"));
      });

      const imagePreview = screen.getByRole("img", { name: "test.png" });
      // URL should include workspace parameter
      expect(imagePreview).toHaveAttribute(
        "src",
        expect.stringContaining("workspace=FN-001")
      );
      expect(imagePreview).toHaveAttribute(
        "src",
        expect.stringContaining("test.png")
      );
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
