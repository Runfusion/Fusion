import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserModal } from "./FileBrowserModal";
import * as workspaceBrowserHook from "../hooks/useWorkspaceFileBrowser";
import * as workspaceEditorHook from "../hooks/useWorkspaceFileEditor";
import * as workspacesHook from "../hooks/useWorkspaces";

vi.mock("../hooks/useWorkspaceFileBrowser");
vi.mock("../hooks/useWorkspaceFileEditor");
vi.mock("../hooks/useWorkspaces");

const mockUseWorkspaceFileBrowser = vi.mocked(workspaceBrowserHook.useWorkspaceFileBrowser);
const mockUseWorkspaceFileEditor = vi.mocked(workspaceEditorHook.useWorkspaceFileEditor);
const mockUseWorkspaces = vi.mocked(workspacesHook.useWorkspaces);

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
    expect(mockUseWorkspaceFileBrowser).toHaveBeenCalledWith("project", true);
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

    expect(mockUseWorkspaceFileEditor).toHaveBeenLastCalledWith("project", "file1.ts", true);
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
});
