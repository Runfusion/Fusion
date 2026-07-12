import "./DocumentsView.css";
import { useState, useMemo, useCallback, useEffect, useRef, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileText, RefreshCw, Search, X, Eye, EyeOff } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnId, TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchTaskDetail, fetchWorkspaceFileContent, type MarkdownFileEntry } from "../api";
import { useArtifacts } from "../hooks/useArtifacts";
import { useDocuments } from "../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../hooks/useProjectMarkdownFiles";
import { useSelectionComment } from "../hooks/useSelectionComment";
import { SelectionCommentPopover } from "./SelectionCommentPopover";
import { LoadingSpinner } from "./LoadingSpinner";
import { ArtifactsGallery } from "./ArtifactsGallery";
import { ViewHeader } from "./ViewHeader";
import { useColumnLabel } from "../i18n/labels";

const MOBILE_BREAKPOINT = 768;

type DocumentsTab = "project" | "tasks" | "artifacts";

export interface DocumentsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onOpenDetail: (task: TaskDetail) => void;
  onOpenArtifactTaskDetail?: (task: TaskDetail) => void;
  onSendSelectionToTask?: (description: string) => void;
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

function getTaskColumnStatusDotClass(taskColumn: string): string {
  if (taskColumn === "done") return "status-dot status-dot--online";
  if (taskColumn === "archived") return "status-dot status-dot--offline";
  if (taskColumn === "todo" || taskColumn === "triage") return "status-dot status-dot--pending";
  return "status-dot status-dot--connecting";
}

