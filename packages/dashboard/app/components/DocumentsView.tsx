import { useState, useMemo, useCallback, useEffect, useRef, type ChangeEvent } from "react";
import { ArrowLeft, FileText, ChevronDown, ChevronUp, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchTaskDetail, fetchWorkspaceFileContent, type MarkdownFileEntry } from "../api";
import { useDocuments } from "../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../hooks/useProjectMarkdownFiles";

const MOBILE_BREAKPOINT = 768;

type DocumentsTab = "project" | "tasks";

export interface DocumentsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onOpenDetail: (task: TaskDetail) => void;
}

interface DocumentCardProps {
  document: TaskDocumentWithTask;
  renderMarkdown: boolean;
  onToggleMarkdown: () => void;
}

interface TaskGroupProps {
  taskId: string;
  taskTitle?: string;
  documents: TaskDocumentWithTask[];
  onOpenTask: (taskId: string) => void;
  renderMarkdownStates: Map<string, boolean>;
  onToggleMarkdown: (docId: string) => void;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getContentPreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content;
  return `${content.substring(0, maxLength)}…`;
}

function DocumentCard({ document, renderMarkdown, onToggleMarkdown }: DocumentCardProps) {
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
        <div className="document-card-actions">
          <button
            className="btn btn-sm document-card-expand-btn"
            onClick={() => setExpanded((current) => !current)}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? "Collapse content" : "Expand content"}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      <div className="document-card-meta">
        <span className="document-card-author">{document.author}</span>
        <span className="document-card-separator">·</span>
        <span className="document-card-date">{formatTimestamp(document.updatedAt)}</span>
      </div>

      <div className={`document-card-content${expanded ? " document-card-content--expanded" : ""}`}>
        {expanded ? (
          <>
            <div className="document-card-content-header">
              <button
                className="btn btn-sm document-mode-toggle"
                onClick={onToggleMarkdown}
                aria-label={renderMarkdown ? "Switch to plain text" : "Switch to markdown"}
                aria-pressed={renderMarkdown}
                title={renderMarkdown ? "Switch to plain text" : "Switch to markdown"}
              >
                {renderMarkdown ? "Markdown" : "Plain"}
              </button>
            </div>
            {renderMarkdown ? (
              <div className="document-card-content-markdown">
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{document.content}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <pre className="document-card-content-text">{document.content}</pre>
            )}
          </>
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

function TaskGroup({ taskId, taskTitle, documents, onOpenTask, renderMarkdownStates, onToggleMarkdown }: TaskGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="documents-group">
      <div className="documents-group-header">
        <button
          className="documents-group-toggle-btn"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} documents for task ${taskId}`}
        >
          <span className="documents-group-toggle" aria-hidden="true">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="documents-group-task-id">{taskId}</span>
          <span className="documents-group-task-title">{taskTitle || "Untitled"}</span>
        </button>

        <span className="documents-group-count">{documents.length} doc{documents.length !== 1 ? "s" : ""}</span>

        <button
          className="documents-group-task-link"
          onClick={() => onOpenTask(taskId)}
          aria-label={`Open task ${taskId}: ${taskTitle || "Untitled"}`}
        >
          Open task
        </button>
      </div>

      {expanded && (
        <div className="documents-group-content">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              renderMarkdown={renderMarkdownStates.get(doc.id) ?? false}
              onToggleMarkdown={() => onToggleMarkdown(doc.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentsView({ projectId, addToast, onOpenDetail }: DocumentsViewProps) {
  const [activeTab, setActiveTab] = useState<DocumentsTab>("project");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<MarkdownFileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const requestIdRef = useRef(0);
  const initialTabSetRef = useRef(false);
  // Markdown render toggle for project file preview
  const [renderProjectMarkdown, setRenderProjectMarkdown] = useState(false);
  // Markdown render toggles per task document card (scoped by doc ID)
  const [taskDocMarkdownStates, setTaskDocMarkdownStates] = useState<Map<string, boolean>>(new Map());

  const taskSearchQuery = activeTab === "tasks" ? searchQuery.trim() : "";

  const {
    documents,
    loading: documentsLoading,
    error: documentsError,
    refresh: refreshDocuments,
  } = useDocuments({
    projectId,
    searchQuery: taskSearchQuery || undefined,
    includeProjectFiles: false,
  });

  const {
    files: projectFiles,
    loading: projectFilesLoading,
    error: projectFilesError,
    refresh: refreshProjectFiles,
  } = useProjectMarkdownFiles(projectId);

  useEffect(() => {
    const updateMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };

    updateMobile();
    window.addEventListener("resize", updateMobile);

    return () => {
      window.removeEventListener("resize", updateMobile);
    };
  }, []);

  useEffect(() => {
    initialTabSetRef.current = false;
    setActiveTab("project");
    setSelectedFile(null);
    setFileContent(null);
    setFileError(null);
    setFileLoading(false);
    setRenderProjectMarkdown(false);
    setTaskDocMarkdownStates(new Map());
  }, [projectId]);

  useEffect(() => {
    if (initialTabSetRef.current || documentsLoading || projectFilesLoading) {
      return;
    }

    if (projectFiles.length > 0) {
      setActiveTab("project");
    } else if (documents.length > 0) {
      setActiveTab("tasks");
    }

    initialTabSetRef.current = true;
  }, [documents.length, documentsLoading, projectFiles.length, projectFilesLoading]);

  const groupedDocuments = useMemo(() => {
    const groups = new Map<string, TaskDocumentWithTask[]>();
    for (const doc of documents) {
      const existing = groups.get(doc.taskId) || [];
      groups.set(doc.taskId, [...existing, doc]);
    }

    return Array.from(groups.entries())
      .map(([taskId, docs]) => {
        const sortedDocs = [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        return {
          taskId,
          taskTitle: sortedDocs[0]?.taskTitle,
          documents: sortedDocs,
          latestUpdated: sortedDocs[0]?.updatedAt ?? "",
        };
      })
      .sort((a, b) => b.latestUpdated.localeCompare(a.latestUpdated));
  }, [documents]);

  const filteredProjectFiles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return projectFiles;
    }

    return projectFiles.filter((file) => {
      const normalizedPath = file.path.toLowerCase();
      const normalizedName = file.name.toLowerCase();
      return normalizedPath.includes(normalizedQuery) || normalizedName.includes(normalizedQuery);
    });
  }, [projectFiles, searchQuery]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }

    const selectedStillExists = projectFiles.some((file) => file.path === selectedFile.path);
    if (!selectedStillExists) {
      setSelectedFile(null);
      setFileContent(null);
      setFileError(null);
      setFileLoading(false);
    }
  }, [projectFiles, selectedFile]);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

  const handleTabChange = useCallback((tab: DocumentsTab) => {
    setActiveTab(tab);
  }, []);

  const handleOpenTask = useCallback(async (taskId: string) => {
    try {
      const task = await fetchTaskDetail(taskId, projectId);
      onOpenDetail(task);
    } catch {
      addToast(`Failed to open task ${taskId}`, "error");
    }
  }, [projectId, onOpenDetail, addToast]);

  const handleSelectProjectFile = useCallback(async (file: MarkdownFileEntry) => {
    setSelectedFile(file);
    setFileLoading(true);
    setFileError(null);
    setFileContent(null);

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const fileResponse = await fetchWorkspaceFileContent("project", file.path, projectId);
      if (requestIdRef.current !== requestId) {
        return;
      }
      setFileContent(fileResponse.content);
    } catch (err) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      const message = err instanceof Error ? err.message : `Failed to open ${file.path}`;
      setFileError(message);
      addToast(message, "error");
    } finally {
      if (requestIdRef.current === requestId) {
        setFileLoading(false);
      }
    }
  }, [projectId, addToast]);

  const handleBackToFileList = useCallback(() => {
    setSelectedFile(null);
    setFileContent(null);
    setFileError(null);
    setFileLoading(false);
  }, []);

  const handleToggleTaskDocMarkdown = useCallback((docId: string) => {
    setTaskDocMarkdownStates((prev) => {
      const next = new Map(prev);
      const current = next.get(docId) ?? false;
      next.set(docId, !current);
      return next;
    });
  }, []);

  const activeError = activeTab === "project" ? projectFilesError : documentsError;

  const handleRetry = useCallback(async () => {
    if (activeTab === "project") {
      await refreshProjectFiles();
      return;
    }
    await refreshDocuments();
  }, [activeTab, refreshProjectFiles, refreshDocuments]);

  const activeCount = activeTab === "project" ? filteredProjectFiles.length : documents.length;

  const searchPlaceholder = activeTab === "project"
    ? "Search project markdown files…"
    : "Search task documents…";

  return (
    <div className="documents-view">
      <div className="documents-view-header">
        <div className="documents-view-title-row">
          <h2 className="documents-view-title">
            <FileText size={20} />
            Documents
          </h2>
          <span className="documents-view-count">
            {activeCount} result{activeCount !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="documents-tab-bar" role="tablist" aria-label="Documents sections">
          <button
            className={`btn documents-tab${activeTab === "project" ? " active" : ""}`}
            role="tab"
            aria-selected={activeTab === "project"}
            aria-label="Show project markdown files"
            onClick={() => handleTabChange("project")}
          >
            Project Files
            <span className="documents-tab-count">{projectFiles.length}</span>
          </button>
          <button
            className={`btn documents-tab${activeTab === "tasks" ? " active" : ""}`}
            role="tab"
            aria-selected={activeTab === "tasks"}
            aria-label="Show task documents"
            onClick={() => handleTabChange("tasks")}
          >
            Task Documents
            <span className="documents-tab-count">{groupedDocuments.length}</span>
          </button>
        </div>

        <div className="documents-search">
          <Search size={16} className="documents-search-icon" />
          <input
            type="text"
            className="documents-search-input"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={handleSearchChange}
            aria-label={searchPlaceholder}
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
        {activeError ? (
          <div className="documents-view-error">
            <p>Failed to load {activeTab === "project" ? "project files" : "task documents"}: {activeError}</p>
            <button className="btn btn-primary" onClick={() => void handleRetry()} aria-label="Retry loading documents">
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        ) : activeTab === "project" ? (
          projectFilesLoading && projectFiles.length === 0 ? (
            <div className="documents-view-loading">
              <p>Loading project markdown files…</p>
            </div>
          ) : filteredProjectFiles.length === 0 ? (
            <div className="documents-view-empty">
              {searchQuery.trim() ? (
                <p>No project markdown files match "{searchQuery.trim()}".</p>
              ) : (
                <>
                  <FileText size={48} className="documents-view-empty-icon" />
                  <p>No Markdown files found in this project.</p>
                </>
              )}
            </div>
          ) : (
            <div className={`documents-project-layout${isMobile ? " documents-project-layout--mobile" : ""}`}>
              {(!isMobile || !selectedFile) && (
                <aside className="documents-view-sidebar" aria-label="Project markdown files">
                  <ul className="markdown-file-list">
                    {filteredProjectFiles.map((file) => {
                      const isSelected = selectedFile?.path === file.path;
                      return (
                        <li key={file.path} className="markdown-file-list-item">
                          <button
                            className={`markdown-file-item${isSelected ? " markdown-file-item--selected" : ""}`}
                            onClick={() => void handleSelectProjectFile(file)}
                            aria-label={`Open ${file.path}`}
                            aria-current={isSelected ? "true" : undefined}
                          >
                            <span className="markdown-file-item-name">{file.name}</span>
                            <span className="markdown-file-item-path">{file.path}</span>
                            <span className="markdown-file-item-meta">
                              {formatFileSize(file.size)} · {formatTimestamp(file.mtime)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </aside>
              )}

              {(!isMobile || selectedFile) && (
                <section className="documents-view-main" aria-label="Project file content preview">
                  {isMobile && selectedFile && (
                    <button
                      className="btn btn-sm documents-mobile-back"
                      onClick={handleBackToFileList}
                      aria-label="Back to project files list"
                    >
                      <ArrowLeft size={14} />
                      Back to files
                    </button>
                  )}

                  {!selectedFile ? (
                    <div className="documents-view-empty">
                      <p>Select a Markdown file to view its content.</p>
                    </div>
                  ) : (
                    <div className="documents-content-viewer">
                      <div className="documents-content-header">
                        <p className="documents-file-path-header">{selectedFile.path}</p>
                        <button
                          className="btn btn-sm document-mode-toggle"
                          onClick={() => setRenderProjectMarkdown((prev) => !prev)}
                          aria-label={renderProjectMarkdown ? "Switch to plain text" : "Switch to markdown"}
                          aria-pressed={renderProjectMarkdown}
                          title={renderProjectMarkdown ? "Switch to plain text" : "Switch to markdown"}
                        >
                          {renderProjectMarkdown ? "Markdown" : "Plain"}
                        </button>
                      </div>
                      {fileLoading ? (
                        <p className="documents-content-state">Loading file content…</p>
                      ) : fileError ? (
                        <p className="documents-content-state documents-content-state--error">{fileError}</p>
                      ) : renderProjectMarkdown ? (
                        <div className="documents-content-markdown">
                          <div className="markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent ?? ""}</ReactMarkdown>
                          </div>
                        </div>
                      ) : (
                        <pre className="document-card-content-text documents-content-viewer-text">{fileContent ?? ""}</pre>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          )
        ) : documentsLoading && documents.length === 0 ? (
          <div className="documents-view-loading">
            <p>Loading task documents…</p>
          </div>
        ) : groupedDocuments.length === 0 ? (
          <div className="documents-view-empty">
            {searchQuery.trim() ? (
              <p>No task documents match "{searchQuery.trim()}".</p>
            ) : (
              <>
                <FileText size={48} className="documents-view-empty-icon" />
                <p>No task documents yet.</p>
                <p className="documents-view-empty-hint">
                  Documents are created in task detail tabs.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="documents-task-list-wrap">
            <div className="documents-view-list">
              {groupedDocuments.map(({ taskId, taskTitle, documents: taskDocs }) => (
                <TaskGroup
                  key={taskId}
                  taskId={taskId}
                  taskTitle={taskTitle}
                  documents={taskDocs}
                  onOpenTask={handleOpenTask}
                  renderMarkdownStates={taskDocMarkdownStates}
                  onToggleMarkdown={handleToggleTaskDocMarkdown}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
