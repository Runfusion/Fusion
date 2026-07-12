import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ArtifactWithTask, TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import { DocumentsView } from "../DocumentsView";
import { fetchArtifact, fetchTaskDetail, fetchWorkspaceFileContent, updateArtifact } from "../../api";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useDocuments } from "../../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../../hooks/useProjectMarkdownFiles";

vi.mock("../../api", () => ({
  fetchProjectMarkdownFiles: vi.fn(),
  fetchAllDocuments: vi.fn(),
  fetchWorkspaceFileContent: vi.fn(),
  fetchTaskDetail: vi.fn(),
  fetchArtifacts: vi.fn(),
  fetchArtifact: vi.fn(),
  updateArtifact: vi.fn(),
  artifactMediaUrl: vi.fn((id: string) => `/api/artifacts/${id}/media`),
}));

/*
FNXC:ArtifactsGallery 2026-07-10-16:30:
The artifact doc editor embeds the shared CodeMirror FileEditor, which cannot run meaningfully in jsdom; a textarea shim preserves the content/onChange contract under test.
*/
vi.mock("../FileEditor", () => ({
  FileEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="file editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
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
const mockFetchArtifact = vi.mocked(fetchArtifact);
const mockUpdateArtifact = vi.mocked(updateArtifact);

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

const mockStatusTaskDocuments: TaskDocumentWithTask[] = [
  {
    id: "doc-status-done",
    taskId: "KB-DONE",
    key: "plan",
    content: "Done document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T16:00:00.000Z",
    taskTitle: "Done task",
    taskColumn: "done",
  },
  {
    id: "doc-status-todo",
    taskId: "KB-TODO",
    key: "notes",
    content: "Todo document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T15:00:00.000Z",
    taskTitle: "Todo task",
    taskColumn: "todo",
  },
  {
    id: "doc-status-archived",
    taskId: "KB-ARCHIVED",
    key: "summary",
    content: "Archived document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T14:00:00.000Z",
    taskTitle: "Archived task",
    taskColumn: "archived",
  },
  {
    id: "doc-status-custom",
    taskId: "KB-CUSTOM",
    key: "handoff",
    content: "Custom column document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T13:00:00.000Z",
    taskTitle: "Custom task",
    taskColumn: "qa-ready",
  },
  {
    id: "doc-status-missing",
    taskId: "KB-MISSING",
    key: "legacy",
    content: "Legacy document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    taskTitle: "Legacy task",
  },
  {
    id: "doc-status-done-duplicate",
    taskId: "KB-DONE",
    key: "notes",
    content: "Second done document content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
    taskTitle: "Done task",
    taskColumn: "done",
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
    document.getSelection()?.removeAllRanges();
  });

  /*
  FNXC:ArtifactsView 2026-07-11-11:30:
  The view lands on the Artifacts tab (Artifacts-first ordering); Project Files is an explicit click away.
  */
  it("lands on the artifacts tab and shows project files after switching tabs", () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    expect(screen.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /show artifacts/i })).toHaveAttribute("aria-selected", "true");
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAccessibleName(/show artifacts/i);

    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));
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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

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

  it("renders task documents desktop sidebar and empty right pane", () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByLabelText("Task documents")).toBeInTheDocument();
    expect(screen.getByLabelText("Task document content preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open KB-001 plan" })).toBeInTheDocument();
    expect(screen.getByText("Select a task document to view its content.")).toBeInTheDocument();
    expect(screen.queryByText("Alpha document content")).not.toBeInTheDocument();
  });

  it("selecting a task document loads content and marks the sidebar entry current", () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    const planEntry = screen.getByRole("button", { name: "Open KB-001 plan" });
    fireEvent.click(planEntry);

    expect(screen.getByText("Alpha document content")).toBeInTheDocument();
    expect(planEntry).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("KB-001 / plan")).toBeInTheDocument();
  });

  it("keeps project file and task document selections isolated across tab switches", async () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    expect(await screen.findByText(/Hello docs/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByText("Select a task document to view its content.")).toBeInTheDocument();
    expect(screen.queryByText(/Hello docs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    expect(screen.getByText("Alpha document content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));
    expect(screen.getByText(/Hello docs/)).toBeInTheDocument();
    expect(screen.queryByText("Alpha document content")).not.toBeInTheDocument();
  });

  it("renders task document sidebar status badges for done non-done archived custom and legacy documents", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockUseDocuments.mockReturnValue({
      documents: mockStatusTaskDocuments,
      projectFiles: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

    const doneGroup = screen.getByRole("heading", { name: /KB-DONE.*Done task/i }).closest(".documents-task-sidebar-group");
    const todoGroup = screen.getByRole("heading", { name: /KB-TODO.*Todo task/i }).closest(".documents-task-sidebar-group");
    const archivedGroup = screen.getByRole("heading", { name: /KB-ARCHIVED.*Archived task/i }).closest(".documents-task-sidebar-group");
    const customGroup = screen.getByRole("heading", { name: /KB-CUSTOM.*Custom task/i }).closest(".documents-task-sidebar-group");
    const missingGroup = screen.getByRole("heading", { name: /KB-MISSING.*Legacy task/i }).closest(".documents-task-sidebar-group");

    expect(doneGroup).not.toBeNull();
    expect(todoGroup).not.toBeNull();
    expect(archivedGroup).not.toBeNull();
    expect(customGroup).not.toBeNull();
    expect(missingGroup).not.toBeNull();

    expect(within(doneGroup as HTMLElement).getByLabelText("Task status: Done")).toHaveTextContent("Done");
    expect(within(doneGroup as HTMLElement).getByText("2 docs")).toBeInTheDocument();
    expect(within(doneGroup as HTMLElement).getByLabelText("Task status: Done").querySelector(".status-dot--online")).toBeInTheDocument();
    expect(within(todoGroup as HTMLElement).getByLabelText("Task status: Todo")).toHaveTextContent("Todo");
    expect(within(archivedGroup as HTMLElement).getByLabelText("Task status: Archived")).toHaveTextContent("Archived");
    expect(within(customGroup as HTMLElement).getByLabelText("Task status: qa-ready")).toHaveTextContent("qa-ready");
    expect((missingGroup as HTMLElement).querySelector(".documents-group-status")).not.toBeInTheDocument();
    expect(screen.queryByText("Done document content")).not.toBeInTheDocument();
  });

  it("keeps task document status badges as non-interactive sidebar metadata on mobile", async () => {
    window.innerWidth = 600;
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockUseDocuments.mockReturnValue({
      documents: mockStatusTaskDocuments,
      projectFiles: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

    const doneGroup = screen.getByRole("heading", { name: /KB-DONE.*Done task/i }).closest(".documents-task-sidebar-group") as HTMLElement;
    const status = within(doneGroup).getByLabelText("Task status: Done");

    expect(status).toHaveClass("documents-group-status");
    expect(status.closest(".documents-task-sidebar-group-header")).toBeInTheDocument();
    expect(status.closest("button")).toBeNull();
    expect(within(doneGroup).getByRole("button", { name: /open task KB-DONE/i })).toBeInTheDocument();
  });

  it("renders artifacts tab counts and all media card paths without non-media expand shells", async () => {
    const onOpenArtifactTaskDetail = vi.fn();
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <DocumentsView
        addToast={addToast}
        onOpenDetail={onOpenDetail}
        onOpenArtifactTaskDetail={onOpenArtifactTaskDetail}
      />
    );

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
    expect(screen.getByTestId("artifact-other-link")).toHaveAttribute("href", "/api/artifacts/artifact-other/media");

    // Category chips render for every present category with counts (All = total).
    const filter = screen.getByRole("group", { name: /filter artifacts by category/i });
    expect(within(filter).getByRole("button", { name: /all\s*5/i })).toBeInTheDocument();
    for (const chip of ["Images", "Docs", "Videos", "Audio", "Other"]) {
      expect(within(filter).getByRole("button", { name: new RegExp(`${chip}\\s*1`, "i") })).toBeInTheDocument();
    }

    for (const title of ["Audio artifact", "Document artifact", "Other artifact"]) {
      const card = screen.getByRole("article", { name: `Artifact ${title}` });
      expect(within(card).queryByRole("button", { name: `Expand ${title}` })).not.toBeInTheDocument();
    }

    // A category chip filters the gallery down to that category.
    fireEvent.click(within(filter).getByRole("button", { name: /docs\s*1/i }));
    expect(screen.queryByRole("img", { name: "Image artifact" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Artifact Document artifact" })).toBeInTheDocument();
    fireEvent.click(within(filter).getByRole("button", { name: /all\s*5/i }));

    // Opening the image lightbox exposes its task link, which opens through the artifact task path.
    fireEvent.click(screen.getByRole("button", { name: "Expand Image artifact" }));
    const dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    fireEvent.click(within(dialog).getByRole("button", { name: /open task/i }));
    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("KB-001", undefined);
      expect(onOpenArtifactTaskDetail).toHaveBeenCalledWith({ id: "KB-001" });
    });
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("opens image and video viewers in a draggable resizable floating window dismissed by close button and escape", () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    /*
    FNXC:ArtifactsGallery 2026-07-11-11:30:
    Viewers host in the shared FloatingWindow: draggable (drag/resize handle testids) and resizable,
    closed by the close button or Escape. The floating overlay is intentionally click-through
    (non-blocking windows), so backdrop-click dismissal and body scroll locking are gone by design.
    The FloatingWindow portals to document.body, so media queries use document, not the container.
    */
    fireEvent.click(screen.getByRole("button", { name: "Expand Image artifact" }));
    let dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByRole("img", { name: "Image artifact" })).toHaveAttribute("src", "/api/artifacts/artifact-image/media");
    expect(screen.getByTestId("floating-window-artifact-media-artifact-image")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close artifact preview" }));
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Expand Image artifact" }), { key: "Enter" });
    dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByRole("img", { name: "Image artifact" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Expand Video artifact" }), { key: " " });
    dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(within(dialog).getByLabelText("Video artifact: Video artifact").tagName).toBe("VIDEO");
    expect(document.querySelector(".artifacts-gallery-viewer-media-frame video")).toHaveAttribute("controls");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();
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
    expect(container.querySelector(".artifacts-gallery-grid--mobile")).toBeInTheDocument();
  });

  /*
  FNXC:ArtifactsGallery 2026-07-10-15:40:
  Any inline-content doc artifact must open a full document viewer with an edit mode that persists through PATCH /artifacts/:id. Binary-backed docs must not offer Edit.
  */
  it("opens the doc viewer, jumps into edit mode, and saves content edits", async () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    const docDetail = mockArtifacts.find((artifact) => artifact.id === "artifact-document")!;
    mockFetchArtifact.mockResolvedValue(docDetail);
    mockUpdateArtifact.mockResolvedValue({ ...docDetail, content: "Edited body" });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));

    const docCard = screen.getByRole("article", { name: "Artifact Document artifact" });
    fireEvent.click(within(docCard).getByRole("button", { name: "Open Document artifact" }));
    const dialog = await screen.findByRole("dialog", { name: "Document artifact viewer" });
    await waitFor(() => {
      expect(within(dialog).getByText("Inline document preview")).toBeInTheDocument();
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /edit document/i }));
    const editor = within(dialog).getByRole("textbox", { name: "file editor" });
    fireEvent.change(editor, { target: { value: "Edited body" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mockUpdateArtifact).toHaveBeenCalledWith("artifact-document", { content: "Edited body" }, undefined);
    });
    expect(addToast).toHaveBeenCalledWith("Artifact saved", "success");
  });

  /*
  FNXC:ArtifactsGallery 2026-07-11-10:20:
  HTML doc artifacts must open as LIVE sandboxed previews by default (agents deliver interactive mockups as text/html documents), with a Source toggle for the raw markup.
  */
  it("renders HTML doc artifacts as a sandboxed live preview with a source toggle", async () => {
    const htmlArtifact: ArtifactWithTask = {
      id: "artifact-html",
      type: "document",
      title: "Login mockup",
      mimeType: "text/html",
      content: "<h1>Login mock</h1>",
      authorId: "design-agent",
      authorType: "agent",
      createdAt: "2026-04-19T09:30:00.000Z",
      updatedAt: "2026-04-19T09:30:00.000Z",
    };
    mockUseArtifacts.mockReturnValue({
      artifacts: [...mockArtifacts, htmlArtifact],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockFetchArtifact.mockResolvedValue(htmlArtifact);

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));

    const htmlCard = screen.getByRole("article", { name: "Artifact Login mockup" });
    fireEvent.click(within(htmlCard).getByRole("button", { name: "Open Login mockup" }));
    const dialog = await screen.findByRole("dialog", { name: "Document artifact viewer" });

    // The FloatingWindow portals to document.body, so query the document rather than the render container.
    await waitFor(() => {
      const iframe = document.querySelector(".artifacts-gallery-viewer-html");
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      expect(iframe).toHaveAttribute("srcdoc", "<h1>Login mock</h1>");
    });

    // The toggle shows the CURRENT mode (matching the Markdown/Plain convention): "Preview" while previewing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(document.querySelector(".artifacts-gallery-viewer-html")).not.toBeInTheDocument();
    expect(within(dialog).getByText("<h1>Login mock</h1>")).toBeInTheDocument();
  });

  /*
  FNXC:ArtifactsGallery 2026-07-10-12:30:
  PDF artifacts (application/pdf documents) must open a dedicated embedded PDF viewer that
  points its iframe at the artifact media route, not the inline doc viewer.
  */
  it("renders PDF doc artifacts in the embedded PDF viewer iframe", async () => {
    const pdfArtifact: ArtifactWithTask = {
      id: "artifact-pdf",
      type: "document",
      title: "Spec export",
      mimeType: "application/pdf",
      uri: "artifacts/spec.pdf",
      authorId: "doc-agent",
      authorType: "agent",
      createdAt: "2026-04-19T09:45:00.000Z",
      updatedAt: "2026-04-19T09:45:00.000Z",
    };
    mockUseArtifacts.mockReturnValue({
      artifacts: [...mockArtifacts, pdfArtifact],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByRole("tab", { name: /show artifacts/i }));

    const pdfCard = screen.getByRole("article", { name: "Artifact Spec export" });
    fireEvent.click(within(pdfCard).getByRole("button", { name: "Open Spec export" }));
    await screen.findByRole("dialog", { name: "PDF artifact viewer" });

    // The FloatingWindow portals to document.body, so query the document rather than the render container.
    const iframe = document.querySelector(".artifacts-gallery-viewer-pdf");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "/api/artifacts/artifact-pdf/media");
    expect(iframe).toHaveAttribute("title", "Spec export");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "PDF artifact viewer" })).not.toBeInTheDocument();
  });

  it("clicking project file shows content", async () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", "README.md", undefined);
    });

    expect(await screen.findByText(/Hello docs/)).toBeInTheDocument();
  });

  /*
  FNXC:ArtifactsView 2026-07-10-16:20:
  First-run review: the preview pane did not communicate that it is view-only. The Read-only
  badge must render with the preview header in BOTH render modes (plain and markdown) — the
  header markup is shared between desktop and mobile layouts.
  */
  it("shows a Read-only badge in the project file preview header in plain and markdown modes", async () => {
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    await screen.findByText(/Hello docs/);
    expect(screen.getByText("Read-only")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));
    await screen.findByText("Hello docs");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("sends selected plain project file preview text to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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

  /*
  FNXC:DocumentsView 2026-07-10-23:46:
  FN-7812 adds select-to-comment parity to Task Documents, so tests must cover the same surface checklist as Project Files: plain and markdown render modes, desktop and mobile detail layouts, empty-pane gating, tab isolation, and task-document file context in the composed New Task description.
  */
  it("sends selected plain task document text to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    const plainPreview = screen.getByText("Alpha document content");
    selectNodeText(plainPreview);

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Follow up from the task doc." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: KB-001/plan"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Alpha document content"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Follow up from the task doc."));
  });

  it("sends selected markdown task document text to a new task description", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));
    const markdownPreviewText = await screen.findByText("Alpha document content");
    selectNodeText(markdownPreviewText);

    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Review rendered task doc." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: KB-001/plan"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Alpha document content"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Review rendered task doc."));
  });

  it("does not show the task document comment trigger in the empty right pane", () => {
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByText("Select a task document to view its content.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add a comment/i })).not.toBeInTheDocument();
  });

  it("keeps task document and project file selection comment popovers isolated", async () => {
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    selectNodeText(screen.getByText("Alpha document content"));
    expect(await screen.findByRole("button", { name: /add a comment/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));
    expect(screen.queryByRole("button", { name: /add a comment/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    const projectPreview = await screen.findByText(/Hello docs/);
    selectNodeText(projectPreview);
    fireEvent.click(await screen.findByRole("button", { name: /add a comment/i }));
    fireEvent.change(screen.getByLabelText(/comment for the new task/i), { target: { value: "Project file still works." } });
    fireEvent.click(screen.getByRole("button", { name: /send to new task/i }));

    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("File: README.md"));
    expect(onSendSelectionToTask).toHaveBeenCalledWith(expect.stringContaining("Project file still works."));
    expect(onSendSelectionToTask).not.toHaveBeenCalledWith(expect.stringContaining("File: KB-001/plan"));
  });

  it("shows the task document comment trigger in the mobile detail pane", async () => {
    window.innerWidth = 600;
    mockSelectionRect();
    const onSendSelectionToTask = vi.fn();
    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} onSendSelectionToTask={onSendSelectionToTask} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    const mobilePreview = screen.getByText("Alpha document content");
    selectNodeText(mobilePreview);

    expect(await screen.findByRole("button", { name: /add a comment/i })).toBeInTheDocument();
  });

  it("search filters task documents and clears filtered-out selection", async () => {
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

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));
    expect(screen.getByText("Alpha document content")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /search task documents/i }), {
      target: { value: "beta" },
    });

    await waitFor(() => {
      expect(screen.getByText("KB-002")).toBeInTheDocument();
      expect(screen.queryByText("KB-001")).not.toBeInTheDocument();
      expect(screen.queryByText("Alpha document content")).not.toBeInTheDocument();
      expect(screen.getByText("Select a task document to view its content.")).toBeInTheDocument();
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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

    expect(screen.getByText("Loading project markdown files…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));

    expect(screen.getByText("Loading task documents…")).toBeInTheDocument();
  });

  it("supports mobile list/detail navigation for project files", async () => {
    window.innerWidth = 600;

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));

    expect(await screen.findByRole("button", { name: /back to project files list/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open README.md" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to project files list/i }));

    expect(screen.getByRole("button", { name: "Open README.md" })).toBeInTheDocument();
  });

  it("supports mobile list/detail navigation for task documents", async () => {
    window.innerWidth = 600;
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));

    expect(screen.getByRole("button", { name: /back to task documents list/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open KB-001 plan" })).not.toBeInTheDocument();
    expect(screen.getByText("Alpha document content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to task documents list/i }));

    expect(screen.getByRole("button", { name: "Open KB-001 plan" })).toBeInTheDocument();
    expect(screen.queryByText("Alpha document content")).not.toBeInTheDocument();
  });

  it("opens task details from task document groups", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: /open task KB-001/i }));

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("KB-001", undefined);
      expect(onOpenDetail).toHaveBeenCalledWith({ id: "KB-001" });
    });
  });

  it("shows file content error when loading fails", async () => {
    mockFetchWorkspaceFileContent.mockRejectedValue(new Error("cannot read file"));

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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
    // Landing tab is now Artifacts; these tests exercise the Project Files tab explicitly.
    fireEvent.click(screen.getByRole("tab", { name: /show project markdown files/i }));

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

    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));

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

  it("task document viewer supports markdown toggle", async () => {
    mockUseProjectMarkdownFiles.mockReturnValue({
      files: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<DocumentsView addToast={addToast} onOpenDetail={onOpenDetail} />);

    fireEvent.click(screen.getByRole("tab", { name: /show task documents/i }));
    expect(screen.getByRole("tab", { name: /show task documents/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Open KB-001 plan" }));

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
