import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TaskDocument } from "@fusion/core";
import { TaskDocumentsTab } from "../TaskDocumentsTab";
import { fetchTaskDocuments, fetchTaskDocumentRevisions } from "../../api";

vi.mock("../../api", () => ({
  fetchTaskDocuments: vi.fn(),
  fetchTaskDocument: vi.fn(),
  fetchTaskDocumentRevisions: vi.fn(),
  putTaskDocument: vi.fn(),
  deleteTaskDocument: vi.fn(),
}));

const mockFetchTaskDocuments = vi.mocked(fetchTaskDocuments);
const mockFetchTaskDocumentRevisions = vi.mocked(fetchTaskDocumentRevisions);

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
  });

  it("renders document list", async () => {
    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("plan")).toBeInTheDocument();
    });

    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("shows empty state when no documents", async () => {
    mockFetchTaskDocuments.mockResolvedValue([]);

    render(<TaskDocumentsTab taskId="KB-001" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("No documents yet.")).toBeInTheDocument();
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
