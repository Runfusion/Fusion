import "./DocumentsView.css";
import { useState, useMemo, useCallback, useEffect, useRef, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, AudioLines, Download, ExternalLink, FileText, FileType, Image as ImageIcon, Package, Pencil, RefreshCw, Search, Video, X, Eye, EyeOff } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ArtifactWithTask, ColumnId, TaskDocumentWithTask, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { artifactMediaUrl, fetchArtifact, fetchTaskDetail, fetchWorkspaceFileContent, putTaskDocument, saveWorkspaceFileContent, type MarkdownFileEntry } from "../api";
import { useArtifacts } from "../hooks/useArtifacts";
import { useDocuments } from "../hooks/useDocuments";
import { useProjectMarkdownFiles } from "../hooks/useProjectMarkdownFiles";
import { useSelectionComment } from "../hooks/useSelectionComment";
import { SelectionCommentPopover } from "./SelectionCommentPopover";
import { FileEditor } from "./FileEditor";
import { LoadingSpinner } from "./LoadingSpinner";
import { ArtifactsGallery, getArtifactCategory, type ArtifactCategory } from "./ArtifactsGallery";
import { ViewHeader } from "./ViewHeader";
import { useColumnLabel } from "../i18n/labels";

const MOBILE_BREAKPOINT = 768;

type DocumentsTab = "project" | "tasks" | "artifacts";
type SelectedTaskItem = { kind: "document" | "artifact"; id: string };

type GroupedTaskItems = {
  taskId: string;
  taskTitle?: string;
  taskColumn?: string;
  documents: TaskDocumentWithTask[];
  artifacts: ArtifactWithTask[];
  latestUpdated: string;
};

const TASK_ARTIFACT_CATEGORY_ICONS: Record<ArtifactCategory, typeof ImageIcon> = {
  image: ImageIcon,
  doc: FileText,
  pdf: FileType,
  video: Video,
  audio: AudioLines,
  other: Package,
};

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

function getTaskArtifactCategoryLabel(t: TFunction<"app">, category: ArtifactCategory): string {
  switch (category) {
    case "image": return t("documents.artifactCategoryImage", "Image");
    case "doc": return t("documents.artifactCategoryDoc", "Document");
    case "pdf": return t("documents.artifactCategoryPdf", "PDF");
    case "video": return t("documents.artifactCategoryVideo", "Video");
    case "audio": return t("documents.artifactCategoryAudioSingle", "Audio");
    case "other": return t("documents.artifactCategoryOtherSingle", "Other");
  }
}

function artifactMatchesTaskSearch(artifact: ArtifactWithTask, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [artifact.title, artifact.description, artifact.taskId, artifact.taskTitle, artifact.mimeType, artifact.authorId]
    .some((value) => value?.toLowerCase().includes(normalizedQuery));
}

function artifactHasInlineText(artifact: Pick<ArtifactWithTask | Artifact, "content" | "mimeType" | "type">): boolean {
  const mime = artifact.mimeType?.toLowerCase().split(";", 1)[0] ?? "";
  return Boolean(artifact.content) || artifact.type === "document" || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
}

interface TaskArtifactInlineViewerProps {
  artifact: ArtifactWithTask;
  projectId?: string;
  content: string | null;
  loading: boolean;
  error: string | null;
  renderMarkdown: boolean;
  onToggleMarkdown: () => void;
  onOpenTask: (taskId: string) => void;
  t: TFunction<"app">;
}

