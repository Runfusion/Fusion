import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ArtifactWithTask, TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import { DocumentsView } from "../DocumentsView";
import { fetchTaskDetail, fetchWorkspaceFileContent } from "../../api";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useDocuments } from "../../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../../hooks/useProjectMarkdownFiles";

vi.mock("../../api", () => ({
  fetchProjectMarkdownFiles: vi.fn(),
  fetchAllDocuments: vi.fn(),
  fetchWorkspaceFileContent: vi.fn(),
  fetchTaskDetail: vi.fn(),
  fetchArtifacts: vi.fn(),
  artifactMediaUrl: vi.fn((id: string) => `/api/artifacts/${id}/media`),
}));

vi.mock("../../hooks/useDocuments", () => ({
  useDocuments: vi.fn(),
}));

vi.mock("../../hooks/useArtifacts", () => ({
  useArtifacts: vi.fn(),
}));

vi.mock("../../hooks/useProjectMarkdownFiles", () => ({
  useProjectMarkdownFiles: vi.fn(),
}));

const mockUseDocuments = vi.mocked(useDocuments);
const mockUseArtifacts = vi.mocked(useArtifacts);
const mockUseProjectMarkdownFiles = vi.mocked(useProjectMarkdownFiles);
const mockFetchWorkspaceFileContent = vi.mocked(fetchWorkspaceFileContent);
const mockFetchTaskDetail = vi.mocked(fetchTaskDetail);

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

const mockHiddenProjectFile = {
  path: ".hidden/notes.md",
  name: "notes.md",
  size: 512,
  mtime: "2026-04-19T10:00:00.000Z",
};

