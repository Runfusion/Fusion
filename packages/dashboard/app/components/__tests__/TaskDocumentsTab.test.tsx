/*
FNXC:DashboardTests 2026-07-11-00:00:
FN-7833 changed per-task Artifacts-tab document defaults. Keep multi-document coverage here so the component cannot regress to single-expanded or Plain-first rendering while the separate Documents view remains out of scope.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

function getDocumentCard(key: string): HTMLElement {
  const keyElement = screen.getAllByText(key).find((element) => element.classList.contains("task-document-key"));
  expect(keyElement).toBeDefined();
  return keyElement!.closest(".task-document-card") as HTMLElement;
}

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
    window.localStorage.clear();
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
      expect(screen.getAllByText("plan").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("plan").length).toBeGreaterThan(0);
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
      expect(screen.getAllByText("plan").length).toBeGreaterThan(0);
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

    screen.getAllByRole("button", { name: "Collapse" })[0].focus();
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

  it("renders every task document expanded as markdown by default", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    const planStrong = (await screen.findAllByText("plan")).find((element) => element.tagName === "STRONG");
    expect(planStrong).toBeDefined();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(document.querySelectorAll(".task-document-content-markdown .markdown-body")).toHaveLength(2);
    expect(document.querySelector("pre.task-document-content-text")).not.toBeInTheDocument();
  });

  it("collapses only the selected document while other documents stay expanded", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await screen.findByText("Item 1");
    const planCard = getDocumentCard("plan");

    fireEvent.click(within(planCard).getByRole("button", { name: /collapse/i }));

    await waitFor(() => {
      expect(screen.queryByText("This is the")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(within(planCard).getByRole("button", { name: /expand/i })).toBeInTheDocument();
  });

  describe("markdown toggle", () => {
    it("defaults to markdown render mode", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      await waitFor(() => {
        expect(document.querySelector(".task-document-content-markdown strong")?.textContent).toBe("plan");
      });
      expect(screen.getAllByRole("button", { name: /switch to plain text/i })[0]).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText(/\*\*plan\*\*/)).not.toBeInTheDocument();
    });

    it("toggles to raw text mode", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      const toggleBtn = (await screen.findAllByRole("button", { name: /switch to plain text/i }))[0];
      fireEvent.click(toggleBtn);

      await waitFor(() => {
        expect(document.querySelectorAll("pre.task-document-content-text")).toHaveLength(2);
      });
      expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument();
      expect(screen.getByText(/# Notes/)).toBeInTheDocument();
      expect(document.querySelector(".task-document-content-markdown")).not.toBeInTheDocument();
    });

    it("persists raw text preference across collapse and re-expand", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      fireEvent.click((await screen.findAllByRole("button", { name: /switch to plain text/i }))[0]);
      await waitFor(() => expect(screen.getByText(/\*\*plan\*\*/)).toBeInTheDocument());

      const planCard = getDocumentCard("plan");
      fireEvent.click(within(planCard).getByRole("button", { name: /collapse/i }));
      fireEvent.click(within(planCard).getByRole("button", { name: /expand/i }));

      expect(await screen.findByText(/\*\*plan\*\*/)).toBeInTheDocument();
      expect(within(planCard).getByRole("button", { name: /switch to markdown/i })).toHaveAttribute("aria-pressed", "false");
    });

    it("renders markdown list syntax without an extra toggle click", async () => {
      render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

      const heading = await screen.findByRole("heading", { name: "Notes" });
      expect(heading).toBeInTheDocument();
      expect(screen.getByText("Item 1")).toBeInTheDocument();
      expect(screen.getByText("Item 2")).toBeInTheDocument();
    });
  });
});
