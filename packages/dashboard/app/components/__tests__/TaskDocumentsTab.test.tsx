import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ArtifactWithTask, TaskDocument } from "@fusion/core";
import { TaskDocumentsTab } from "../TaskDocumentsTab";
import { artifactMediaUrl, fetchTaskDocuments, fetchTaskDocumentRevisions } from "../../api";
import { useArtifacts } from "../../hooks/useArtifacts";

vi.mock("../../api", () => ({
  fetchTaskDocuments: vi.fn(),
  fetchTaskDocument: vi.fn(),
  fetchTaskDocumentRevisions: vi.fn(),
  putTaskDocument: vi.fn(),
  deleteTaskDocument: vi.fn(),
  artifactMediaUrl: vi.fn((id: string) => `/api/artifacts/${id}/media`),
}));

vi.mock("../../hooks/useArtifacts", () => ({
  useArtifacts: vi.fn(),
}));

const mockFetchTaskDocuments = vi.mocked(fetchTaskDocuments);
const mockFetchTaskDocumentRevisions = vi.mocked(fetchTaskDocumentRevisions);
const mockArtifactMediaUrl = vi.mocked(artifactMediaUrl);
const mockUseArtifacts = vi.mocked(useArtifacts);

const mockArtifacts: ArtifactWithTask[] = [
  {
    id: "artifact-image",
    type: "image",
    title: "Image artifact",
    description: "Screenshot from the agent",
    authorId: "agent-image",
    taskId: "KB-001",
    createdAt: "2026-04-19T10:00:00.000Z",
    sizeBytes: 2048,
  },
  {
    id: "artifact-video",
    type: "video",
    title: "Video artifact",
    authorId: "agent-video",
    taskId: "KB-001",
    createdAt: "2026-04-19T10:01:00.000Z",
  },
  {
    id: "artifact-audio",
    type: "audio",
    title: "Audio artifact",
    authorId: "agent-audio",
    taskId: "KB-001",
    createdAt: "2026-04-19T10:02:00.000Z",
  },
  {
    id: "artifact-document",
    type: "document",
    title: "Document artifact",
    content: "Inline document preview",
    authorId: "agent-doc",
    taskId: "KB-001",
    createdAt: "2026-04-19T10:03:00.000Z",
  },
  {
    id: "artifact-other",
    type: "other",
    title: "Other artifact",
    authorId: "agent-other",
    taskId: "KB-001",
    createdAt: "2026-04-19T10:04:00.000Z",
  },
];

const mockDocuments: TaskDocument[] = [
  {
    id: "doc-1",
    taskId: "KB-001",
    key: "plan",
    content: "This is the **plan** content",
    revision: 1,
    author: "agent",
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
  },
  {
    id: "doc-2",
    taskId: "KB-001",
    key: "notes",
    content: "# Notes\n\n- Item 1\n- Item 2",
    revision: 2,
    author: "user",
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T11:00:00.000Z",
  },
];