const mockArtifacts: ArtifactWithTask[] = [
  {
    id: "artifact-image",
    type: "image",
    title: "Image artifact",
    description: "Rendered image",
    mimeType: "image/png",
    sizeBytes: 128,
    uri: "artifacts/image.png",
    authorId: "agent-image",
    authorType: "agent",
    taskId: "KB-001",
    taskTitle: "Alpha task",
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
  },
  {
    id: "artifact-video",
    type: "video",
    title: "Video artifact",
    mimeType: "video/mp4",
    uri: "artifacts/video.mp4",
    authorId: "agent-video",
    authorType: "agent",
    createdAt: "2026-04-19T11:00:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
  },
  {
    id: "artifact-audio",
    type: "audio",
    title: "Audio artifact",
    mimeType: "audio/mpeg",
    uri: "artifacts/audio.mp3",
    authorId: "agent-audio",
    authorType: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
  },
  {
    id: "artifact-document",
    type: "document",
    title: "Document artifact",
    content: "Inline document preview",
    mimeType: "text/markdown",
    authorId: "agent-doc",
    authorType: "agent",
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T09:00:00.000Z",
  },
  {
    id: "artifact-other",
    type: "other",
    title: "Other artifact",
    description: "Generic binary",
    mimeType: "application/octet-stream",
    uri: "artifacts/data.bin",
    authorId: "agent-other",
    authorType: "agent",
    createdAt: "2026-04-19T08:00:00.000Z",
    updatedAt: "2026-04-19T08:00:00.000Z",
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

  mockUseArtifacts.mockReturnValue({
    artifacts: [],
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

    expect(screen.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /show project markdown files/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open docs/guide.md" })).toBeInTheDocument();
  });

  it("keeps hidden project files off by default and reveals them when toggled on", async () => {
    const refreshMock = vi.fn().mockResolvedValue(undefined);

    mockUseProjectMarkdownFiles.mockImplementation((_, options) => ({
      files: options?.showHidden
        ? [...mockProjectFiles, mockHiddenProjectFile]
        : mockProjectFiles,
      loading: false,
      error: null,
      refresh: refreshMock,
    }));

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    expect(screen.queryByRole("button", { name: "Open .hidden/notes.md" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show hidden project files/i })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: /show hidden project files/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open .hidden/notes.md" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /hide hidden project files/i })).toHaveAttribute("aria-pressed", "true");
    });
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

  it("renders artifacts tab counts and all media card paths without non-media expand shells", async () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    const artifactsTab = screen.getByRole("tab", { name: /show artifacts/i });
    expect(artifactsTab).toHaveTextContent("5");
    expect(screen.getByRole("tab", { name: /show project markdown files/i })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveTextContent("2");

    fireEvent.click(artifactsTab);

    expect(screen.getByRole("tab", { name: /show artifacts/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("img", { name: "Image artifact" })).toHaveAttribute("src", "/api/artifacts/artifact-image/media");
    expect(screen.getByRole("button", { name: "Expand Image artifact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Video artifact" })).toBeInTheDocument();
    expect(screen.getByLabelText("Video artifact: Video artifact").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("Audio artifact: Audio artifact").tagName).toBe("AUDIO");
    expect(screen.getByTestId("artifact-document-preview")).toHaveTextContent("Inline document preview");
    expect(screen.getByTestId("artifact-other-link")).toHaveAttribute("href", "/api/artifacts/artifact-other/media");
    expect(screen.getByText("agent-image")).toBeInTheDocument();
    expect(screen.getByText("Image")).toBeInTheDocument();

    for (const title of ["Audio artifact", "Document artifact", "Other artifact"]) {
      const card = screen.getByRole("article", { name: `Artifact ${title}` });
      expect(within(card).queryByRole("button", { name: `Expand ${title}` })).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: /open task KB-001/i }));
    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("KB-001", undefined);
      expect(onOpenDetail).toHaveBeenCalledWith({ id: "KB-001" });
    });
    expect(screen.getAllByRole("button", { name: /open task/i })).toHaveLength(1);
  });

  it("opens and dismisses the image and video artifact lightbox by click keyboard close backdrop and escape", () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    const { container } = render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));

    fireEvent.click(screen.getByRole("button", { name: "Expand Image artifact" }));
    let dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByRole("img", { name: "Image artifact" })).toHaveAttribute("src", "/api/artifacts/artifact-image/media");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close artifact preview" }));
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Expand Image artifact" }), { key: "Enter" });
    dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByRole("img", { name: "Image artifact" })).toBeInTheDocument();
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Expand Video artifact" }), { key: " " });
    dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByLabelText("Video artifact: Video artifact").tagName).toBe("VIDEO");
    expect(container.querySelector(".documents-artifact-lightbox-media-frame video")).toHaveAttribute("controls");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("renders artifacts empty loading error retry and mobile gallery states", async () => {
    const artifactRefresh = vi.fn().mockResolvedValue(undefined);
    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: false,
      error: null,
      refresh: artifactRefresh,
    });

    const { rerender, container } = render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));
    expect(screen.getByText("No artifacts yet.")).toBeInTheDocument();

    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: true,
      error: null,
      refresh: artifactRefresh,
    });
    rerender(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));
    expect(screen.getByText("Loading artifacts…")).toBeInTheDocument();

    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: false,
      error: "artifact boom",
      refresh: artifactRefresh,
    });
    rerender(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));
    expect(screen.getByText(/failed to load artifacts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry loading documents/i }));
    await waitFor(() => expect(artifactRefresh).toHaveBeenCalledTimes(1));

    window.innerWidth = 600;
    window.dispatchEvent(new Event("resize"));
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: artifactRefresh,
    });
    rerender(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));
    expect(container.querySelector(".documents-artifact-gallery--mobile")).toBeInTheDocument();
  });

  it("clicking project file shows content", async () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", undefined);
    });

    expect(await screen.findByText(/Hello docs/)).toBeInTheDocument();
  });

  it("sends selected plain project file preview text to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    const plainPreview = await screen.findByText(/Hello docs/);
    selectNodeText(plainPreview);

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Create a docs task." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: README.md"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Hello docs"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Create a docs task."));
  });

  it("sends selected markdown project file preview text to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    await screen.findByText(/Hello docs/);
    fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));
    const markdownPreviewText = await screen.findByText("Hello docs");
    selectNodeText(markdownPreviewText);

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Review this rendered content." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: README.md"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Hello docs"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Review this rendered content."));
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
