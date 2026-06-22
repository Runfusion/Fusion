import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowser } from "../FileBrowser";
import type { FileNode } from "../../api";
import { clearAuthToken } from "../../auth";

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    Folder: (props: any) => <span data-testid="folder-icon" {...props} />,
    File: (props: any) => <span data-testid="file-icon" {...props} />,
    ChevronRight: (props: any) => <span data-testid="chevron" {...props} />,
    Loader2: (props: any) => <span data-testid="loader" {...props} />,
    Copy: (props: any) => <span data-testid="icon-copy" {...props} />,
    Move: (props: any) => <span data-testid="icon-move" {...props} />,
    Trash2: (props: any) => <span data-testid="icon-trash" {...props} />,
    Pencil: (props: any) => <span data-testid="icon-pencil" {...props} />,
    Download: (props: any) => <span data-testid="icon-download" {...props} />,
    Archive: (props: any) => <span data-testid="icon-archive" {...props} />,
    FilePlus2: (props: any) => <span data-testid="icon-file-plus" {...props} />,
    FolderPlus: (props: any) => <span data-testid="icon-folder-plus" {...props} />,
  };
});

const mockCopyFile = vi.fn();
const mockCreateWorkspaceDirectory = vi.fn();
const mockCreateWorkspaceFile = vi.fn();
const mockMoveFile = vi.fn();
const mockDeleteFile = vi.fn();
const mockRenameFile = vi.fn();
const mockDownloadFileUrl = vi.fn((_workspace: string, filePath: string) =>
  `/api/files/${encodeURIComponent(filePath)}/download?workspace=test-ws`,
);
const mockDownloadZipUrl = vi.fn((_workspace: string, filePath: string) =>
  `/api/files/${encodeURIComponent(filePath)}/download-zip?workspace=test-ws`,
);

vi.mock("../../api", () => ({
  copyFile: (...args: any[]) => mockCopyFile(...args),
  createWorkspaceDirectory: (...args: any[]) => mockCreateWorkspaceDirectory(...args),
  createWorkspaceFile: (...args: any[]) => mockCreateWorkspaceFile(...args),
  moveFile: (...args: any[]) => mockMoveFile(...args),
  deleteFile: (...args: any[]) => mockDeleteFile(...args),
  renameFile: (...args: any[]) => mockRenameFile(...args),
  downloadFileUrl: (workspace: string, filePath: string) => mockDownloadFileUrl(workspace, filePath),
  downloadZipUrl: (workspace: string, filePath: string) => mockDownloadZipUrl(workspace, filePath),
}));

// ── Test Data ───────────────────────────────────────────────────────────

const fileEntry: FileNode = {
  name: "readme.md",
  type: "file",
  size: 1234,
  mtime: "2026-01-15T10:30:00Z",
};

const dirEntry: FileNode = {
  name: "src",
  type: "directory",
  mtime: "2026-01-14T08:00:00Z",
};

const sampleEntries: FileNode[] = [dirEntry, fileEntry];

// ── Helpers ─────────────────────────────────────────────────────────────

const defaultProps = {
  entries: sampleEntries,
  currentPath: ".",
  onSelectFile: vi.fn(),
  onNavigate: vi.fn(),
  workspace: "test-ws",
  onRefresh: vi.fn(),
  projectId: "project-1",
};

/** Props accepted by renderFileBrowser — superset of defaultProps with FileBrowser optional fields. */
type FileBrowserTestOverrides = Partial<typeof defaultProps> & {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

function renderFileBrowser(overrides: FileBrowserTestOverrides = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<FileBrowser {...props} />);
}

function contextMenuClick(entryName: string, coords: { x: number; y: number } = { x: 200, y: 300 }) {
  const entry = screen.getByText(entryName).closest(".file-node");
  if (!entry) throw new Error(`Entry not found: ${entryName}`);
  fireEvent.contextMenu(entry, { clientX: coords.x, clientY: coords.y });
}

function touchStart(entryName: string, coords: { x: number; y: number } = { x: 200, y: 300 }) {
  const entry = screen.getByText(entryName).closest(".file-node");
  if (!entry) throw new Error(`Entry not found: ${entryName}`);
  fireEvent.touchStart(entry, {
    touches: [{ clientX: coords.x, clientY: coords.y }],
  });
  return entry;
}

function openNewMenu() {
  fireEvent.click(screen.getByRole("button", { name: /^New$/i }));
}