describe("TaskDocumentsTab", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchTaskDocuments.mockResolvedValue(mockDocuments);
    mockFetchTaskDocumentRevisions.mockResolvedValue([]);
    mockArtifactMediaUrl.mockImplementation((id: string) => `/api/artifacts/${id}/media`);
    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("renders the renamed Artifacts heading with document list", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument();
      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Task documents" })).toBeInTheDocument();
  });

  it("shows loading until documents and artifacts resolve", () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: true,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    expect(screen.getByText("Loading documents and artifacts…")).toBeInTheDocument();
  });

  it("shows combined empty state when no documents or artifacts", async () => {
    mockFetchTaskDocuments.mockResolvedValue([]);

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("No documents or artifacts yet.")).toBeInTheDocument();
    });
    expect(screen.queryByText("No task documents yet.")).not.toBeInTheDocument();
  });

  it("renders documents-only state", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    expect(screen.queryByRole("heading", { name: "Media artifacts" })).not.toBeInTheDocument();
    expect(screen.getByText("2 documents")).toBeInTheDocument();
  });

  it("renders artifacts-only state", async () => {
    mockFetchTaskDocuments.mockResolvedValue([]);
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} projectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Media artifacts" })).toBeInTheDocument();
    });

    expect(screen.getByText("5 artifacts")).toBeInTheDocument();
    expect(screen.getByText("No task documents yet.")).toBeInTheDocument();
    expect(screen.queryByText("No documents or artifacts yet.")).not.toBeInTheDocument();
  });

  it("renders both documents and all five media artifact paths", async () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} projectId="project-1" />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Media artifacts" })).toBeInTheDocument();
    });

    expect(screen.getByRole("img", { name: "Image artifact" })).toHaveAttribute("src", "/api/artifacts/artifact-image/media");
    expect(screen.getByRole("button", { name: "Expand image artifact Image artifact" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expand image artifact Video artifact/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Video artifact: Video artifact").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("Audio artifact: Audio artifact").tagName).toBe("AUDIO");
    expect(screen.getByTestId("artifact-document-preview")).toHaveTextContent("Inline document preview");
    expect(screen.getByTestId("artifact-other-link")).toHaveAttribute("href", "/api/artifacts/artifact-other/media");
    expect(screen.getByText("agent-image")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(document.querySelector(".documents-artifact-gallery--mobile")).not.toBeNull();
    expect(mockUseArtifacts).toHaveBeenCalledWith({ projectId: "project-1", taskId: "KB-001" });
    expect(mockArtifactMediaUrl).toHaveBeenCalledWith("artifact-image", "project-1");
  });

  it("opens image artifacts in a task-detail lightbox and restores focus on close", async () => {
    mockFetchTaskDocuments.mockResolvedValue([]);
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} projectId="project-1" />);

    const expandButton = await screen.findByRole("button", { name: "Expand image artifact Image artifact" });
    expandButton.focus();
    fireEvent.click(expandButton);

    const dialog = screen.getByRole("dialog", { name: "Artifact media preview" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Image artifact" })[1]).toHaveAttribute("src", "/api/artifacts/artifact-image/media");

    fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();
    });
    expect(expandButton).toHaveFocus();
  });

  it("closes the image artifact lightbox with Escape", async () => {
    mockFetchTaskDocuments.mockResolvedValue([]);
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Expand image artifact Image artifact" }));
    expect(screen.getByRole("dialog", { name: "Artifact media preview" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Artifact media preview" })).not.toBeInTheDocument();
    });
  });

  it("traps keyboard focus inside the image artifact lightbox", async () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: mockArtifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Expand image artifact Image artifact" }));
    const closeButton = screen.getByRole("button", { name: "Close artifact preview" });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(closeButton).toHaveFocus();

    screen.getAllByRole("button", { name: "Expand" })[0].focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();
  });

  it("surfaces artifact fetch errors", async () => {
    mockUseArtifacts.mockReturnValue({
      artifacts: [],
      loading: false,
      error: "Artifact fetch failed",
      refresh: vi.fn().mockResolvedValue(undefined),
    });

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Artifact fetch failed", "error");
    });
  });

  it("expands document to show content", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText(/This is the \*\*plan\*\* content/)).toBeInTheDocument();
    });
  });

  it("collapses document when expand button clicked again", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText(/This is the \*\*plan\*\* content/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));

    // Content should be hidden
    expect(screen.queryByText(/This is the/)).not.toBeInTheDocument();
  });

  describe("markdown toggle", () => {
    it("defaults to raw text mode", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
      fireEvent.click(expandButton);

      await waitFor(() => {
        // Should show raw markdown syntax
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });
    });

    it("toggles to markdown render mode", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });

      // Find and click the markdown toggle
      const toggleBtn = screen.getByRole("button", { name: /switch to markdown/i });
      expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(toggleBtn);

      // Should now be in markdown mode
      expect(screen.getByRole("button", { name: /switch to plain text/i })).toHaveAttribute("aria-pressed", "true");
      // Bold text should be rendered as <strong> - use a data-testid to scope the query
      const container = document.querySelector(".task-document-content-markdown");
      expect(container).not.toBeNull();
      const strongEl = container!.querySelector("strong");
      expect(strongEl).not.toBeNull();
      expect(strongEl!.textContent).toBe("plan");
    });

    it("toggles back to raw text mode", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });

      // Toggle to markdown mode
      fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));

      await waitFor(() => {
        expect(document.querySelector(".task-document-content-markdown strong")).not.toBeNull();
      });

      // Toggle back to raw text
      fireEvent.click(screen.getByRole("button", { name: /switch to plain text/i }));

      // Should be back to raw text mode
      expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
    });

    it("resets markdown mode when switching documents", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      // Expand first document and enable markdown mode
      const expandButtons = screen.getAllByRole("button", { name: /expand/i });
      fireEvent.click(expandButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));

      await waitFor(() => {
        expect(document.querySelector(".task-document-content-markdown strong")).not.toBeNull();
      });

      // Collapse first document
      fireEvent.click(screen.getByRole("button", { name: /collapse/i }));

      // Expand second document
      fireEvent.click(expandButtons[1]);

      await waitFor(() => {
        // Should be in raw text mode by default
        expect(screen.getByText(/# Notes/)).toBeInTheDocument();
      });

      // Toggle button should be in raw text mode
      const toggleBtn = screen.getByRole("button", { name: /switch to markdown/i });
      expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
    });

    it("resets markdown mode when collapsing document", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      // Expand document and enable markdown mode
      const expandButton = screen.getAllByRole("button", { name: /expand/i })[0];
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));

      await waitFor(() => {
        expect(document.querySelector(".task-document-content-markdown strong")).not.toBeNull();
      });

      // Collapse document
      fireEvent.click(screen.getByRole("button", { name: /collapse/i }));

      // Re-expand document (first expand button after collapse)
      fireEvent.click(screen.getAllByRole("button", { name: /expand/i })[0]);

      await waitFor(() => {
        // Should be in raw text mode by default
        expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      });

      const toggleBtn = screen.getByRole("button", { name: /switch to markdown/i });
      expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
    });

    it("renders markdown list syntax", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(screen.getByText("notes")).toBeInTheDocument();
      });

      // Expand the notes document (second one)
      const expandButtons = screen.getAllByRole("button", { name: /expand/i });
      fireEvent.click(expandButtons[1]);

      await waitFor(() => {
        expect(screen.getByText(/# Notes/)).toBeInTheDocument();
      });

      // Toggle to markdown mode
      fireEvent.click(screen.getByRole("button", { name: /switch to markdown/i }));

      // Check heading is rendered
      const heading = await screen.findByRole("heading", { name: "Notes" });
      expect(heading).toBeInTheDocument();

      // Check list items are rendered
      expect(screen.getByText("Item 1")).toBeInTheDocument();
      expect(screen.getByText("Item 2")).toBeInTheDocument();
    });
  });
});
