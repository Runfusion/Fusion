import "./DocumentsView.css";
import { useState, useMemo, useCallback, useEffect, useRef, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileText, ChevronDown, ChevronUp, ChevronRight, RefreshCw, Search, X, Eye, EyeOff } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArtifactWithTask, TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { artifactMediaUrl, fetchTaskDetail, fetchWorkspaceFileContent, type MarkdownFileEntry } from "../api";
import { useArtifacts } from "../hooks/useArtifacts";
import { useDocuments } from "../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../hooks/useProjectMarkdownFiles";
import { useSelectionComment } from "../hooks/useSelectionComment";
import { SelectionCommentPopover } from "./SelectionCommentPopover";
import { LoadingSpinner } from "./LoadingSpinner";
import { ArtifactMedia, getArtifactTypeLabel } from "./ArtifactMedia";

const MOBILE_BREAKPOINT = 768;

type DocumentsTab = "project" | "tasks" | "artifacts";

export interface DocumentsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onOpenDetail: (task: TaskDetail) => void;
  onSendSelectionToTask?: (description: string) => void;
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

interface ArtifactCardProps {
  artifact: ArtifactWithTask;
  projectId?: string;
  onOpenTask: (taskId: string) => void;
  onExpandMedia: (artifact: ArtifactWithTask) => void;
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
  const { t } = useTranslation("app");
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
            title={expanded ? t("documents.collapse", "Collapse") : t("documents.expand", "Expand")}
            aria-label={expanded ? t("documents.collapseContent", "Collapse content") : t("documents.expandContent", "Expand content")}
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
                aria-label={renderMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                aria-pressed={renderMarkdown}
                title={renderMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
              >
                {renderMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
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
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="documents-group">
      <div className="documents-group-header">
        <button
          className="documents-group-toggle-btn"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={`${expanded ? t("documents.collapse", "Collapse") : t("documents.expand", "Expand")} documents for task ${taskId}`}
        >
          <span className="documents-group-toggle" aria-hidden="true">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="documents-group-task-id">{taskId}</span>
          <span className="documents-group-task-title">{taskTitle || t("documents.untitled", "Untitled")}</span>
        </button>

        <span className="documents-group-count">{t("documents.docCount", "{{count}} doc{{plural}}", { count: documents.length, plural: documents.length !== 1 ? "s" : "" })}</span>

        <button
          className="documents-group-task-link"
          onClick={() => onOpenTask(taskId)}
          aria-label={t("documents.openTaskAria", "Open task {{taskId}}: {{title}}", { taskId, title: taskTitle || t("documents.untitled", "Untitled") })}
        >
          {t("documents.openTask", "Open task")}
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

function ArtifactCard({ artifact, projectId, onOpenTask, onExpandMedia }: ArtifactCardProps) {
  const { t } = useTranslation("app");
  const mediaUrl = artifactMediaUrl(artifact.id, projectId);
  const typeLabel = getArtifactTypeLabel(t, artifact.type);
  const preview = artifact.content ? getContentPreview(artifact.content, 320) : artifact.description;
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const isExpandableMedia = artifact.type === "image" || artifact.type === "video";
  const handleExpandKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onExpandMedia(artifact);
    }
  }, [artifact, onExpandMedia]);

  return (
    <article className="document-card documents-artifact-card" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      {isExpandableMedia ? (
        <div
          className="documents-artifact-preview documents-artifact-preview--expandable"
          role="button"
          tabIndex={0}
          aria-label={t("documents.expandArtifact", "Expand {{title}}", { title })}
          onClick={() => onExpandMedia(artifact)}
          onKeyDown={handleExpandKeyDown}
        >
          {artifact.type === "image" ? (
            <img className="documents-artifact-media" src={mediaUrl} alt={title} loading="lazy" />
          ) : (
            <video className="documents-artifact-media" src={mediaUrl} muted preload="metadata" aria-label={t("documents.artifactVideoLabel", "Video artifact: {{title}}", { title })} />
          )}
          <span className="documents-artifact-expand-hint">{t("documents.expandArtifactHint", "Click to expand")}</span>
        </div>
      ) : (
        <div className="documents-artifact-preview">
          <ArtifactMedia artifact={artifact} mediaUrl={mediaUrl} title={title} preview={preview} t={t} />
        </div>
      )}
      <div className="documents-artifact-body">
        <div className="documents-artifact-header">
          <span className="documents-artifact-type-badge">{typeLabel}</span>
          <span className="documents-artifact-author">{artifact.authorId}</span>
        </div>
        <h3 className="documents-artifact-title">{title}</h3>
        {artifact.description && <p className="documents-artifact-description">{artifact.description}</p>}
        <div className="documents-artifact-meta">
          <span>{formatTimestamp(artifact.createdAt)}</span>
          {artifact.sizeBytes !== undefined && <span>{formatFileSize(artifact.sizeBytes)}</span>}
        </div>
        {artifact.taskId && (
          <button
            className="documents-group-task-link documents-artifact-task-link"
            onClick={() => onOpenTask(artifact.taskId as string)}
            aria-label={t("documents.openTaskAria", "Open task {{taskId}}: {{title}}", { taskId: artifact.taskId, title: artifact.taskTitle || t("documents.untitled", "Untitled") })}
          >
            {t("documents.openTask", "Open task")}
          </button>
        )}
      </div>
    </article>
  );
}

export function DocumentsView({ projectId, addToast, onOpenDetail, onSendSelectionToTask }: DocumentsViewProps) {
  const { t } = useTranslation("app");
  const [activeTab, setActiveTab] = useState<DocumentsTab>("project");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<MarkdownFileEntry | null>(null);
  const [showHiddenProjectFiles, setShowHiddenProjectFiles] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const requestIdRef = useRef(0);
  const initialTabSetRef = useRef(false);
  const markdownPreviewRef = useRef<HTMLDivElement>(null);
  const plainPreviewRef = useRef<HTMLPreElement>(null);
  // Markdown render toggle for project file preview
  const [renderProjectMarkdown, setRenderProjectMarkdown] = useState(false);
  // Markdown render toggles per task document card (scoped by doc ID)
  const [taskDocMarkdownStates, setTaskDocMarkdownStates] = useState<Map<string, boolean>>(new Map());
  /*
  FNXC:ArtifactRegistry 2026-06-21-23:22:
  Image and video artifacts open in a dismissible lightbox, but audio, document, and generic artifacts remain normal cards so non-previewable media never receive orphaned expand targets.
  */
  const [lightboxArtifact, setLightboxArtifact] = useState<ArtifactWithTask | null>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement>(null);
  const lightboxReturnFocusRef = useRef<HTMLElement | null>(null);
  const [selectionCommentOpen, setSelectionCommentOpen] = useState(false);
  const markdownSelection = useSelectionComment(markdownPreviewRef, { locked: selectionCommentOpen });
  const plainSelection = useSelectionComment(plainPreviewRef, { locked: selectionCommentOpen });
  const activeProjectSelection = renderProjectMarkdown ? markdownSelection : plainSelection;

  const taskSearchQuery = activeTab === "tasks" ? searchQuery.trim() : "";
  const artifactSearchQuery = activeTab === "artifacts" ? searchQuery.trim() : "";

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
  } = useProjectMarkdownFiles(projectId, { showHidden: showHiddenProjectFiles });

