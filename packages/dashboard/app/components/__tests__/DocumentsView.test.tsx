import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import { DocumentsView } from "../DocumentsView";
import { fetchTaskDetail, fetchWorkspaceFileContent } from "../../api";
import { useDocuments } from "../../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../../hooks/useProjectMarkdownFiles";

vi.mock("../../api", () => ({
  fetchProjectMarkdownFiles: vi.fn(),
  fetchAllDocuments: vi.fn(),
  fetchWorkspaceFileContent: vi.fn(),
  fetchTaskDetail: vi.fn(),
}));

vi.mock("../../hooks/useDocuments", () => ({
  useDocuments: vi.fn(),
}));

vi.mock("../../hooks/useProjectMarkdownFiles", () => ({
  useProjectMarkdownFiles: vi.fn(),
}));

const mockUseDocuments = vi.mocked(useDocuments);
const mockUseProjectMarkdownFiles = vi.mocked(useProjectMarkdownFiles);
const mockFetchWorkspaceFileContent = vi.mocked(fetchWorkspaceFileContent);
const mockFetchTaskDetail = vi.mocked(fetchTaskDetail);

const mockTaskDocuments: TaskDocumentWithTask[] = [
  {
    id: "doc-1",
    taskId: "KB-001",
    key: "plan",
    content: "Alpha document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    taskTitle: "Alpha task",
    taskColumn: "in-progress",
  },
  {
    id: "doc-2",
    taskId: "KB-002",
    key: "notes",
    content: "Beta document content",
    revision: 2,
    author: "agent",
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
    taskTitle: "Beta task",
    taskColumn: "todo",
  },
];

const mockProjectFiles = [
  {
    path: "README.md",
    name: "README.md",
    size: 1024,
    mtime: "2026-04-19T12:00:00.000Z",
  },
  {
    path: "docs/guide.md",
    name: "guide.md",
    size: 2048,
    mtime: "2026-04-19T11:00:00.000Z",
  },
];

