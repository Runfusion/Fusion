import "./ArtifactsGallery.css";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AudioLines,
  Download,
  ExternalLink,
  FileText,
  FileType,
  Image as ImageIcon,
  Package,
  Pencil,
  Video,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, ArtifactWithTask } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { artifactMediaUrl, artifactMediaUrlWithToken, fetchArtifact, updateArtifact } from "../api";
import { withTokenHeader } from "../auth";
import { FileEditor } from "./FileEditor";
import { FloatingWindow } from "./FloatingWindow";
import { NavigationHistoryContext } from "../hooks/useNavigationHistory";

/*
FNXC:ArtifactRegistry 2026-07-10-15:40:
The Artifacts view is the shop window for agent-produced work (screenshots, wireframes, mockups, docs, recordings), so it breaks artifacts into content categories the operator thinks in — Images, Docs, PDFs, Videos, Audio, Other — instead of raw registry types (PDFs are stored as document/other rows). Each category gets a tailored experience:
- Images/Videos: visual-first tile grid with hover metadata and a full-size lightbox.
- Docs: reading cards that open a full document viewer with rendered markdown and an in-place EDIT mode (any inline-content doc is editable; binary-backed docs stay read-only).
- PDFs: dedicated tiles opening an embedded PDF viewer with an open-in-tab escape hatch.
- Audio: inline player rows.
- Other: compact download rows.
"All" renders sections per present category; chips filter to one. Everything must scale down to the 768px/short-landscape mobile breakpoint: chips scroll horizontally, grids collapse, and viewers go full-screen.
*/

export type ArtifactCategory = "image" | "doc" | "pdf" | "video" | "audio" | "other";
type ArtifactCategoryFilter = ArtifactCategory | "all";

export const ARTIFACT_CATEGORY_ORDER: ArtifactCategory[] = ["image", "doc", "pdf", "video", "audio", "other"];

export function getArtifactCategory(artifact: Pick<ArtifactWithTask, "type" | "mimeType" | "uri">): ArtifactCategory {
  const mime = artifact.mimeType?.toLowerCase().split(";", 1)[0] ?? "";
  if (mime === "application/pdf" || artifact.uri?.toLowerCase().endsWith(".pdf")) return "pdf";
  if (artifact.type === "image") return "image";
  if (artifact.type === "video") return "video";
  if (artifact.type === "audio") return "audio";
  if (artifact.type === "document") return "doc";
  return "other";
}

const CATEGORY_ICONS: Record<ArtifactCategory, typeof ImageIcon> = {
  image: ImageIcon,
  doc: FileText,
  pdf: FileType,
  video: Video,
  audio: AudioLines,
  other: Package,
};