  const {
    artifacts,
    loading: artifactsLoading,
    error: artifactsError,
    refresh: refreshArtifacts,
  } = useArtifacts({
    projectId,
    searchQuery: artifactSearchQuery || undefined,
  });

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
    setShowHiddenProjectFiles(false);
    setFileContent(null);
    setFileError(null);
    setFileLoading(false);
    setRenderProjectMarkdown(false);
    setTaskDocMarkdownStates(new Map());
    setLightboxArtifact(null);
  }, [projectId]);

  useEffect(() => {
    if (initialTabSetRef.current || documentsLoading || projectFilesLoading || artifactsLoading) {
      return;
    }

    if (projectFiles.length > 0) {
      setActiveTab("project");
    } else if (documents.length > 0) {
      setActiveTab("tasks");
    } else if (artifacts.length > 0) {
      setActiveTab("artifacts");
    }

    initialTabSetRef.current = true;
  }, [artifacts.length, artifactsLoading, documents.length, documentsLoading, projectFiles.length, projectFilesLoading]);

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

  const handleExpandArtifact = useCallback((artifact: ArtifactWithTask) => {
    lightboxReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLightboxArtifact(artifact);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxArtifact(null);
    lightboxReturnFocusRef.current?.focus();
    lightboxReturnFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (!lightboxArtifact) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    lightboxCloseRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseLightbox();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCloseLightbox, lightboxArtifact]);

  const handleLightboxOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      handleCloseLightbox();
    }
  }, [handleCloseLightbox]);

  const activeError = activeTab === "project" ? projectFilesError : activeTab === "tasks" ? documentsError : artifactsError;

  const handleRetry = useCallback(async () => {
    if (activeTab === "project") {
      await refreshProjectFiles();
      return;
    }
    if (activeTab === "tasks") {
      await refreshDocuments();
      return;
    }
    await refreshArtifacts();
  }, [activeTab, refreshArtifacts, refreshProjectFiles, refreshDocuments]);

  const activeCount = activeTab === "project" ? filteredProjectFiles.length : activeTab === "tasks" ? documents.length : artifacts.length;
  const selectionPopover = selectedFile && onSendSelectionToTask && activeProjectSelection ? (
    <SelectionCommentPopover
      selectedText={activeProjectSelection.selectedText}
      anchorRect={activeProjectSelection.anchorRect}
      filePath={selectedFile.path}
      onSubmit={onSendSelectionToTask}
      onOpenChange={setSelectionCommentOpen}
    />
  ) : null;

  const searchPlaceholder = activeTab === "project"
    ? t("documents.searchProjectFiles", "Search project markdown files…")
    : activeTab === "tasks"
      ? t("documents.searchTaskDocuments", "Search task documents…")
      : t("documents.searchArtifacts", "Search artifacts…");

  return (
    <div className="documents-view">
      <div className="documents-view-header">
        <div className="documents-view-title-row">
          <h2 className="documents-view-title">
            <FileText size={20} />
            {/* FNXC:Navigation 2026-06-21-18:25: FN-6890 renames the top-level Documents view header to Artifacts without changing internal task-document tabs or artifact sub-tabs. */}
            {t("documents.title", "Artifacts")}
          </h2>
          <span className="documents-view-count">
            {t("documents.resultCount", "{{count}} result{{plural}}", { count: activeCount, plural: activeCount !== 1 ? "s" : "" })}
          </span>
        </div>

        <div className="documents-controls-row">
          <div className="documents-tab-bar" role="tablist" aria-label={t("documents.sectionsLabel", "Documents sections")}>
            <button
              className={`btn documents-tab${activeTab === "project" ? " active" : ""}`}
              role="tab"
              aria-selected={activeTab === "project"}
              aria-label={t("documents.showProjectFiles", "Show project markdown files")}
              onClick={() => handleTabChange("project")}
            >
              {t("documents.projectFilesTab", "Project Files")}
              <span className="documents-tab-count">{projectFiles.length}</span>
            </button>
            <button
              className={`btn documents-tab${activeTab === "tasks" ? " active" : ""}`}
              role="tab"
              aria-selected={activeTab === "tasks"}
              aria-label={t("documents.showTaskDocuments", "Show task documents")}
              onClick={() => handleTabChange("tasks")}
            >
              {t("documents.taskDocumentsTab", "Task Documents")}
              <span className="documents-tab-count">{groupedDocuments.length}</span>
            </button>
            {/*
              FNXC:ArtifactRegistry 2026-06-21-04:46:
              The Documents navigation has one canonical Artifacts tab so media produced by any agent is discoverable without adding another dashboard destination.
            */}
            <button
              className={`btn documents-tab${activeTab === "artifacts" ? " active" : ""}`}
              role="tab"
              aria-selected={activeTab === "artifacts"}
              aria-label={t("documents.showArtifacts", "Show artifacts")}
              onClick={() => handleTabChange("artifacts")}
            >
              {t("documents.artifactsTab", "Artifacts")}
              <span className="documents-tab-count">{artifacts.length}</span>
            </button>
          </div>

          {activeTab === "project" && (
            <button
              className="btn btn-sm documents-hidden-toggle"
              onClick={() => setShowHiddenProjectFiles((prev) => !prev)}
              aria-pressed={showHiddenProjectFiles}
              aria-label={showHiddenProjectFiles ? t("documents.hideHidden", "Hide hidden project files") : t("documents.showHidden", "Show hidden project files")}
              title={showHiddenProjectFiles ? t("documents.hideHiddenFiles", "Hide hidden files") : t("documents.showHiddenFiles", "Show hidden files")}
            >
              {showHiddenProjectFiles ? <EyeOff size={14} /> : <Eye size={14} />}
              {showHiddenProjectFiles ? t("documents.hideHiddenLabel", "Hide Hidden") : t("documents.showHiddenLabel", "Show Hidden")}
            </button>
          )}

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
                aria-label={t("documents.clearSearch", "Clear search")}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="documents-view-content">
        {activeError ? (
          <div className="documents-view-error">
            <p>{t("documents.failedToLoad", "Failed to load {{type}}: {{error}}", { type: activeTab === "project" ? t("documents.projectFiles", "project files") : activeTab === "tasks" ? t("documents.taskDocuments", "task documents") : t("documents.artifacts", "artifacts"), error: activeError })}</p>
            <button className="btn btn-primary" onClick={() => void handleRetry()} aria-label={t("documents.retryLoading", "Retry loading documents")}>
              <RefreshCw size={16} />
              {t("documents.retry", "Retry")}
            </button>
          </div>
        ) : activeTab === "project" ? (
          projectFilesLoading && projectFiles.length === 0 ? (
            <div className="documents-view-loading">
              <p><LoadingSpinner label={t("documents.loadingProjectFiles", "Loading project markdown files…")} /></p>
            </div>
          ) : filteredProjectFiles.length === 0 ? (
            <div className="documents-view-empty">
              {searchQuery.trim() ? (
                <p>{t("documents.noMatchProject", "No project markdown files match \"{{query}}\".", { query: searchQuery.trim() })}</p>
              ) : (
                <>
                  <FileText size={48} className="documents-view-empty-icon" />
                  <p>{t("documents.noMarkdownFiles", "No Markdown files found in this project.")}</p>
                </>
              )}
            </div>
          ) : (
            <div className={`documents-project-layout${isMobile ? " documents-project-layout--mobile" : ""}`}>
              {(!isMobile || !selectedFile) && (
                <aside className="documents-view-sidebar" aria-label={t("documents.projectMarkdownFilesLabel", "Project markdown files")}>
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
                <section className="documents-view-main" aria-label={t("documents.projectFilePreviewLabel", "Project file content preview")}>
                  {isMobile && selectedFile && (
                    <button
                      className="btn btn-sm documents-mobile-back"
                      onClick={handleBackToFileList}
                      aria-label={t("documents.backToFilesList", "Back to project files list")}
                    >
                      <ArrowLeft size={14} />
                      {t("documents.backToFiles", "Back to files")}
                    </button>
                  )}

                  {!selectedFile ? (
                    <div className="documents-view-empty">
                      <p>{t("documents.selectFile", "Select a Markdown file to view its content.")}</p>
                    </div>
                  ) : (
                    <div className="documents-content-viewer">
                      <div className="documents-content-header">
                        <p className="documents-file-path-header">{selectedFile.path}</p>
                        <button
                          className="btn btn-sm document-mode-toggle"
                          onClick={() => setRenderProjectMarkdown((prev) => !prev)}
                          aria-label={renderProjectMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                          aria-pressed={renderProjectMarkdown}
                          title={renderProjectMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                        >
                          {renderProjectMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
                        </button>
                      </div>
                      {fileLoading ? (
                        <p className="documents-content-state"><LoadingSpinner label={t("documents.loadingFileContent", "Loading file content…")} /></p>
                      ) : fileError ? (
                        <p className="documents-content-state documents-content-state--error">{fileError}</p>
                      ) : renderProjectMarkdown ? (
                        <div ref={markdownPreviewRef} className="documents-content-markdown">
                          <div className="markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent ?? ""}</ReactMarkdown>
                          </div>
                        </div>
                      ) : (
                        <pre ref={plainPreviewRef} className="document-card-content-text documents-content-viewer-text">{fileContent ?? ""}</pre>
                      )}
                      {selectionPopover}
                    </div>
                  )}
                </section>
              )}
            </div>
          )
        ) : activeTab === "artifacts" ? (
          artifactsLoading && artifacts.length === 0 ? (
            <div className="documents-view-loading">
              <p>{t("documents.loadingArtifacts", "Loading artifacts…")}</p>
            </div>
          ) : artifacts.length === 0 ? (
            <div className="documents-view-empty">
              {searchQuery.trim() ? (
                <p>{t("documents.noMatchArtifacts", "No artifacts match \"{{query}}\".", { query: searchQuery.trim() })}</p>
              ) : (
                <>
                  <FileText size={48} className="documents-view-empty-icon" />
                  <p>{t("documents.noArtifacts", "No artifacts yet.")}</p>
                  <p className="documents-view-empty-hint">
                    {t("documents.artifactsCreatedBy", "Artifacts are created by agents, users, and system tools.")}
                  </p>
                </>
              )}
            </div>
          ) : (
            /*
              FNXC:ArtifactRegistry 2026-06-21-04:46:
              The gallery must render all artifact media classes in one responsive surface: images, video, audio, inline documents, and generic file links keep their task and author context visible.
            */
            <div className={`documents-artifact-gallery${isMobile ? " documents-artifact-gallery--mobile" : ""}`}>
              {artifacts.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  projectId={projectId}
                  onOpenTask={handleOpenTask}
                  onExpandMedia={handleExpandArtifact}
                />
              ))}
            </div>
          )
        ) : documentsLoading && documents.length === 0 ? (
          <div className="documents-view-loading">
            <p><LoadingSpinner label={t("documents.loadingTaskDocuments", "Loading task documents…")} /></p>
          </div>
        ) : groupedDocuments.length === 0 ? (
          <div className="documents-view-empty">
            {searchQuery.trim() ? (
              <p>{t("documents.noMatchTask", "No task documents match \"{{query}}\".", { query: searchQuery.trim() })}</p>
            ) : (
              <>
                <FileText size={48} className="documents-view-empty-icon" />
                <p>{t("documents.noTaskDocuments", "No task documents yet.")}</p>
                <p className="documents-view-empty-hint">
                  {t("documents.documentsCreatedIn", "Documents are created in task detail tabs.")}
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
      {lightboxArtifact && (
        <div
          className="modal-overlay open documents-artifact-lightbox-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("documents.lightboxLabel", "Artifact media preview")}
          onClick={handleLightboxOverlayClick}
        >
          {/* FNXC:ArtifactRegistry 2026-06-21-23:22: The lightbox reuses the shared modal overlay pattern so image/video artifacts can expand full-size and dismiss by close button, backdrop, or Escape on desktop and mobile. */}
          <div className="documents-artifact-lightbox" onClick={(event) => event.stopPropagation()}>
            <div className="documents-artifact-lightbox-header">
              <h3 className="documents-artifact-lightbox-title">{lightboxArtifact.title || t("documents.untitledArtifact", "Untitled artifact")}</h3>
              <button ref={lightboxCloseRef} className="modal-close" onClick={handleCloseLightbox} aria-label={t("documents.closeLightbox", "Close artifact preview")}>
                <X size={20} />
              </button>
            </div>
            <div className="documents-artifact-lightbox-media-frame">
              {lightboxArtifact.type === "image" ? (
                <img
                  className="documents-artifact-lightbox-media"
                  src={artifactMediaUrl(lightboxArtifact.id, projectId)}
                  alt={lightboxArtifact.title || t("documents.untitledArtifact", "Untitled artifact")}
                />
              ) : (
                <video
                  className="documents-artifact-lightbox-media"
                  src={artifactMediaUrl(lightboxArtifact.id, projectId)}
                  controls
                  autoPlay
                  aria-label={t("documents.artifactVideoLabel", "Video artifact: {{title}}", { title: lightboxArtifact.title || t("documents.untitledArtifact", "Untitled artifact") })}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