function getNewFileAction() {
  return screen.getByRole("menuitem", { name: /New File/i });
}

function getNewFolderAction() {
  return screen.getByRole("menuitem", { name: /New Folder/i });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    mockDownloadFileUrl.mockImplementation((_workspace: string, filePath: string) =>
      `/api/files/${encodeURIComponent(filePath)}/download?workspace=test-ws`,
    );
    mockDownloadZipUrl.mockImplementation((_workspace: string, filePath: string) =>
      `/api/files/${encodeURIComponent(filePath)}/download-zip?workspace=test-ws`,
    );
    vi.useRealTimers();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 768,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    clearAuthToken();
    localStorage.removeItem("fn.authToken");
    cleanup();
  });

  // ── Basic Rendering ─────────────────────────────────────────────────

  it("renders file entries with names and sizes", () => {
    renderFileBrowser();
    expect(screen.getByText("readme.md")).toBeDefined();
    expect(screen.getByText("src")).toBeDefined();
    expect(screen.getByText("1.2 KB")).toBeDefined();
  });

  it("shows root path label", () => {
    renderFileBrowser({ currentPath: "." });
    expect(screen.getByText("Root")).toBeDefined();
  });

  it("shows current path when not root", () => {
    renderFileBrowser({ currentPath: "packages/core" });
    expect(screen.getByText("packages/core")).toBeDefined();
  });

  it("shows empty directory message when no entries", () => {
    renderFileBrowser({ entries: [] });
    expect(screen.getByText("(empty directory)")).toBeDefined();
  });

  it("renders New menu with file and folder actions when workspace is provided", () => {
    renderFileBrowser();
    openNewMenu();
    expect(getNewFileAction()).toBeDefined();
    expect(getNewFolderAction()).toBeDefined();
  });

  it("disables the create menu when no workspace is provided", () => {
    renderFileBrowser({ workspace: undefined });
    expect(screen.getByRole("button", { name: /^New$/i })).toBeDisabled();
  });

  it("clicking New File opens a dialog with name input", () => {
    renderFileBrowser();
    openNewMenu();
    fireEvent.click(getNewFileAction());
    expect(document.querySelector(".file-browser-dialog-title")?.textContent).toBe("New File");
    expect(screen.getByPlaceholderText("File name")).toBeDefined();
  });

  it("clicking New Folder opens a dialog with name input", () => {
    renderFileBrowser();
    openNewMenu();
    fireEvent.click(getNewFolderAction());
    expect(document.querySelector(".file-browser-dialog-title")?.textContent).toBe("New Folder");
    expect(screen.getByPlaceholderText("Folder name")).toBeDefined();
  });

  it("creating a file calls createWorkspaceFile, refreshes, and selects the file", async () => {
    mockCreateWorkspaceFile.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    const onSelectFile = vi.fn();
    renderFileBrowser({ currentPath: "docs", onRefresh, onSelectFile });
    openNewMenu();
    fireEvent.click(getNewFileAction());
    fireEvent.change(screen.getByPlaceholderText("File name"), { target: { value: "notes.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateWorkspaceFile).toHaveBeenCalledWith("test-ws", "docs/notes.md", "project-1");
      expect(onRefresh).toHaveBeenCalled();
      expect(onSelectFile).toHaveBeenCalledWith("docs/notes.md");
    });
  });

  it("creating a folder calls createWorkspaceDirectory and refreshes", async () => {
    mockCreateWorkspaceDirectory.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    renderFileBrowser({ currentPath: "docs", onRefresh });
    openNewMenu();
    fireEvent.click(getNewFolderAction());
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateWorkspaceDirectory).toHaveBeenCalledWith("test-ws", "docs/drafts", "project-1");
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("shows create error state in dialog", async () => {
    mockCreateWorkspaceDirectory.mockRejectedValue(new Error("Already exists"));
    renderFileBrowser();
    openNewMenu();
    fireEvent.click(getNewFolderAction());
    fireEvent.change(screen.getByPlaceholderText("Folder name"), { target: { value: "src" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Already exists")).toBeDefined();
    });
  });

  it("cancels create dialog on Cancel", () => {
    renderFileBrowser();
    openNewMenu();
    fireEvent.click(getNewFileAction());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("File name")).toBeNull();
  });

  it("closes create dialog on Escape", () => {
    renderFileBrowser();
    openNewMenu();
    fireEvent.click(getNewFolderAction());
    fireEvent.keyDown(screen.getByPlaceholderText("Folder name"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("Folder name")).toBeNull();
  });

  it("shows loading state", () => {
    renderFileBrowser({ entries: [], loading: true });
    expect(screen.getByText("Loading files...")).toBeDefined();
  });

  it("shows error state with retry button", () => {
    const onRetry = vi.fn();
    renderFileBrowser({ entries: [], error: "Something broke", onRetry });
    expect(screen.getByText(/Something broke/)).toBeDefined();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  // ── Navigation ──────────────────────────────────────────────────────

  it("navigates into directory on click", () => {
    const onNavigate = vi.fn();
    renderFileBrowser({ onNavigate });
    fireEvent.click(screen.getByText("src"));
    expect(onNavigate).toHaveBeenCalledWith("src");
  });

  it("selects file on click", () => {
    const onSelectFile = vi.fn();
    renderFileBrowser({ onSelectFile });
    fireEvent.click(screen.getByText("readme.md"));
    expect(onSelectFile).toHaveBeenCalledWith("readme.md");
  });

  it("navigates into nested directory", () => {
    const onNavigate = vi.fn();
    renderFileBrowser({ currentPath: "packages", onNavigate });
    fireEvent.click(screen.getByText("src"));
    expect(onNavigate).toHaveBeenCalledWith("packages/src");
  });

  it("navigates up one level", () => {
    const onNavigate = vi.fn();
    renderFileBrowser({ currentPath: "packages/core/src", onNavigate });
    const upButton = screen.getByText("Up one level");
    fireEvent.click(upButton);
    expect(onNavigate).toHaveBeenCalledWith("packages/core");
  });

  // ── Context Menu Appearance ─────────────────────────────────────────

  it("shows context menu on right-click on a file", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    // Menu should be visible with the role
    expect(screen.getByRole("menu")).toBeDefined();
  });

  it("shows context menu on right-click on a directory", () => {
    renderFileBrowser();
    contextMenuClick("src");
    expect(screen.getByRole("menu")).toBeDefined();
  });

  it("opens context menu on long-press for a file entry", () => {
    vi.useFakeTimers();
    const onSelectFile = vi.fn();
    renderFileBrowser({ onSelectFile });

    touchStart("readme.md", { x: 120, y: 180 });
    act(() => {
      vi.advanceTimersByTime(220);
    });

    const fileNode = screen.getByText("readme.md").closest(".file-node");
    expect(fileNode?.classList.contains("file-node--long-pressing")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByRole("menu")).toBeDefined();
    expect(onSelectFile).not.toHaveBeenCalled();

    fireEvent.touchEnd(fileNode!);
  });

  it("opens context menu on long-press for a directory entry", () => {
    vi.useFakeTimers();
    const onNavigate = vi.fn();
    renderFileBrowser({ onNavigate });

    const dirNode = touchStart("src", { x: 160, y: 210 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByRole("menu")).toBeDefined();
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.touchEnd(dirNode);
  });

  it("cancels long-press when touch moves beyond threshold", () => {
    vi.useFakeTimers();
    renderFileBrowser();

    const fileNode = touchStart("readme.md", { x: 100, y: 100 });
    fireEvent.touchMove(fileNode, {
      touches: [{ clientX: 120, clientY: 120 }],
    });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(fileNode.classList.contains("file-node--long-pressing")).toBe(false);
  });

  it("keeps single-tap selection behavior on touch devices", () => {
    vi.useFakeTimers();
    const onSelectFile = vi.fn();
    renderFileBrowser({ onSelectFile });

    const fileNode = touchStart("readme.md", { x: 120, y: 160 });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.touchEnd(fileNode);
    fireEvent.click(fileNode);

    expect(onSelectFile).toHaveBeenCalledWith("readme.md");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // ── Context Menu Items for Files ────────────────────────────────────

  it("shows file context menu with Download option (not Download as ZIP)", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    expect(screen.getByText("Download")).toBeDefined();
    expect(screen.queryByText("Download as ZIP")).toBeNull();
  });

  it("shows Copy, Move, Rename, Delete for files", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    expect(screen.getByText("Copy")).toBeDefined();
    expect(screen.getByText("Move")).toBeDefined();
    expect(screen.getByText("Rename")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  // ── Context Menu Items for Directories ──────────────────────────────

  it("shows directory context menu with Download as ZIP (not Download)", () => {
    renderFileBrowser();
    contextMenuClick("src");
    expect(screen.getByText("Download as ZIP")).toBeDefined();
    expect(screen.queryByText("Download")).toBeNull();
  });

  // ── Context Menu Closing ────────────────────────────────────────────

  it("closes context menu on Escape key", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes context menu on overlay click", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    const overlay = document.querySelector(".context-menu-overlay");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clamps context menu position within visual viewport bounds", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 640,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 700,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: {
        width: 320,
        height: 480,
        offsetTop: 20,
        offsetLeft: 10,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const nativeGetRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList?.contains("file-browser-context-menu")) {
        return {
          x: 0,
          y: 0,
          width: 180,
          height: 220,
          top: 0,
          right: 180,
          bottom: 220,
          left: 0,
          toJSON: () => ({}),
        };
      }
      return nativeGetRect.call(this);
    });

    renderFileBrowser();
    contextMenuClick("readme.md", { x: 400, y: 500 });

    const menu = await screen.findByRole("menu");

    await waitFor(() => {
      expect(menu).toHaveStyle({ left: "142px", top: "272px" });
    });
  });

  it("defines mobile-friendly touch targets for context menu items", () => {
    const css = loadAllAppCss();
    expect(css).toMatch(/\.file-browser-context-menu__item\s*\{[^}]*min-height:\s*36px;/);
  });

  // ── Download Actions ────────────────────────────────────────────────

  it("opens download URL for file when Download is clicked", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Download"));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/files/readme.md/download?workspace=test-ws",
      "_blank"
    );
    openSpy.mockRestore();
  });

  it("appends daemon token query for same-origin file download URLs", () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Download"));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/files/readme.md/download?workspace=test-ws&fn_token=daemon-token",
      "_blank"
    );
    openSpy.mockRestore();
  });

  it("opens download-zip URL for directory when Download as ZIP is clicked", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderFileBrowser();
    contextMenuClick("src");
    fireEvent.click(screen.getByText("Download as ZIP"));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/files/src/download-zip?workspace=test-ws",
      "_blank"
    );
    openSpy.mockRestore();
  });

  it("does not append daemon token query for cross-origin download URLs", () => {
    localStorage.setItem("fn.authToken", "daemon-token");
    mockDownloadFileUrl.mockReturnValue("https://downloads.example.com/readme.md");
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Download"));

    expect(openSpy).toHaveBeenCalledWith("https://downloads.example.com/readme.md", "_blank");
    openSpy.mockRestore();
  });

  // ── Delete Dialog ───────────────────────────────────────────────────

  it("shows delete confirmation dialog when Delete is clicked", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete File")).toBeDefined();
    expect(screen.getByText(/Are you sure you want to delete/)).toBeDefined();
  });

  it("shows directory delete warning for directories", () => {
    renderFileBrowser();
    contextMenuClick("src");
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText("Delete Folder")).toBeDefined();
    expect(screen.getByText(/recursively/)).toBeDefined();
  });

  it("calls deleteFile API and refreshes on delete confirm", async () => {
    mockDeleteFile.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    renderFileBrowser({ onRefresh });
    contextMenuClick("readme.md");
    // Click Delete in the context menu (role=menuitem)
    const menuDelete = screen.getAllByText("Delete").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuDelete!);
    // Click the danger Delete button in the confirmation dialog
    const dangerBtn = document.querySelector(".btn-danger");
    expect(dangerBtn).not.toBeNull();
    fireEvent.click(dangerBtn!);
    await waitFor(() => {
      expect(mockDeleteFile).toHaveBeenCalledWith("test-ws", "readme.md", "project-1");
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("shows error when delete fails", async () => {
    mockDeleteFile.mockRejectedValue(new Error("Delete failed"));
    renderFileBrowser();
    contextMenuClick("readme.md");
    // Click Delete in the menu
    const menuItems = screen.getAllByText("Delete");
    fireEvent.click(menuItems[0]);
    // Click Delete in the dialog
    const dialogBtn = screen.getAllByText("Delete");
    const deleteButton = dialogBtn.find(
      (el) => el.closest("button")?.classList.contains("btn-danger")
    );
    if (deleteButton) {
      fireEvent.click(deleteButton.closest("button")!);
    }
    await waitFor(() => {
      expect(screen.getByText("Delete failed")).toBeDefined();
    });
  });

  it("closes delete dialog on Cancel", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Delete"));
    // Click Cancel in the dialog
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByText("Delete File")).toBeNull();
  });

  // ── Rename Dialog ───────────────────────────────────────────────────

  it("shows rename dialog with pre-filled name", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    // Click Rename in the context menu (role=menuitem)
    const menuRename = screen.getAllByText("Rename").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuRename!);
    const input = screen.getByPlaceholderText("New name") as HTMLInputElement;
    expect(input.value).toBe("readme.md");
  });

  it("calls renameFile API and refreshes on rename confirm", async () => {
    mockRenameFile.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    renderFileBrowser({ onRefresh });
    contextMenuClick("readme.md");
    // Click Rename in the menu
    const menuRename = screen.getAllByText("Rename").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuRename!);
    // Type new name in the dialog input
    const input = screen.getByPlaceholderText("New name");
    fireEvent.change(input, { target: { value: "new-readme.md" } });
    // Click Rename in the dialog
    const dialogRename = screen.getAllByText("Rename").find(
      (el) => el.closest("button")?.classList.contains("btn-primary")
    );
    fireEvent.click(dialogRename!.closest("button")!);
    await waitFor(() => {
      expect(mockRenameFile).toHaveBeenCalledWith("test-ws", "readme.md", "new-readme.md", "project-1");
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("closes rename dialog on Cancel", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    fireEvent.click(screen.getByText("Rename"));
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByPlaceholderText("New name")).toBeNull();
  });

  // ── Copy Dialog ─────────────────────────────────────────────────────

  it("shows copy dialog with destination input", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    const menuCopy = screen.getAllByText("Copy").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuCopy!);
    expect(screen.getByPlaceholderText("Destination path")).toBeDefined();
  });

  it("calls copyFile API and refreshes on copy confirm", async () => {
    mockCopyFile.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    renderFileBrowser({ onRefresh });
    contextMenuClick("readme.md");
    const menuCopy = screen.getAllByText("Copy").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuCopy!);
    const input = screen.getByPlaceholderText("Destination path");
    fireEvent.change(input, { target: { value: "backup/readme.md" } });
    const dialogCopy = screen.getAllByText("Copy").find(
      (el) => el.closest("button")?.classList.contains("btn-primary")
    );
    fireEvent.click(dialogCopy!.closest("button")!);
    await waitFor(() => {
      expect(mockCopyFile).toHaveBeenCalledWith("test-ws", "readme.md", "backup/readme.md", "project-1");
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  // ── Move Dialog ─────────────────────────────────────────────────────

  it("shows move dialog with destination input", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    const menuMove = screen.getAllByText("Move").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuMove!);
    expect(screen.getByPlaceholderText("Destination path")).toBeDefined();
  });

  it("calls moveFile API and refreshes on move confirm", async () => {
    mockMoveFile.mockResolvedValue({ success: true });
    const onRefresh = vi.fn();
    renderFileBrowser({ onRefresh });
    contextMenuClick("readme.md");
    const menuMove = screen.getAllByText("Move").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuMove!);
    const input = screen.getByPlaceholderText("Destination path");
    fireEvent.change(input, { target: { value: "docs/readme.md" } });
    const dialogMove = screen.getAllByText("Move").find(
      (el) => el.closest("button")?.classList.contains("btn-primary")
    );
    fireEvent.click(dialogMove!.closest("button")!);
    await waitFor(() => {
      expect(mockMoveFile).toHaveBeenCalledWith("test-ws", "readme.md", "docs/readme.md", "project-1");
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  // ── Error Handling ──────────────────────────────────────────────────

  it("shows error in dialog when API call fails", async () => {
    mockRenameFile.mockRejectedValue(new Error("Something went wrong"));
    renderFileBrowser();
    contextMenuClick("readme.md");
    const menuRename = screen.getAllByText("Rename").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuRename!);
    const input = screen.getByPlaceholderText("New name");
    fireEvent.change(input, { target: { value: "new-name.md" } });
    const dialogRename = screen.getAllByText("Rename").find(
      (el) => el.closest("button")?.classList.contains("btn-primary")
    );
    fireEvent.click(dialogRename!.closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeDefined();
    });
  });

  it("closes dialog on Escape from dialog", () => {
    renderFileBrowser();
    contextMenuClick("readme.md");
    const menuRename = screen.getAllByText("Rename").find(
      (el) => el.closest('[role="menuitem"]')
    );
    fireEvent.click(menuRename!);
    expect(screen.getByPlaceholderText("New name")).toBeDefined();
    fireEvent.keyDown(screen.getByPlaceholderText("New name"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("New name")).toBeNull();
  });
});