function setupHookDefaults(): void {
  mockUseDocuments.mockReturnValue({
    documents: mockTaskDocuments,
    projectFiles: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });

  mockUseProjectMarkdownFiles.mockReturnValue({
    files: mockProjectFiles,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

describe("DocumentsView", () => {
  const addToast = vi.fn();
  const onOpenDetail = vi.fn();
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.clearAllMocks();
    window.innerWidth = 1200;
    setupHookDefaults();
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "# README\nHello docs",
      mtime: "2026-04-19T12:00:00.000Z",
      size: 18,
    });
    mockFetchTaskDetail.mockResolvedValue({ id: "KB-001" } as TaskDetail);
  });

  afterEach(() => {
    window.innerWidth = originalInnerWidth;
  });

  it("renders project files tab with markdown file list", () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    expect(screen.getByRole("tab", { name: /show project markdown files/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open docs/guide.md" })).toBeInTheDocument();
  });

  it("renders task documents tab when there are no project files", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    });

    expect(screen.getByText("KB-001")).toBeInTheDocument();
    expect(screen.getByText("KB-002")).toBeInTheDocument();
  });

  it("tab switching works", () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("KB-001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open README.md" })).not.toBeInTheDocument();
  });

  it("clicking project file shows content", async () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", undefined);
    });

    expect(await screen.findByText(/Hello docs/)).toBeInTheDocument();
  });

  it("search filters task documents", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    mockUseDocuments.mockImplementation((options) => {
      const query = options?.searchQuery?.toLowerCase();
      const documents = query
        ? mockTaskDocuments.filter((doc) =>
          doc.taskTitle?.toLowerCase().includes(query) ||
          doc.taskId.toLowerCase().includes(query))
        : mockTaskDocuments;

      return {
        documents,
        projectFiles: [],
        loading: false,
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
      };
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    });

    fireEvent.change(screen.getByRole("textbox", { name: /search task documents/i }), {
      target: { value: "alpha" },
    });

    await waitFor(() => {
      expect(screen.getByText("KB-001")).toBeInTheDocument();
      expect(screen.queryByText("KB-002")).not.toBeInTheDocument();
    });
  });

  it("shows empty and error states", async () => {
    const projectRefresh = vi.fn().mockResolvedValue(undefined);

    mockUseDocuments.mockReturnValue({
      documents: [],
      projectFiles: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: "boom",
      refresh: projectRefresh,
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    expect(screen.getByText(/failed to load project files/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry loading documents/i }));

    await waitFor(() => {
      expect(projectRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("shows loading states", async () => {
    mockUseDocuments.mockReturnValue({
      documents: [],
      projectFiles: [],
      loading: true,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: true,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    expect(screen.getByText("Loading project markdown files…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByText("Loading task documents…")).toBeInTheDocument();
  });

  it("supports mobile list/detail navigation for project files", async () => {
    window.innerWidth = 600;

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    expect(await screen.findByRole("button", { name: /back to project files list/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open README.md" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to project files list/i }));

    expect(screen.getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
  });

  it("opens task details from task document groups", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    });

    fireEvent.click(screen.getByRole("button", { name: /open task KB-001/i }));

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("KB-001", undefined);
      expect(onOpenDetail).toHaveBeenCalledWith({ id: "KB-001" });
    });
  });

  it("shows file content error when loading fails", async () => {
    mockFetchWorkspaceFileContent.mockRejectedValue(new Error("cannot read file"));

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    expect(await screen.findByText("cannot read file")).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith("cannot read file", "error");
  });

  it("project file preview defaults to raw text mode", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "# Hello\n\nThis is **bold**",
      mtime: "2026-04-19T12:00:00.000Z",
      size: 28,
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalled();
    });

    // Should show raw text by default
    expect(screen.getByText(/# Hello/)).toBeInTheDocument();
    expect(screen.getByText(/\*\*bold\*\*/)).toBeInTheDocument();
  });

  it("project file preview can toggle to markdown mode", async () => {
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "# Hello\n\nThis is **bold**",
      mtime: "2026-04-19T12:00:00.000Z",
      size: 28,
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalled();
    });

    // Toggle button should exist with raw mode
    const toggleBtn = screen.getByRole("button", { name: /switch to markdown/i });
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

    // Click to toggle
    fireEvent.click(toggleBtn);

    // Should now be in markdown mode
    expect(screen.getByRole("button", { name: /switch to plain text/i })).toHaveAttribute("aria-pressed", "true");
    // Bold text should be rendered as <strong>
    const strongEl = await screen.findByText("bold");
    expect(strongEl.tagName).toBe("STRONG");
  });

  it("project file markdown toggle state is independent from task document toggles", async () => {
    // Set up project files with markdown content
    mockFetchWorkspaceFileContent.mockResolvedValue({
      content: "# Project README",
      mtime: "2026-04-19T12:00:00.000Z",
      size: 18,
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    // Toggle project file to markdown mode
    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalled();
    });

    const projectToggle = screen.getByRole("button", { name: /switch to markdown/i });
    fireEvent.click(projectToggle);

    // Switch to tasks tab
    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    await waitFor(() => {
      expect(screen.getByText("KB-001")).toBeInTheDocument();
    });

    // Expand a task group
    fireEvent.click(screen.getByRole("button", { name: /expand documents for task KB-001/i }));

    // Expand the document card
    const expandBtn = screen.getByRole("button", { name: /expand content/i });
    fireEvent.click(expandBtn);

    // Task document toggle should default to raw (not influenced by project toggle)
    const taskToggle = screen.getByRole("button", { name: /switch to markdown/i });
    expect(taskToggle).toHaveAttribute("aria-pressed", "false");

    // Toggle task document
    fireEvent.click(taskToggle);
    expect(screen.getByRole("button", { name: /switch to plain text/i })).toHaveAttribute("aria-pressed", "true");

    // Switch back to project - project toggle should still be on
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));
    expect(screen.getByRole("button", { name: /switch to plain text/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("task document cards support markdown toggle when expanded", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    });

    // Expand task group
    fireEvent.click(screen.getByRole("button", { name: /expand documents for task KB-001/i }));

    // Expand the document card
    const expandBtn = screen.getByRole("button", { name: /expand content/i });
    fireEvent.click(expandBtn);

    // Should show raw text by default
    expect(screen.getByText("Alpha document content")).toBeInTheDocument();

    // Toggle should exist
    const toggleBtn = screen.getByRole("button", { name: /switch to markdown/i });
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

    // Click to toggle to markdown mode
    fireEvent.click(toggleBtn);
    expect(screen.getByRole("button", { name: /switch to plain text/i })).toHaveAttribute("aria-pressed", "true");
  });
});