export function DocumentsView({ projectId, addToast, onOpenDetail, onOpenArtifactTaskDetail, onSendSelectionToTask }: DocumentsViewProps) {
  const { t } = useTranslation("app");
  // FNXC:ArtifactsView 2026-07-11-11:30: Artifacts is the first tab and the landing tab — the view is the artifact gallery first, with project files and task documents as secondary tabs.
  const [activeTab, setActiveTab] = useState<DocumentsTab>("artifacts");
  const columnLabel = useColumnLabel();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<MarkdownFileEntry | null>(null);
  const [selectedTaskDocumentId, setSelectedTaskDocumentId] = useState<string | null>(null);
  const [showHiddenProjectFiles, setShowHiddenProjectFiles] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const requestIdRef = useRef(0);
  const markdownPreviewRef = useRef<HTMLDivElement>(null);
  const plainPreviewRef = useRef<HTMLPreElement>(null);
  const taskDocMarkdownPreviewRef = useRef<HTMLDivElement>(null);
  const taskDocPlainPreviewRef = useRef<HTMLPreElement>(null);
  // Markdown render toggle for project file preview
  const [renderProjectMarkdown, setRenderProjectMarkdown] = useState(false);
  // Markdown render toggles per task document card (scoped by doc ID)
  const [taskDocMarkdownStates, setTaskDocMarkdownStates] = useState<Map<string, boolean>>(new Map());
  const [selectionCommentOpen, setSelectionCommentOpen] = useState(false);
  const markdownSelection = useSelectionComment(markdownPreviewRef, { locked: selectionCommentOpen });
  const plainSelection = useSelectionComment(plainPreviewRef, { locked: selectionCommentOpen });
  const taskDocMarkdownSelection = useSelectionComment(taskDocMarkdownPreviewRef, { locked: selectionCommentOpen });
  const taskDocPlainSelection = useSelectionComment(taskDocPlainPreviewRef, { locked: selectionCommentOpen });
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
    setActiveTab("artifacts");
    setSelectedFile(null);
    setSelectedTaskDocumentId(null);
    setShowHiddenProjectFiles(false);
    setFileContent(null);
    setFileError(null);
    setFileLoading(false);
    setRenderProjectMarkdown(false);
    setTaskDocMarkdownStates(new Map());
  }, [projectId]);

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
          /*
          FNXC:DocumentsView 2026-07-02-00:00:
          Task document groups must surface the parent task completion state in the header so operators can identify done work without expanding documents or opening task details. Use the first available column from the grouped task documents because legacy rows may omit taskColumn.
          */
          taskColumn: sortedDocs.find((doc) => doc.taskColumn)?.taskColumn,
          documents: sortedDocs,
          latestUpdated: sortedDocs[0]?.updatedAt ?? "",
        };
      })
      .sort((a, b) => b.latestUpdated.localeCompare(a.latestUpdated));
  }, [documents]);


  /*
  FNXC:DocumentsView 2026-07-10-17:30:
  Task Documents now mirrors the Project Files sidebar/right-pane contract: the task-document selection is deliberately separate from selectedFile so tab switching cannot leak project file content into the Task Documents pane. Task Documents keeps its own Plain/Markdown render toggle so Project Files state never controls task-document rendering.

  FNXC:DocumentsView 2026-07-10-23:41:
  FN-7812 extends the existing select-to-comment affordance to the Task Documents right pane without a new comment model. The active task-document selection ref follows the same Plain/Markdown toggle, and the composed source path uses taskId/key so operators can identify the originating task document. Keep Task Documents gated by selectedTaskDocument and Project Files gated by selectedFile so tab switches cannot cross-render popovers; the shared composer-open lock is safe because only one tab pane is mounted at a time.
  */
  const selectedTaskDocument = useMemo(() => {
    if (!selectedTaskDocumentId) {
      return null;
    }

    return documents.find((doc) => doc.id === selectedTaskDocumentId) ?? null;
  }, [documents, selectedTaskDocumentId]);

  useEffect(() => {
    if (selectedTaskDocumentId && !selectedTaskDocument) {
      setSelectedTaskDocumentId(null);
    }
  }, [selectedTaskDocument, selectedTaskDocumentId]);

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
    if (tab !== "tasks") {
      setSelectedTaskDocumentId(null);
    }
  }, []);

  const handleOpenTask = useCallback(async (taskId: string) => {
    try {
      const task = await fetchTaskDetail(taskId, projectId);
      onOpenDetail(task);
    } catch {
      addToast(`Failed to open task ${taskId}`, "error");
    }
  }, [projectId, onOpenDetail, addToast]);

  /*
  FNXC:ArtifactRegistry 2026-06-22-12:00:
  Artifact cards should open their parent task in the same movable task popup
  used by board/list pop-out flows, not the fixed task-detail modal. Keep task
  document groups on the existing onOpenDetail path so only artifact-origin
  task opens change surface.
  */
  const handleOpenArtifactTask = useCallback(async (taskId: string) => {
    try {
      const task = await fetchTaskDetail(taskId, projectId);
      (onOpenArtifactTaskDetail ?? onOpenDetail)(task);
    } catch {
      addToast(`Failed to open task ${taskId}`, "error");
    }
  }, [projectId, onOpenArtifactTaskDetail, onOpenDetail, addToast]);

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

  const handleSelectTaskDocument = useCallback((docId: string) => {
    setSelectedTaskDocumentId(docId);
  }, []);

  const handleBackToTaskDocumentList = useCallback(() => {
    setSelectedTaskDocumentId(null);
  }, []);

  const handleToggleTaskDocMarkdown = useCallback((docId: string) => {
    setTaskDocMarkdownStates((prev) => {
      const next = new Map(prev);
      const current = next.get(docId) ?? false;
      next.set(docId, !current);
      return next;
    });
  }, []);

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
  const selectedTaskDocumentRendersMarkdown = selectedTaskDocument ? (taskDocMarkdownStates.get(selectedTaskDocument.id) ?? false) : false;
  const activeTaskDocumentSelection = selectedTaskDocumentRendersMarkdown ? taskDocMarkdownSelection : taskDocPlainSelection;
  const selectionPopover = activeTab === "project" && selectedFile && onSendSelectionToTask && activeProjectSelection ? (
    <SelectionCommentPopover
      selectedText={activeProjectSelection.selectedText}
      anchorRect={activeProjectSelection.anchorRect}
      filePath={selectedFile.path}
      onSubmit={onSendSelectionToTask}
      onOpenChange={setSelectionCommentOpen}
    />
  ) : null;
  const taskDocumentSelectionPopover = activeTab === "tasks" && selectedTaskDocument && onSendSelectionToTask && activeTaskDocumentSelection ? (
    <SelectionCommentPopover
      selectedText={activeTaskDocumentSelection.selectedText}
      anchorRect={activeTaskDocumentSelection.anchorRect}
      filePath={`${selectedTaskDocument.taskId}/${selectedTaskDocument.key}`}
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
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Documents/Artifacts adopts the shared ViewHeader (CC-modeled) for a consistent main-content title row; the result count rides in the header actions while the tab bar, hidden-files toggle, and search stay in the controls row below.
      FNXC:Navigation 2026-06-21-18:25: FN-6890 keeps the top-level title as Artifacts (renamed from Documents) without changing internal task-document tabs or artifact sub-tabs.
      */}
      <div className="documents-view-header">
        <ViewHeader
          icon={FileText}
          title={t("documents.title", "Artifacts")}
          actions={(
            <span className="documents-view-count">
              {t("documents.resultCount", "{{count}} result{{plural}}", { count: activeCount, plural: activeCount !== 1 ? "s" : "" })}
            </span>
          )}
        />

        <div className="documents-controls-row">
          <div className="documents-tab-bar" role="tablist" aria-label={t("documents.sectionsLabel", "Documents sections")}>
            {/*
              FNXC:ArtifactRegistry 2026-07-11-11:30:
              Artifacts leads the tab bar (and is the landing tab) — the view is the artifact gallery first; project files and task documents are secondary tabs.
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
                        {/*
                        FNXC:ArtifactsView 2026-07-10-16:10:
                        First-run review feedback: the Artifacts preview pane did not communicate whether documents are editable. This pane is view-only (there is no editor here — editing happens elsewhere, e.g. the workspace FileEditor), so a persistent Read-only badge states that explicitly on both desktop and mobile. Select-to-comment still works and is the intended interaction.
                        */}
                        <span
                          className="documents-readonly-badge badge"
                          title={t("documents.readOnlyHint", "This preview is read-only. Select text to comment and send it to a new task.")}
                        >
                          {t("documents.readOnly", "Read-only")}
                        </span>
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
                    {t("documents.artifactsCreatedBy", "Agents register screenshots, wireframes, mockups, recordings, and documents here as they work on tasks.")}
                  </p>
                </>
              )}
            </div>
          ) : (
            /*
              FNXC:ArtifactRegistry 2026-07-10-15:40:
              The Artifacts tab delegates to ArtifactsGallery: a category-driven surface (Images, Docs, PDFs, Videos, Audio, Other) with a tailored viewer per category, including an editable full document viewer for inline-content docs.
            */
            <ArtifactsGallery
              artifacts={artifacts}
              projectId={projectId}
              isMobile={isMobile}
              addToast={addToast}
              onOpenTask={handleOpenArtifactTask}
              onArtifactUpdated={() => void refreshArtifacts()}
            />
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
          /*
          FNXC:DocumentsView 2026-07-10-17:30:
          FN-7811 requires Task Documents to use the same desktop two-pane and mobile list→detail→back gating as Project Files: show the grouped sidebar when desktop or no document is selected, and show the right-pane viewer when desktop or a document is selected.
          */
          <div className={`documents-project-layout documents-task-documents-layout${isMobile ? " documents-project-layout--mobile" : ""}`}>
            {(!isMobile || !selectedTaskDocument) && (
              <aside className="documents-view-sidebar documents-task-documents-sidebar" aria-label={t("documents.taskDocumentsListLabel", "Task documents")}>
                {groupedDocuments.map(({ taskId, taskTitle, taskColumn, documents: taskDocs }) => {
                  const taskStatusLabel = taskColumn ? columnLabel(taskColumn as ColumnId) : null;
                  const taskStatusDotClass = taskColumn ? getTaskColumnStatusDotClass(taskColumn) : "status-dot";

                  return (
                    <section key={taskId} className="documents-task-sidebar-group" aria-labelledby={`documents-task-group-${taskId}`}>
                      <div className="documents-task-sidebar-group-header">
                        <div className="documents-task-sidebar-title-wrap">
                          <h3 id={`documents-task-group-${taskId}`} className="documents-task-sidebar-title">
                            <span className="documents-group-task-id">{taskId}</span>
                            <span className="documents-group-task-title">{taskTitle || t("documents.untitled", "Untitled")}</span>
                          </h3>
                          {taskStatusLabel ? (
                            <span className="documents-group-status badge" aria-label={t("documents.taskStatusAria", "Task status: {{status}}", { status: taskStatusLabel })}>
                              <span className={taskStatusDotClass} aria-hidden="true" />
                              <span>{taskStatusLabel}</span>
                            </span>
                          ) : null}
                        </div>
                        <div className="documents-task-sidebar-actions">
                          <span className="documents-group-count">{t("documents.docCount", "{{count}} doc{{plural}}", { count: taskDocs.length, plural: taskDocs.length !== 1 ? "s" : "" })}</span>
                          <button
                            className="documents-group-task-link"
                            onClick={() => void handleOpenTask(taskId)}
                            aria-label={t("documents.openTaskAria", "Open task {{taskId}}: {{title}}", { taskId, title: taskTitle || t("documents.untitled", "Untitled") })}
                          >
                            {t("documents.openTask", "Open task")}
                          </button>
                        </div>
                      </div>
                      <ul className="markdown-file-list documents-task-document-list">
                        {taskDocs.map((doc) => {
                          const isSelected = selectedTaskDocument?.id === doc.id;
                          return (
                            <li key={doc.id} className="markdown-file-list-item">
                              <button
                                className={`markdown-file-item documents-task-document-item${isSelected ? " markdown-file-item--selected" : ""}`}
                                onClick={() => handleSelectTaskDocument(doc.id)}
                                aria-label={t("documents.openTaskDocument", "Open {{taskId}} {{key}}", { taskId: doc.taskId, key: doc.key })}
                                aria-current={isSelected ? "true" : undefined}
                              >
                                <span className="markdown-file-item-name">{doc.key}</span>
                                <span className="markdown-file-item-path">{doc.taskId} · {doc.taskTitle || t("documents.untitled", "Untitled")}</span>
                                <span className="markdown-file-item-meta">
                                  {t("documents.revisionShort", "v{{revision}}", { revision: doc.revision })} · {doc.author} · {formatTimestamp(doc.updatedAt)}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </aside>
            )}

            {(!isMobile || selectedTaskDocument) && (
              <section className="documents-view-main" aria-label={t("documents.taskDocumentPreviewLabel", "Task document content preview")}>
                {isMobile && selectedTaskDocument && (
                  <button
                    className="btn btn-sm documents-mobile-back"
                    onClick={handleBackToTaskDocumentList}
                    aria-label={t("documents.backToTaskDocumentsList", "Back to task documents list")}
                  >
                    <ArrowLeft size={14} />
                    {t("documents.backToTaskDocuments", "Back to documents")}
                  </button>
                )}

                {!selectedTaskDocument ? (
                  <div className="documents-view-empty">
                    <p>{t("documents.selectTaskDocument", "Select a task document to view its content.")}</p>
                  </div>
                ) : (
                  <div className="documents-content-viewer documents-task-document-viewer">
                    <div className="documents-content-header documents-task-document-header">
                      <div className="documents-task-document-title-block">
                        <p className="documents-file-path-header">{selectedTaskDocument.taskId} / {selectedTaskDocument.key}</p>
                        <div className="document-card-meta documents-task-document-meta">
                          <span className="document-card-author">{selectedTaskDocument.author}</span>
                          <span className="document-card-separator">·</span>
                          <span>{t("documents.revisionShort", "v{{revision}}", { revision: selectedTaskDocument.revision })}</span>
                          <span className="document-card-separator">·</span>
                          <span className="document-card-date">{formatTimestamp(selectedTaskDocument.updatedAt)}</span>
                        </div>
                      </div>
                      <button
                        className="btn btn-sm document-mode-toggle"
                        onClick={() => handleToggleTaskDocMarkdown(selectedTaskDocument.id)}
                        aria-label={selectedTaskDocumentRendersMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                        aria-pressed={selectedTaskDocumentRendersMarkdown}
                        title={selectedTaskDocumentRendersMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                      >
                        {selectedTaskDocumentRendersMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
                      </button>
                    </div>
                    {selectedTaskDocumentRendersMarkdown ? (
                      <div ref={taskDocMarkdownPreviewRef} className="documents-content-markdown">
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedTaskDocument.content}</ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <pre ref={taskDocPlainPreviewRef} className="document-card-content-text documents-content-viewer-text">{selectedTaskDocument.content}</pre>
                    )}
                    {taskDocumentSelectionPopover}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
