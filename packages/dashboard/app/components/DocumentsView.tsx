import { useState, useMemo, useCallback } from "react";
import { FileText, ChevronDown, ChevronUp, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import type { TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchTaskDetail } from "../api";
import { useDocuments } from "../hooks/useDocuments";

export interface DocumentsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onOpenDetail: (task: TaskDetail) => void;
}

interface DocumentCardProps {
  document: TaskDocumentWithTask;
  onOpenTask: (taskId: string) => void;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function getContentPreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + "…";
}

function DocumentCard({ document, onOpenTask }: DocumentCardProps) {
  const [expanded, setExpanded] = useState(false);

  const preview = getContentPreview(document.content);
  const showExpand = document.content.length > 200;

  return (
    <div className="document-card">
      <div className="document-card-header">
        <div className="document-card-key">
          <FileText size={14} />
          <span className="document-card-key-text">{document.key}</span>
          <span className="document-card-revision-badge">v{document.revision}</span>
        </div>
        <button
          className="btn btn-sm document-card-expand-btn"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? "Collapse" : "Expand"}
          aria-label={expanded ? "Collapse content" : "Expand content"}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      <div className="document-card-meta">
        <span className="document-card-author">{document.author}</span>
        <span className="document-card-separator">·</span>
        <span className="document-card-date">{formatTimestamp(document.updatedAt)}</span>
      </div>

      <div className={`document-card-content${expanded ? " document-card-content--expanded" : ""}`}>
        {expanded ? (
          <pre className="document-card-content-text">{document.content}</pre>
        ) : (
          <p className="document-card-preview">{preview}</p>
        )}
        {showExpand && !expanded && (
          <p className="document-card-preview-truncated">…</p>
        )}
      </div>
    </div>
  );
}

interface TaskGroupProps {
  taskId: string;
  taskTitle?: string;
  documents: TaskDocumentWithTask[];
  onOpenTask: (taskId: string) => void;
}

function TaskGroup({ taskId, taskTitle, documents, onOpenTask }: TaskGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="documents-group">
      <button
        className="documents-group-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} documents for task ${taskId}`}
      >
        <span className="documents-group-toggle">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <button
          className="documents-group-task-link"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTask(taskId);
          }}
          aria-label={`Open task ${taskId}: ${taskTitle || "Untitled"}`}
        >
          <span className="documents-group-task-id">{taskId}</span>
          <span className="documents-group-task-title">{taskTitle || "Untitled"}</span>
        </button>
        <span className="documents-group-count">{documents.length} doc{documents.length !== 1 ? "s" : ""}</span>
      </button>

      {expanded && (
        <div className="documents-group-content">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentsView({ projectId, addToast, onOpenDetail }: DocumentsViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const { documents, loading, error, refresh } = useDocuments({
    projectId,
    searchQuery: searchQuery || undefined,
  });

  // Group documents by task
  const groupedDocuments = useMemo(() => {
    const groups = new Map<string, TaskDocumentWithTask[]>();
    for (const doc of documents) {
      const existing = groups.get(doc.taskId) || [];
      groups.set(doc.taskId, [...existing, doc]);
    }
    // Sort groups by the most recently updated document
    return Array.from(groups.entries())
      .map(([taskId, docs]) => ({
        taskId,
        taskTitle: docs[0].taskTitle,
        documents: docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        latestUpdated: docs[0].updatedAt,
      }))
      .sort((a, b) => b.latestUpdated.localeCompare(a.latestUpdated));
  }, [documents]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

  // Wrapper to open task detail by fetching full task first
  const handleOpenTask = useCallback(async (taskId: string) => {
    try {
      const task = await fetchTaskDetail(taskId, projectId);
      onOpenDetail(task);
    } catch (err) {
      addToast(`Failed to open task ${taskId}`, "error");
    }
  }, [projectId, onOpenDetail, addToast]);

  if (error) {
    return (
      <div className="documents-view">
        <div className="documents-view-error">
          <p>Failed to load documents: {error}</p>
          <button className="btn btn-primary" onClick={() => void refresh()}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="documents-view">
      <div className="documents-view-header">
        <div className="documents-view-title-row">
          <h2 className="documents-view-title">
            <FileText size={20} />
            Documents
          </h2>
          <span className="documents-view-count">
            {loading ? "…" : `${documents.length} total`}
          </span>
        </div>

        <div className="documents-search">
          <Search size={16} className="documents-search-icon" />
          <input
            type="text"
            className="documents-search-input"
            placeholder="Search documents…"
            value={searchQuery}
            onChange={handleSearchChange}
            aria-label="Search documents"
          />
          {searchQuery && (
            <button
              className="documents-search-clear"
              onClick={clearSearch}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="documents-view-content">
        {loading ? (
          <div className="documents-view-loading">
            <p>Loading documents…</p>
          </div>
        ) : groupedDocuments.length === 0 ? (
          <div className="documents-view-empty">
            {searchQuery ? (
              <p>No documents match "{searchQuery}".</p>
            ) : (
              <>
                <FileText size={48} className="documents-view-empty-icon" />
                <p>No documents yet.</p>
                <p className="documents-view-empty-hint">
                  Documents are created in task detail tabs.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="documents-view-list">
            {groupedDocuments.map(({ taskId, taskTitle, documents: taskDocs }) => (
              <TaskGroup
                key={taskId}
                taskId={taskId}
                taskTitle={taskTitle}
                documents={taskDocs}
                onOpenTask={handleOpenTask}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