function getCategoryLabel(t: TFunction<"app">, category: ArtifactCategory): string {
  switch (category) {
    case "image": return t("documents.artifactCategoryImages", "Images");
    case "doc": return t("documents.artifactCategoryDocs", "Docs");
    case "pdf": return t("documents.artifactCategoryPdfs", "PDFs");
    case "video": return t("documents.artifactCategoryVideos", "Videos");
    case "audio": return t("documents.artifactCategoryAudio", "Audio");
    case "other": return t("documents.artifactCategoryOther", "Other");
  }
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ArtifactsGalleryProps {
  artifacts: ArtifactWithTask[];
  projectId?: string;
  isMobile: boolean;
  addToast: (message: string, type?: ToastType) => void;
  onOpenTask: (taskId: string) => void;
  /** Optional callback fired after a successful in-place doc edit so parents can refresh lists. */
  onArtifactUpdated?: () => void;
}

interface ViewerState {
  artifact: ArtifactWithTask;
  kind: "media" | "doc" | "pdf";
}

export function ArtifactsGallery({ artifacts, projectId, isMobile, addToast, onOpenTask, onArtifactUpdated }: ArtifactsGalleryProps) {
  const { t } = useTranslation("app");
  const navigationHistory = useContext(NavigationHistoryContext);
  const [categoryFilter, setCategoryFilter] = useState<ArtifactCategoryFilter>("all");
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const viewerReturnFocusRef = useRef<HTMLElement | null>(null);

  const grouped = useMemo(() => {
    const groups = new Map<ArtifactCategory, ArtifactWithTask[]>();
    for (const artifact of artifacts) {
      const category = getArtifactCategory(artifact);
      const existing = groups.get(category);
      if (existing) {
        existing.push(artifact);
      } else {
        groups.set(category, [artifact]);
      }
    }
    return groups;
  }, [artifacts]);

  // A stale filter (its last artifact disappeared via live refresh) falls back to "all" rather than an empty gallery.
  useEffect(() => {
    if (categoryFilter !== "all" && !grouped.has(categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [categoryFilter, grouped]);

  const openViewer = useCallback((artifact: ArtifactWithTask) => {
    const category = getArtifactCategory(artifact);
    const kind: ViewerState["kind"] = category === "doc" ? "doc" : category === "pdf" ? "pdf" : "media";
    viewerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setViewer({ artifact, kind });
  }, []);

  const closeViewer = useCallback(() => {
    setViewer(null);
    viewerReturnFocusRef.current?.focus();
    viewerReturnFocusRef.current = null;
  }, []);

  /*
  FNXC:ArtifactViewerMobileBack 2026-07-16-17:00:
  A mobile artifact viewer must dismiss before navigation on iOS swipe-back, Android native Back, and browser Back.
  Register one stable modal closer for every viewer kind; nullable context keeps provider-less gallery renders working.
  Programmatic close uses removeNav to consume its pushed entry, while popstate invokes closeViewer directly without a double-back.
  */
  useEffect(() => {
    if (!isMobile || !viewer || !navigationHistory) return;
    navigationHistory.pushNav({ type: "modal", close: closeViewer });
  }, [closeViewer, isMobile, navigationHistory, viewer]);

  const dismissViewer = useCallback(() => {
    navigationHistory?.removeNav(closeViewer);
    closeViewer();
  }, [closeViewer, navigationHistory]);

  const visibleCategories = ARTIFACT_CATEGORY_ORDER.filter((category) =>
    grouped.has(category) && (categoryFilter === "all" || categoryFilter === category));

  return (
    <div className="artifacts-gallery">
      {grouped.size > 1 && (
        <div className="artifacts-gallery-filter" role="group" aria-label={t("documents.artifactTypeFilterLabel", "Filter artifacts by category")}>
          <button
            className={`btn btn-sm artifacts-gallery-chip${categoryFilter === "all" ? " active" : ""}`}
            aria-pressed={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
          >
            {t("documents.artifactFilterAll", "All")}
            <span className="artifacts-gallery-chip-count">{artifacts.length}</span>
          </button>
          {ARTIFACT_CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => {
            const Icon = CATEGORY_ICONS[category];
            return (
              <button
                key={category}
                className={`btn btn-sm artifacts-gallery-chip${categoryFilter === category ? " active" : ""}`}
                aria-pressed={categoryFilter === category}
                onClick={() => setCategoryFilter(category)}
              >
                <Icon size={14} aria-hidden="true" />
                {getCategoryLabel(t, category)}
                <span className="artifacts-gallery-chip-count">{grouped.get(category)?.length}</span>
              </button>
            );
          })}
        </div>
      )}

      {visibleCategories.map((category) => {
        const items = grouped.get(category) ?? [];
        const Icon = CATEGORY_ICONS[category];
        return (
          <section key={category} className="artifacts-gallery-section" aria-label={getCategoryLabel(t, category)}>
            {categoryFilter === "all" && grouped.size > 1 && (
              <header className="artifacts-gallery-section-header">
                <Icon size={16} aria-hidden="true" />
                <h3>{getCategoryLabel(t, category)}</h3>
                <span className="artifacts-gallery-section-count">{items.length}</span>
              </header>
            )}
            <CategoryGrid
              category={category}
              items={items}
              projectId={projectId}
              isMobile={isMobile}
              t={t}
              onOpen={openViewer}
              onOpenTask={onOpenTask}
            />
          </section>
        );
      })}

      {viewer && viewer.kind === "media" && (
        <MediaLightbox artifact={viewer.artifact} projectId={projectId} t={t} onClose={dismissViewer} onOpenTask={onOpenTask} />
      )}
      {viewer && viewer.kind === "pdf" && (
        <PdfViewer artifact={viewer.artifact} projectId={projectId} t={t} onClose={dismissViewer} onOpenTask={onOpenTask} />
      )}
      {viewer && viewer.kind === "doc" && (
        <DocViewer
          artifact={viewer.artifact}
          projectId={projectId}
          t={t}
          addToast={addToast}
          onClose={dismissViewer}
          onOpenTask={onOpenTask}
          onArtifactUpdated={onArtifactUpdated}
        />
      )}
    </div>
  );
}

interface CategoryGridProps {
  category: ArtifactCategory;
  items: ArtifactWithTask[];
  projectId?: string;
  isMobile: boolean;
  t: TFunction<"app">;
  onOpen: (artifact: ArtifactWithTask) => void;
  onOpenTask: (taskId: string) => void;
}

function CategoryGrid({ category, items, projectId, isMobile, t, onOpen, onOpenTask }: CategoryGridProps) {
  if (category === "audio") {
    return (
      <div className="artifacts-gallery-rows">
        {items.map((artifact) => (
          <AudioRow key={artifact.id} artifact={artifact} projectId={projectId} t={t} onOpenTask={onOpenTask} />
        ))}
      </div>
    );
  }

  if (category === "other") {
    return (
      <div className="artifacts-gallery-rows">
        {items.map((artifact) => (
          <FileRow key={artifact.id} artifact={artifact} projectId={projectId} t={t} onOpenTask={onOpenTask} />
        ))}
      </div>
    );
  }

  const gridClass = category === "image" || category === "video"
    ? "artifacts-gallery-grid artifacts-gallery-grid--visual"
    : "artifacts-gallery-grid artifacts-gallery-grid--cards";

  return (
    <div className={`${gridClass}${isMobile ? " artifacts-gallery-grid--mobile" : ""}`}>
      {items.map((artifact) => (
        category === "image" || category === "video"
          ? <VisualTile key={artifact.id} artifact={artifact} category={category} projectId={projectId} t={t} onOpen={onOpen} />
          : <DocCard key={artifact.id} artifact={artifact} category={category} t={t} onOpen={onOpen} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

interface TileProps {
  artifact: ArtifactWithTask;
  category: ArtifactCategory;
  projectId?: string;
  t: TFunction<"app">;
  onOpen: (artifact: ArtifactWithTask) => void;
}

function VisualTile({ artifact, category, projectId, t, onOpen }: TileProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const mediaUrl = artifactMediaUrlWithToken(artifact.id, projectId);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(artifact);
    }
  };

  return (
    <article className="artifacts-gallery-tile" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      <div
        className="artifacts-gallery-tile-media"
        role="button"
        tabIndex={0}
        aria-label={t("documents.expandArtifact", "Expand {{title}}", { title })}
        onClick={() => onOpen(artifact)}
        onKeyDown={handleKeyDown}
      >
        {category === "image" ? (
          <img src={mediaUrl} alt={title} loading="lazy" />
        ) : (
          <video src={mediaUrl} muted preload="metadata" aria-label={t("documents.artifactVideoLabel", "Video artifact: {{title}}", { title })} />
        )}
        {category === "video" && <span className="artifacts-gallery-tile-play" aria-hidden="true"><Video size={22} /></span>}
        <div className="artifacts-gallery-tile-overlay">
          <span className="artifacts-gallery-tile-title">{title}</span>
          {artifact.taskId && <span className="artifacts-gallery-tile-task">{artifact.taskId}</span>}
        </div>
      </div>
    </article>
  );
}

interface DocCardProps {
  artifact: ArtifactWithTask;
  category: ArtifactCategory;
  t: TFunction<"app">;
  onOpen: (artifact: ArtifactWithTask) => void;
  onOpenTask: (taskId: string) => void;
}

function DocCard({ artifact, category, t, onOpen, onOpenTask }: DocCardProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const Icon = CATEGORY_ICONS[category];
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(artifact);
    }
  };

  return (
    <article className="artifacts-gallery-card" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      <div
        className="artifacts-gallery-card-main"
        role="button"
        tabIndex={0}
        aria-label={t("documents.openArtifactViewer", "Open {{title}}", { title })}
        onClick={() => onOpen(artifact)}
        onKeyDown={handleKeyDown}
      >
        <div className={`artifacts-gallery-card-icon artifacts-gallery-card-icon--${category}`}>
          <Icon size={22} aria-hidden="true" />
        </div>
        <div className="artifacts-gallery-card-body">
          <h4 className="artifacts-gallery-card-title">{title}</h4>
          {artifact.description && <p className="artifacts-gallery-card-description">{artifact.description}</p>}
          <div className="artifacts-gallery-card-meta">
            <span>{artifact.authorId}</span>
            <span>·</span>
            <span>{formatTimestamp(artifact.createdAt)}</span>
            {artifact.sizeBytes !== undefined && <span>· {formatFileSize(artifact.sizeBytes)}</span>}
          </div>
        </div>
      </div>
      {artifact.taskId && (
        <button
          className="artifacts-gallery-task-link artifacts-gallery-card-task"
          onClick={() => onOpenTask(artifact.taskId as string)}
          aria-label={t("documents.openTaskAria", "Open task {{taskId}}: {{title}}", { taskId: artifact.taskId, title: artifact.taskTitle || t("documents.untitled", "Untitled") })}
        >
          {artifact.taskId}
        </button>
      )}
    </article>
  );
}

interface RowProps {
  artifact: ArtifactWithTask;
  projectId?: string;
  t: TFunction<"app">;
  onOpenTask: (taskId: string) => void;
}

function AudioRow({ artifact, projectId, t, onOpenTask }: RowProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  return (
    <article className="artifacts-gallery-row" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      <div className="artifacts-gallery-row-info">
        <AudioLines size={16} aria-hidden="true" />
        <span className="artifacts-gallery-row-title">{title}</span>
        {artifact.taskId && (
          <button className="artifacts-gallery-task-link" onClick={() => onOpenTask(artifact.taskId as string)}>
            {artifact.taskId}
          </button>
        )}
        <span className="artifacts-gallery-row-meta">{formatTimestamp(artifact.createdAt)}</span>
      </div>
      <audio className="artifacts-gallery-audio" controls src={artifactMediaUrlWithToken(artifact.id, projectId)} aria-label={t("documents.artifactAudioLabel", "Audio artifact: {{title}}", { title })} />
    </article>
  );
}

function FileRow({ artifact, projectId, t, onOpenTask }: RowProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  return (
    <article className="artifacts-gallery-row" aria-label={t("documents.artifactCardLabel", "Artifact {{title}}", { title })}>
      <div className="artifacts-gallery-row-info">
        <Package size={16} aria-hidden="true" />
        <span className="artifacts-gallery-row-title">{title}</span>
        {artifact.mimeType && <span className="artifacts-gallery-row-mime badge">{artifact.mimeType}</span>}
        {artifact.taskId && (
          <button className="artifacts-gallery-task-link" onClick={() => onOpenTask(artifact.taskId as string)}>
            {artifact.taskId}
          </button>
        )}
        <span className="artifacts-gallery-row-meta">
          {formatFileSize(artifact.sizeBytes)}{artifact.sizeBytes !== undefined ? " · " : ""}{formatTimestamp(artifact.createdAt)}
        </span>
      </div>
      <a
        className="btn btn-sm artifacts-gallery-row-download"
        href={artifactMediaUrlWithToken(artifact.id, projectId)}
        target="_blank"
        rel="noreferrer"
        data-testid="artifact-other-link"
        aria-label={t("documents.downloadArtifactAria", "Download {{title}}", { title })}
      >
        <Download size={14} aria-hidden="true" />
        {t("documents.downloadArtifact", "Download")}
      </a>
    </article>
  );
}

interface OverlayProps {
  artifact: ArtifactWithTask;
  projectId?: string;
  t: TFunction<"app">;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

function useOverlayDismiss(onClose: () => void, closeRef: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    closeRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeRef, onClose]);
}

/*
FNXC:ArtifactsGallery 2026-07-11-11:30:
Artifact viewers host inside the app's canonical FloatingWindow so every popup is DRAGGABLE (by the
viewer header — FloatingWindow ignores pointerdowns on buttons, so header actions stay clickable) and
RESIZABLE (edge/corner handles), with geometry persisted per viewer kind. hideHeader keeps the
viewer's own header chrome (title + actions + close); Escape still dismisses and the close button
autofocuses via useOverlayDismiss. Each viewer owns its close-button ref and passes it to both
OverlayShell and ViewerHeader.
*/
function OverlayShell({ label, onClose, children, wide, closeRef, windowKey, persistKey }: { label: string; onClose: () => void; children: React.ReactNode; wide?: boolean; closeRef: React.RefObject<HTMLButtonElement | null>; windowKey: string; persistKey: string }) {
  useOverlayDismiss(onClose, closeRef);

  return (
    <FloatingWindow
      windowKey={windowKey}
      title={null}
      onClose={onClose}
      hideHeader
      dragHandleSelector=".artifacts-gallery-viewer-header"
      className="artifacts-gallery-window"
      ariaLabel={label}
      /* FNXC:ModalGeometryPersistence 2026-07-16-00:40: Artifact viewers are full-screen sheets at ≤768px or ≤480px tall, so neither mobile shape may overwrite desktop geometry. */
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      persistGeometryKey={persistKey}
      defaultSize={wide ? { width: 1024, height: 720 } : { width: 720, height: 640 }}
      minSize={{ width: 320, height: 280 }}
    >
      <div className="artifacts-gallery-viewer">
        {children}
      </div>
    </FloatingWindow>
  );
}

function ViewerHeader({ title, onClose, t, actions, closeRef }: { title: string; onClose: () => void; t: TFunction<"app">; actions?: React.ReactNode; closeRef: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <div className="artifacts-gallery-viewer-header">
      <h3 className="artifacts-gallery-viewer-title">{title}</h3>
      <div className="artifacts-gallery-viewer-actions">
        {actions}
        <button ref={closeRef} className="modal-close" onClick={onClose} aria-label={t("documents.closeLightbox", "Close artifact preview")}>
          <X size={20} />
        </button>
      </div>
    </div>
  );
}

function ViewerMeta({ artifact, t, onOpenTask }: { artifact: ArtifactWithTask; t: TFunction<"app">; onOpenTask: (taskId: string) => void }) {
  return (
    <div className="artifacts-gallery-viewer-meta">
      {artifact.description && <p className="artifacts-gallery-viewer-description">{artifact.description}</p>}
      <div className="artifacts-gallery-viewer-meta-row">
        <span>{artifact.authorId}</span>
        <span>·</span>
        <span>{formatTimestamp(artifact.createdAt)}</span>
        {artifact.sizeBytes !== undefined && <span>· {formatFileSize(artifact.sizeBytes)}</span>}
        {artifact.taskId && (
          <button className="artifacts-gallery-task-link" onClick={() => onOpenTask(artifact.taskId as string)}>
            {t("documents.openTask", "Open task")} {artifact.taskId}
          </button>
        )}
      </div>
    </div>
  );
}

function MediaLightbox({ artifact, projectId, t, onClose, onOpenTask }: OverlayProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const mediaUrl = artifactMediaUrlWithToken(artifact.id, projectId);
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <OverlayShell label={t("documents.lightboxLabel", "Artifact media preview")} onClose={onClose} wide closeRef={closeRef} windowKey={`artifact-media-${artifact.id}`} persistKey="fn-artifact-viewer-media-geometry">
      <ViewerHeader
        title={title}
        onClose={onClose}
        t={t}
        closeRef={closeRef}
        actions={(
          <a className="btn btn-sm" href={mediaUrl} target="_blank" rel="noreferrer" aria-label={t("documents.openInNewTab", "Open in new tab")}>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      />
      <div className="artifacts-gallery-viewer-media-frame">
        {artifact.type === "image" ? (
          <img className="artifacts-gallery-viewer-media" src={mediaUrl} alt={title} />
        ) : (
          <video
            className="artifacts-gallery-viewer-media"
            src={mediaUrl}
            controls
            autoPlay
            aria-label={t("documents.artifactVideoLabel", "Video artifact: {{title}}", { title })}
          />
        )}
      </div>
      <ViewerMeta artifact={artifact} t={t} onOpenTask={onOpenTask} />
    </OverlayShell>
  );
}

function PdfViewer({ artifact, projectId, t, onClose, onOpenTask }: OverlayProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const mediaUrl = artifactMediaUrlWithToken(artifact.id, projectId);
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <OverlayShell label={t("documents.pdfViewerLabel", "PDF artifact viewer")} onClose={onClose} wide closeRef={closeRef} windowKey={`artifact-pdf-${artifact.id}`} persistKey="fn-artifact-viewer-pdf-geometry">
      <ViewerHeader
        title={title}
        onClose={onClose}
        t={t}
        closeRef={closeRef}
        actions={(
          <a className="btn btn-sm" href={mediaUrl} target="_blank" rel="noreferrer" aria-label={t("documents.openInNewTab", "Open in new tab")}>
            <ExternalLink size={14} aria-hidden="true" />
            {t("documents.openInNewTab", "Open in new tab")}
          </a>
        )}
      />
      <iframe className="artifacts-gallery-viewer-pdf" src={mediaUrl} title={title} />
      <ViewerMeta artifact={artifact} t={t} onOpenTask={onOpenTask} />
    </OverlayShell>
  );
}

interface DocViewerProps extends OverlayProps {
  addToast: (message: string, type?: ToastType) => void;
  onArtifactUpdated?: () => void;
}

/*
FNXC:ArtifactsGallery 2026-07-10-16:30:
Any inline-content doc artifact must be editable straight from the Artifacts view (operator requirement: "jump into edit mode for any doc", "with regular file editor control and view"). The viewer fetches the full artifact (list responses strip content) and renders MARKDOWN BY DEFAULT so docs look polished on open. Edit mode embeds the same CodeMirror FileEditor used for workspace files (syntax highlighting, Edit/Preview toolbar for markdown, word wrap), and Save persists via PATCH /artifacts/:id. Binary-backed docs (rows with a uri) hide Edit because their payload lives on disk. The synthetic filePath maps the artifact MIME type to an extension so FileEditor picks the right language mode.
*/
function artifactEditorFileName(artifact: Artifact): string {
  const mime = artifact.mimeType?.toLowerCase().split(";", 1)[0] ?? "";
  const extension = mime === "text/html" ? ".html"
    : mime === "application/json" ? ".json"
      : mime === "text/plain" ? ".txt"
        : ".md";
  return `${(artifact.title || "artifact").replace(/[^\w.-]+/g, "-")}${extension}`;
}

function DocViewer({ artifact, projectId, t, addToast, onClose, onOpenTask, onArtifactUpdated }: DocViewerProps) {
  const title = artifact.title || t("documents.untitledArtifact", "Untitled artifact");
  const [detail, setDetail] = useState<Artifact | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [htmlPreviewError, setHtmlPreviewError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchArtifact(artifact.id, projectId)
      .then((fetched) => {
        if (!cancelled) setDetail(fetched);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, projectId]);

  const editable = detail !== null && !detail.uri;
  const content = detail?.content ?? "";
  /*
  FNXC:ArtifactsGallery 2026-07-11-10:20:
  HTML doc artifacts (agent-authored mockups/prototypes) must render as LIVE web previews by
  default — not as markdown — in a sandboxed iframe (scripts allowed, same-origin denied so the
  mockup cannot reach the dashboard API). The Preview/Source toggle replaces Markdown/Plain for
  HTML, and Edit still opens the shared FileEditor.
  */
  const isHtml = (detail?.mimeType ?? artifact.mimeType)?.toLowerCase().split(";", 1)[0] === "text/html";

  useEffect(() => {
    if (!detail?.uri || !isHtml || !renderMarkdown) {
      setHtmlPreviewUrl(null);
      setHtmlPreviewError(null);
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | undefined;
    setHtmlPreviewUrl(null);
    setHtmlPreviewError(null);

    /*
    FNXC:ArtifactRegistry 2026-07-15-14:45:
    File-backed HTML previews need authenticated media access, but allow-scripts content can read a tokenized iframe URL and exfiltrate it. Fetch with the Authorization header and hand the sandboxed iframe a revocable blob URL so the bearer token never reaches executable artifact content.
    */
    void fetch(artifactMediaUrl(artifact.id, projectId), {
      headers: withTokenHeader(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load HTML preview (${response.status})`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (!controller.signal.aborted) setHtmlPreviewUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setHtmlPreviewError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, detail?.uri, isHtml, projectId, renderMarkdown]);

  const startEditing = () => {
    setDraft(content);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateArtifact(artifact.id, { content: draft }, projectId);
      setDetail(updated);
      setEditing(false);
      addToast(t("documents.artifactSaved", "Artifact saved"), "success");
      onArtifactUpdated?.();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <OverlayShell label={t("documents.docViewerLabel", "Document artifact viewer")} onClose={onClose} wide closeRef={closeRef} windowKey={`artifact-doc-${artifact.id}`} persistKey="fn-artifact-viewer-doc-geometry">
      <ViewerHeader
        title={title}
        onClose={onClose}
        t={t}
        closeRef={closeRef}
        actions={editing ? (
          <>
            <button className="btn btn-sm" onClick={() => setEditing(false)} disabled={saving}>
              {t("documents.cancelEdit", "Cancel")}
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? t("documents.saving", "Saving…") : t("documents.saveArtifact", "Save")}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-sm"
              onClick={() => setRenderMarkdown((prev) => !prev)}
              aria-pressed={renderMarkdown}
              title={isHtml
                ? (renderMarkdown ? t("documents.switchToSource", "Switch to source view") : t("documents.switchToPreview", "Switch to live preview"))
                : (renderMarkdown ? t("documents.switchToPlainText", "Switch to plain text") : t("documents.switchToMarkdown", "Switch to markdown"))}
            >
              {isHtml
                ? (renderMarkdown ? t("documents.htmlPreview", "Preview") : t("documents.htmlSource", "Source"))
                : (renderMarkdown ? t("documents.markdown", "Markdown") : t("documents.plain", "Plain"))}
            </button>
            {editable && (
              <button className="btn btn-sm" onClick={startEditing} aria-label={t("documents.editArtifact", "Edit document")}>
                <Pencil size={14} aria-hidden="true" />
                {t("documents.edit", "Edit")}
              </button>
            )}
          </>
        )}
      />
      <div className="artifacts-gallery-viewer-doc">
        {loadError ? (
          <p className="artifacts-gallery-viewer-error">{loadError}</p>
        ) : detail === null ? (
          <p className="artifacts-gallery-viewer-loading">{t("documents.loadingArtifact", "Loading artifact…")}</p>
        ) : editing ? (
          <div className="artifacts-gallery-viewer-editor" aria-label={t("documents.artifactContentEditor", "Artifact content editor")}>
            <FileEditor
              content={draft}
              onChange={setDraft}
              filePath={artifactEditorFileName(detail)}
              forceToolbarActionsVisible
            />
          </div>
        ) : isHtml && renderMarkdown ? (
          detail.uri && !htmlPreviewUrl ? (
            <p className="artifacts-gallery-viewer-loading">
              {htmlPreviewError ?? t("documents.loadingArtifact", "Loading artifact…")}
            </p>
          ) : (
            <iframe
              className="artifacts-gallery-viewer-html"
              sandbox="allow-scripts"
              title={title}
              {...(detail.uri ? { src: htmlPreviewUrl! } : { srcDoc: content })}
            />
          )
        ) : detail.uri ? (
          <p className="artifacts-gallery-viewer-loading">
            {t("documents.binaryDocArtifact", "This document is stored as a file.")}{" "}
            <a href={artifactMediaUrlWithToken(artifact.id, projectId)} target="_blank" rel="noreferrer">
              {t("documents.openArtifactMedia", "Open artifact media")}
            </a>
          </p>
        ) : renderMarkdown ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="artifacts-gallery-viewer-plain">{content}</pre>
        )}
      </div>
      <ViewerMeta artifact={artifact} t={t} onOpenTask={onOpenTask} />
    </OverlayShell>
  );
}