function TaskArtifactInlineViewer({ artifact, projectId, content, loading, error, renderMarkdown, onToggleMarkdown, onOpenTask, t }: TaskArtifactInlineViewerProps) {
  const [mediaError, setMediaError] = useState<string | null>(null);
  const category = getArtifactCategory(artifact);
  const categoryLabel = getTaskArtifactCategoryLabel(t, category);
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const mediaUrl = artifactMediaUrl(artifact.id, projectId);
  const hasInlineText = category === "doc" && artifactHasInlineText(artifact);

  useEffect(() => {
    setMediaError(null);
  }, [artifact.id]);

  const mediaErrorNode = mediaError ? <p className="documents-content-state documents-content-state--error">{mediaError}</p> : null;

  const body = (() => {
    if (category === "image") {
      return <>{mediaErrorNode}<img className="documents-task-artifact-media" src={mediaUrl} alt={title} onError={() => setMediaError(t("documents.artifactMediaFailed", "Failed to load artifact preview."))} /></>;
    }
    if (category === "video") {
      return <>{mediaErrorNode}<video className="documents-task-artifact-media" controls src={mediaUrl} aria-label={t("documents.videoArtifactLabel", "Video artifact: {{title}}", { title })} onError={() => setMediaError(t("documents.artifactMediaFailed", "Failed to load artifact preview."))} /></>;
    }
    if (category === "audio") {
      return <>{mediaErrorNode}<audio className="documents-task-artifact-audio" controls src={mediaUrl} aria-label={t("documents.audioArtifactLabel", "Audio artifact: {{title}}", { title })} onError={() => setMediaError(t("documents.artifactMediaFailed", "Failed to load artifact preview."))} /></>;
    }
    if (category === "pdf") {
      return (
        <div className="documents-task-artifact-pdf">
          <iframe title={t("documents.pdfArtifactTitle", "PDF artifact: {{title}}", { title })} src={mediaUrl} />
          <a className="btn btn-sm" href={mediaUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />
            {t("documents.openInNewTab", "Open in new tab")}
          </a>
        </div>
      );
    }
    if (category === "doc" && hasInlineText) {
      if (loading) {
        return <p className="documents-content-state"><LoadingSpinner label={t("documents.loadingArtifactContent", "Loading artifact content…")} /></p>;
      }
      if (error) {
        return <p className="documents-content-state documents-content-state--error">{error}</p>;
      }
      if (renderMarkdown) {
        return (
          <div className="documents-content-markdown documents-task-artifact-doc-content">
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content ?? artifact.content ?? ""}</ReactMarkdown>
            </div>
          </div>
        );
      }
      return <pre className="document-card-content-text documents-content-viewer-text documents-task-artifact-doc-content">{content ?? artifact.content ?? ""}</pre>;
    }

    return (
      <div className="documents-task-artifact-download">
        <Package size={24} aria-hidden="true" />
        <p>{artifact.description || t("documents.binaryArtifactFallback", "This artifact cannot be previewed inline.")}</p>
        <a className="btn btn-sm" href={mediaUrl} target="_blank" rel="noreferrer" data-testid="task-artifact-open-link">
          <Download size={14} aria-hidden="true" />
          {t("documents.openArtifact", "Open artifact")}
        </a>
      </div>
    );
  })();

  return (
    <div className="documents-content-viewer documents-task-artifact-viewer">
      <div className="documents-content-header documents-task-document-header">
        <p className="documents-file-path-header">{artifact.taskId} / {title}</p>
        {category === "doc" && hasInlineText ? (
          <button
            className="btn btn-sm document-mode-toggle"
            onClick={onToggleMarkdown}
            aria-label={renderMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
            aria-pressed={renderMarkdown}
            title={renderMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
          >
            {renderMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
          </button>
        ) : null}
      </div>
      <div className="document-card-meta documents-task-document-meta documents-task-artifact-meta">
        <span>{categoryLabel}</span>
        <span className="document-card-separator">·</span>
        <span>{artifact.authorId || t("documents.unknownAuthor", "unknown")}</span>
        <span className="document-card-separator">·</span>
        <span>{formatTimestamp(artifact.updatedAt)}</span>
        {artifact.taskId ? (
          <>
            <span className="document-card-separator">·</span>
            <button className="documents-task-artifact-open-task" onClick={() => void onOpenTask(artifact.taskId!)}>
              {t("documents.openTask", "Open task")}
            </button>
          </>
        ) : null}
      </div>
      {artifact.description ? <p className="documents-task-artifact-description">{artifact.description}</p> : null}
      <div className={`documents-task-artifact-preview documents-task-artifact-preview--${category}`}>
        {body}
      </div>
    </div>
  );
}

export function DocumentsView({ projectId, addToast, onOpenDetail, onOpenArtifactTaskDetail, onSendSelectionToTask }: DocumentsViewProps) {
  const { t } = useTranslation("app");
  // FNXC:ArtifactsView 2026-07-11-11:30: Artifacts is the first tab and the landing tab — the view is the artifact gallery first, with project files and task documents as secondary tabs.
  const [activeTab, setActiveTab] = useState<DocumentsTab>("artifacts");
  const columnLabel = useColumnLabel();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<MarkdownFileEntry | null>(null);
  /*
  FNXC:DocumentsView 2026-07-11-22:04:
  FN-7845 makes the Task Documents sidebar a mixed task-output list, so selection must be discriminated by document vs artifact. Keep this state separate from Project Files' selectedFile to preserve tab isolation and prevent artifact previews from enabling document editing or select-to-comment.
  */
  const [selectedTaskItem, setSelectedTaskItem] = useState<SelectedTaskItem | null>(null);
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
  /*
  FNXC:DocumentsView 2026-07-11-14:45:
  Markdown render toggles per task document card (scoped by doc ID). Operator requirement: task documents default to the RENDERED MARKDOWN view (not plain text) — the map only stores explicit toggles away from that default, so every `?? true` fallback here and in the toggle handler must stay in sync.
  */
  const [taskDocMarkdownStates, setTaskDocMarkdownStates] = useState<Map<string, boolean>>(new Map());
  /*
  FNXC:DocumentsView 2026-07-11-13:40:
  Operator requirement: task documents in the Artifacts view must be editable in place with the same CodeMirror FileEditor used for workspace files and artifact docs — the FN-7811 read-only pane is not enough. Editing state is scoped to the selected document ID so switching documents, tabs, or projects can never save a draft against the wrong document; the draft lives here (not in FileEditor) so Save can PUT it via putTaskDocument and refresh the SWR document list.
  */
  const [editingTaskDocumentId, setEditingTaskDocumentId] = useState<string | null>(null);
  const [taskDocDraft, setTaskDocDraft] = useState("");
  const [taskDocSaving, setTaskDocSaving] = useState(false);
  const [artifactDocContent, setArtifactDocContent] = useState<string | null>(null);
  const [artifactDocLoading, setArtifactDocLoading] = useState(false);
  const [artifactDocError, setArtifactDocError] = useState<string | null>(null);
  const [renderArtifactMarkdown, setRenderArtifactMarkdown] = useState(true);
  const artifactDocRequestIdRef = useRef(0);
  /*
  FNXC:DocumentsView 2026-07-11-14:45:
  Operator requirement: Project Files must be editable in place too (same CodeMirror FileEditor), replacing the former Read-only badge contract. Saves go through the workspace file API for the "project" workspace and update the local preview content on success.
  */
  const [editingProjectFile, setEditingProjectFile] = useState(false);
  const [projectFileDraft, setProjectFileDraft] = useState("");
  const [projectFileSaving, setProjectFileSaving] = useState(false);
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
    setSelectedTaskItem(null);
    setShowHiddenProjectFiles(false);
    setFileContent(null);
    setFileError(null);
    setFileLoading(false);
    setRenderProjectMarkdown(false);
    setTaskDocMarkdownStates(new Map());
    setEditingTaskDocumentId(null);
    setTaskDocDraft("");
    setTaskDocSaving(false);
    setArtifactDocContent(null);
    setArtifactDocLoading(false);
    setArtifactDocError(null);
    setRenderArtifactMarkdown(true);
    setEditingProjectFile(false);
    setProjectFileDraft("");
    setProjectFileSaving(false);
  }, [projectId]);

  const groupedTaskItems = useMemo<GroupedTaskItems[]>(() => {
    const normalizedQuery = taskSearchQuery.toLowerCase();
    const groups = new Map<string, { documents: TaskDocumentWithTask[]; artifacts: ArtifactWithTask[] }>();

    for (const doc of documents) {
      const existing = groups.get(doc.taskId) ?? { documents: [], artifacts: [] };
      existing.documents.push(doc);
      groups.set(doc.taskId, existing);
    }

    /*
    FNXC:DocumentsView 2026-07-11-22:04:
    FN-7845 requires the Task Documents list to be a union of task documents and task-scoped registered artifacts, so operators see all outputs for a task in one grouped sidebar. Registry artifacts without taskId remain exclusive to the standalone Artifacts tab because they cannot be safely attached to a task group.
    */
    for (const artifact of artifacts) {
      if (!artifact.taskId || !artifactMatchesTaskSearch(artifact, normalizedQuery)) {
        continue;
      }
      const existing = groups.get(artifact.taskId) ?? { documents: [], artifacts: [] };
      existing.artifacts.push(artifact);
      groups.set(artifact.taskId, existing);
    }

    return Array.from(groups.entries())
      .map(([taskId, group]) => {
        const sortedDocs = [...group.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const sortedArtifacts = [...group.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const latestUpdated = [sortedDocs[0]?.updatedAt, sortedArtifacts[0]?.updatedAt].filter(Boolean).sort().at(-1) ?? "";
        const titleSource = sortedDocs.find((doc) => doc.taskTitle)?.taskTitle ?? sortedArtifacts.find((artifact) => artifact.taskTitle)?.taskTitle;

        return {
          taskId,
          taskTitle: titleSource,
          /*
          FNXC:DocumentsView 2026-07-02-00:00:
          Task document groups must surface the parent task completion state in the header so operators can identify done work without expanding documents or opening task details. Use the first available column from grouped documents or artifacts because legacy rows may omit taskColumn.
          */
          taskColumn: sortedDocs.find((doc) => doc.taskColumn)?.taskColumn ?? sortedArtifacts.find((artifact) => artifact.taskColumn)?.taskColumn,
          documents: sortedDocs,
          artifacts: sortedArtifacts,
          latestUpdated,
        };
      })
      .filter((group) => group.documents.length > 0 || group.artifacts.length > 0)
      .sort((a, b) => b.latestUpdated.localeCompare(a.latestUpdated));
  }, [artifacts, documents, taskSearchQuery]);


  /*
  FNXC:DocumentsView 2026-07-10-17:30:
  Task Documents now mirrors the Project Files sidebar/right-pane contract: the task-document selection is deliberately separate from selectedFile so tab switching cannot leak project file content into the Task Documents pane. Task Documents keeps its own Plain/Markdown render toggle so Project Files state never controls task-document rendering.

  FNXC:DocumentsView 2026-07-10-23:41:
  FN-7812 extends the existing select-to-comment affordance to the Task Documents right pane without a new comment model. The active task-document selection ref follows the same Plain/Markdown toggle, and the composed source path uses taskId/key so operators can identify the originating task document. Keep Task Documents gated by selectedTaskDocument and Project Files gated by selectedFile so tab switches cannot cross-render popovers; the shared composer-open lock is safe because only one tab pane is mounted at a time.
  */
  const selectedTaskDocument = useMemo(() => {
    if (selectedTaskItem?.kind !== "document") {
      return null;
    }

    return documents.find((doc) => doc.id === selectedTaskItem.id) ?? null;
  }, [documents, selectedTaskItem]);

  const selectedTaskArtifact = useMemo(() => {
    if (selectedTaskItem?.kind !== "artifact") {
      return null;
    }

    return artifacts.find((artifact) => artifact.id === selectedTaskItem.id) ?? null;
  }, [artifacts, selectedTaskItem]);

  const selectedTaskOutput = selectedTaskDocument ?? selectedTaskArtifact;

  useEffect(() => {
    if (!selectedTaskItem) {
      return;
    }

    const selectionStillVisible = groupedTaskItems.some((group) => (
      selectedTaskItem.kind === "document"
        ? group.documents.some((doc) => doc.id === selectedTaskItem.id)
        : group.artifacts.some((artifact) => artifact.id === selectedTaskItem.id)
    ));
    if (!selectionStillVisible) {
      setSelectedTaskItem(null);
      setEditingTaskDocumentId(null);
      setTaskDocDraft("");
      setArtifactDocContent(null);
      setArtifactDocLoading(false);
      setArtifactDocError(null);
    }
  }, [groupedTaskItems, selectedTaskItem]);

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
      setSelectedTaskItem(null);
      setEditingTaskDocumentId(null);
      setTaskDocDraft("");
      setArtifactDocContent(null);
      setArtifactDocLoading(false);
      setArtifactDocError(null);
    }
    if (tab !== "project") {
      setEditingProjectFile(false);
      setProjectFileDraft("");
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
    setEditingProjectFile(false);
    setProjectFileDraft("");

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
    setEditingProjectFile(false);
    setProjectFileDraft("");
  }, []);

  const handleStartProjectFileEdit = useCallback(() => {
    if (fileContent === null) return;
    setProjectFileDraft(fileContent);
    setEditingProjectFile(true);
  }, [fileContent]);

  const handleCancelProjectFileEdit = useCallback(() => {
    setEditingProjectFile(false);
    setProjectFileDraft("");
  }, []);

  const handleSaveProjectFileEdit = useCallback(async () => {
    if (!selectedFile) return;
    setProjectFileSaving(true);
    try {
      await saveWorkspaceFileContent("project", selectedFile.path, projectFileDraft, projectId);
      setFileContent(projectFileDraft);
      setEditingProjectFile(false);
      setProjectFileDraft("");
      addToast(t("documents.projectFileSaved", "File saved"), "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setProjectFileSaving(false);
    }
  }, [selectedFile, projectFileDraft, projectId, addToast, t]);

  const handleSelectTaskDocument = useCallback((docId: string) => {
    setSelectedTaskItem({ kind: "document", id: docId });
    setEditingTaskDocumentId(null);
    setTaskDocDraft("");
    setArtifactDocContent(null);
    setArtifactDocLoading(false);
    setArtifactDocError(null);
  }, []);

  const handleSelectTaskArtifact = useCallback((artifactId: string) => {
    setSelectedTaskItem({ kind: "artifact", id: artifactId });
    setEditingTaskDocumentId(null);
    setTaskDocDraft("");
    setArtifactDocContent(null);
    setArtifactDocError(null);
    setRenderArtifactMarkdown(true);
  }, []);

  const handleBackToTaskDocumentList = useCallback(() => {
    setSelectedTaskItem(null);
    setEditingTaskDocumentId(null);
    setTaskDocDraft("");
    setArtifactDocContent(null);
    setArtifactDocLoading(false);
    setArtifactDocError(null);
  }, []);

  const handleToggleTaskDocMarkdown = useCallback((docId: string) => {
    setTaskDocMarkdownStates((prev) => {
      const next = new Map(prev);
      const current = next.get(docId) ?? true;
      next.set(docId, !current);
      return next;
    });
  }, []);

  const handleStartTaskDocEdit = useCallback(() => {
    if (!selectedTaskDocument) return;
    setTaskDocDraft(selectedTaskDocument.content);
    setEditingTaskDocumentId(selectedTaskDocument.id);
  }, [selectedTaskDocument]);

  const handleCancelTaskDocEdit = useCallback(() => {
    setEditingTaskDocumentId(null);
    setTaskDocDraft("");
  }, []);

  const handleSaveTaskDocEdit = useCallback(async () => {
    if (!selectedTaskDocument) return;
    setTaskDocSaving(true);
    try {
      await putTaskDocument(selectedTaskDocument.taskId, selectedTaskDocument.key, taskDocDraft, {}, projectId);
      await refreshDocuments();
      setEditingTaskDocumentId(null);
      setTaskDocDraft("");
      addToast(t("documents.taskDocumentSaved", "Document saved"), "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setTaskDocSaving(false);
    }
  }, [selectedTaskDocument, taskDocDraft, projectId, refreshDocuments, addToast, t]);

  useEffect(() => {
    if (!selectedTaskArtifact || getArtifactCategory(selectedTaskArtifact) !== "doc") {
      setArtifactDocContent(null);
      setArtifactDocLoading(false);
      setArtifactDocError(null);
      return;
    }

    const requestId = artifactDocRequestIdRef.current + 1;
    artifactDocRequestIdRef.current = requestId;
    setArtifactDocLoading(true);
    setArtifactDocError(null);
    setArtifactDocContent(null);

    void fetchArtifact(selectedTaskArtifact.id, projectId)
      .then((artifact) => {
        if (artifactDocRequestIdRef.current !== requestId) return;
        setArtifactDocContent(artifact.content ?? selectedTaskArtifact.content ?? "");
      })
      .catch((err) => {
        if (artifactDocRequestIdRef.current !== requestId) return;
        setArtifactDocError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (artifactDocRequestIdRef.current === requestId) {
          setArtifactDocLoading(false);
        }
      });
  }, [projectId, selectedTaskArtifact]);

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

  const activeCount = activeTab === "project" ? filteredProjectFiles.length : activeTab === "tasks" ? groupedTaskItems.length : artifacts.length;
  const selectedTaskDocumentRendersMarkdown = selectedTaskDocument ? (taskDocMarkdownStates.get(selectedTaskDocument.id) ?? true) : false;
  const activeTaskDocumentSelection = selectedTaskDocumentRendersMarkdown ? taskDocMarkdownSelection : taskDocPlainSelection;
  const editingSelectedTaskDocument = selectedTaskDocument !== null && editingTaskDocumentId === selectedTaskDocument.id;
  const selectionPopover = activeTab === "project" && selectedFile && !editingProjectFile && onSendSelectionToTask && activeProjectSelection ? (
    <SelectionCommentPopover
      selectedText={activeProjectSelection.selectedText}
      anchorRect={activeProjectSelection.anchorRect}
      filePath={selectedFile.path}
      onSubmit={onSendSelectionToTask}
      onOpenChange={setSelectionCommentOpen}
    />
  ) : null;
  const taskDocumentSelectionPopover = activeTab === "tasks" && selectedTaskDocument && !editingSelectedTaskDocument && onSendSelectionToTask && activeTaskDocumentSelection ? (
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
              <span className="documents-tab-count">{groupedTaskItems.length}</span>
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
                        FNXC:DocumentsView 2026-07-11-14:45:
                        Operator requirement: Project Files are editable in place with the shared CodeMirror FileEditor, replacing the former Read-only badge contract (the FN-7810-era badge said "editing happens elsewhere"; it now happens here). While editing, the Markdown/Plain toggle is replaced by Cancel/Save and select-to-comment is suppressed.
                        */}
                        <div className="documents-task-document-actions">
                          {editingProjectFile ? (
                            <>
                              <button className="btn btn-sm" onClick={handleCancelProjectFileEdit} disabled={projectFileSaving}>
                                {t("documents.cancelEdit", "Cancel")}
                              </button>
                              <button className="btn btn-sm btn-primary" onClick={() => void handleSaveProjectFileEdit()} disabled={projectFileSaving}>
                                {projectFileSaving ? t("documents.saving", "Saving…") : t("documents.saveProjectFile", "Save")}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="btn btn-sm document-mode-toggle"
                                onClick={() => setRenderProjectMarkdown((prev) => !prev)}
                                aria-label={renderProjectMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                                aria-pressed={renderProjectMarkdown}
                                title={renderProjectMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                              >
                                {renderProjectMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
                              </button>
                              <button
                                className="btn btn-sm"
                                onClick={handleStartProjectFileEdit}
                                disabled={fileLoading || fileError !== null || fileContent === null}
                                aria-label={t("documents.editProjectFile", "Edit project file")}
                              >
                                <Pencil size={14} aria-hidden="true" />
                                {t("documents.edit", "Edit")}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {fileLoading ? (
                        <p className="documents-content-state"><LoadingSpinner label={t("documents.loadingFileContent", "Loading file content…")} /></p>
                      ) : fileError ? (
                        <p className="documents-content-state documents-content-state--error">{fileError}</p>
                      ) : editingProjectFile ? (
                        <div className="documents-task-document-editor" aria-label={t("documents.projectFileContentEditor", "Project file content editor")}>
                          <FileEditor
                            content={projectFileDraft}
                            onChange={setProjectFileDraft}
                            filePath={selectedFile.path}
                            forceToolbarActionsVisible
                          />
                        </div>
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
        ) : groupedTaskItems.length === 0 ? (
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
          FN-7811 requires Task Documents to use the same desktop two-pane and mobile list→detail→back gating as Project Files; FN-7845 extends the selected detail to document OR artifact outputs while keeping the list-first mobile flow.
          */
          <div className={`documents-project-layout documents-task-documents-layout${isMobile ? " documents-project-layout--mobile" : ""}`}>
            {(!isMobile || !selectedTaskOutput) && (
              <aside className="documents-view-sidebar documents-task-documents-sidebar" aria-label={t("documents.taskDocumentsListLabel", "Task documents")}>
                {groupedTaskItems.map(({ taskId, taskTitle, taskColumn, documents: taskDocs, artifacts: taskArtifacts }) => {
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
                          <span className="documents-group-count">{t("documents.taskOutputCount", "{{docCount}} doc{{docPlural}} · {{artifactCount}} artifact{{artifactPlural}}", { docCount: taskDocs.length, docPlural: taskDocs.length !== 1 ? "s" : "", artifactCount: taskArtifacts.length, artifactPlural: taskArtifacts.length !== 1 ? "s" : "" })}</span>
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
                            <li key={`document-${doc.id}`} className="markdown-file-list-item">
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
                        {taskArtifacts.length > 0 ? (
                          <li className="documents-task-artifacts-subsection" aria-label={t("documents.taskArtifactsSubsection", "Task artifacts")}>
                            <div className="documents-task-artifacts-label">{t("documents.taskArtifactsLabel", "Artifacts")}</div>
                            <ul className="markdown-file-list documents-task-artifact-list">
                              {taskArtifacts.map((artifact) => {
                                const category = getArtifactCategory(artifact);
                                const Icon = TASK_ARTIFACT_CATEGORY_ICONS[category];
                                const categoryLabel = getTaskArtifactCategoryLabel(t, category);
                                const isSelected = selectedTaskArtifact?.id === artifact.id;
                                return (
                                  <li key={`artifact-${artifact.id}`} className="markdown-file-list-item">
                                    <button
                                      className={`markdown-file-item documents-task-document-item documents-task-artifact-item${isSelected ? " markdown-file-item--selected" : ""}`}
                                      onClick={() => handleSelectTaskArtifact(artifact.id)}
                                      aria-label={t("documents.openTaskArtifact", "Open {{taskId}} artifact {{title}}", { taskId, title: artifact.title || t("documents.untitledArtifact", "Untitled artifact") })}
                                      aria-current={isSelected ? "true" : undefined}
                                    >
                                      <span className="documents-task-artifact-title-row">
                                        <Icon size={14} aria-hidden="true" />
                                        <span className="markdown-file-item-name">{artifact.title || t("documents.untitledArtifact", "Untitled artifact")}</span>
                                      </span>
                                      <span className="markdown-file-item-path">{categoryLabel} · {artifact.mimeType || artifact.type}</span>
                                      <span className="markdown-file-item-meta">
                                        {artifact.authorId || t("documents.unknownAuthor", "unknown")} · {formatTimestamp(artifact.updatedAt)}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </li>
                        ) : null}
                      </ul>
                    </section>
                  );
                })}
              </aside>
            )}

            {(!isMobile || selectedTaskOutput) && (
              <section className="documents-view-main" aria-label={t("documents.taskDocumentPreviewLabel", "Task document content preview")}>
                {isMobile && selectedTaskOutput && (
                  <button
                    className="btn btn-sm documents-mobile-back"
                    onClick={handleBackToTaskDocumentList}
                    aria-label={t("documents.backToTaskDocumentsList", "Back to task documents list")}
                  >
                    <ArrowLeft size={14} />
                    {t("documents.backToTaskDocuments", "Back to documents")}
                  </button>
                )}

                {!selectedTaskOutput ? (
                  <div className="documents-view-empty">
                    <p>{t("documents.selectTaskDocument", "Select a task document or artifact to view its content.")}</p>
                  </div>
                ) : selectedTaskArtifact ? (
                  <TaskArtifactInlineViewer
                    artifact={selectedTaskArtifact}
                    projectId={projectId}
                    content={artifactDocContent}
                    loading={artifactDocLoading}
                    error={artifactDocError}
                    renderMarkdown={renderArtifactMarkdown}
                    onToggleMarkdown={() => setRenderArtifactMarkdown((prev) => !prev)}
                    onOpenTask={handleOpenArtifactTask}
                    t={t}
                  />
                ) : selectedTaskDocument ? (
                  <div className="documents-content-viewer documents-task-document-viewer">
                    {/*
                    FNXC:DocumentsView 2026-07-11-14:30:
                    The header actions (Plain/Edit, or Cancel/Save while editing) must sit on the same row as the document path box, vertically centered against it — when the path and the author/revision meta shared a title-block column, the actions centered on the two-row block and rendered visibly below the path box's midline (user-reported misalignment). The meta line now renders below the path+actions row at full width.
                    */}
                    <div className="documents-content-header documents-task-document-header">
                      <p className="documents-file-path-header">{selectedTaskDocument.taskId} / {selectedTaskDocument.key}</p>
                      {/*
                      FNXC:DocumentsView 2026-07-11-13:40:
                      Operator requirement: task documents must be editable in place from the Artifacts view with the shared CodeMirror FileEditor (not a plain textarea, and not read-only). While editing, the Markdown/Plain toggle is replaced by Cancel/Save (FileEditor carries its own Edit/Preview toolbar for markdown) and select-to-comment is suppressed so the composer lock cannot fight the editor selection.
                      */}
                      <div className="documents-task-document-actions">
                        {editingSelectedTaskDocument ? (
                          <>
                            <button className="btn btn-sm" onClick={handleCancelTaskDocEdit} disabled={taskDocSaving}>
                              {t("documents.cancelEdit", "Cancel")}
                            </button>
                            <button className="btn btn-sm btn-primary" onClick={() => void handleSaveTaskDocEdit()} disabled={taskDocSaving}>
                              {taskDocSaving ? t("documents.saving", "Saving…") : t("documents.saveTaskDocument", "Save")}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-sm document-mode-toggle"
                              onClick={() => handleToggleTaskDocMarkdown(selectedTaskDocument.id)}
                              aria-label={selectedTaskDocumentRendersMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                              aria-pressed={selectedTaskDocumentRendersMarkdown}
                              title={selectedTaskDocumentRendersMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown")}
                            >
                              {selectedTaskDocumentRendersMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain")}
                            </button>
                            <button className="btn btn-sm" onClick={handleStartTaskDocEdit} aria-label={t("documents.editTaskDocument", "Edit task document")}>
                              <Pencil size={14} aria-hidden="true" />
                              {t("documents.edit", "Edit")}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="document-card-meta documents-task-document-meta">
                      <span className="document-card-author">{selectedTaskDocument.author}</span>
                      <span className="document-card-separator">·</span>
                      <span>{t("documents.revisionShort", "v{{revision}}", { revision: selectedTaskDocument.revision })}</span>
                      <span className="document-card-separator">·</span>
                      <span className="document-card-date">{formatTimestamp(selectedTaskDocument.updatedAt)}</span>
                    </div>
                    {editingSelectedTaskDocument ? (
                      <div className="documents-task-document-editor" aria-label={t("documents.taskDocumentContentEditor", "Task document content editor")}>
                        <FileEditor
                          content={taskDocDraft}
                          onChange={setTaskDocDraft}
                          filePath={selectedTaskDocument.key.includes(".") ? selectedTaskDocument.key : `${selectedTaskDocument.key}.md`}
                          forceToolbarActionsVisible
                        />
                      </div>
                    ) : selectedTaskDocumentRendersMarkdown ? (
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
                ) : null}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
