import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { FloatingWindow } from "./FloatingWindow";
import { useArtifactImageBlob } from "../hooks/useArtifactImageBlob";
import "./ArtifactImageViewer.css";

export interface ArtifactImageProps {
  artifactId: string;
  projectId?: string;
  title: string;
  className?: string;
  loading?: "lazy" | "eager";
  onError?: () => void;
}

/** A safe inline thumbnail: its image source is always a revocable blob URL. */
export function ArtifactImage({ artifactId, projectId, title, className, loading = "lazy", onError }: ArtifactImageProps) {
  const { url, error } = useArtifactImageBlob(artifactId, projectId);
  useEffect(() => { if (error) onError?.(); }, [error, onError]);
  return url ? <img className={className} src={url} alt={title} loading={loading} /> : null;
}

export interface ArtifactImageViewerProps {
  artifactId: string;
  title: string;
  projectId?: string;
  taskId?: string;
  onOpenTask?: (taskId: string) => void;
  onClose: () => void;
}

/**
 * FNXC:ArtifactImageSecurity 2026-08-19-18:08:
 * One dashboard-owned viewer is the only image destination across artifact surfaces. It renders a
 * revocable blob URL rather than a raw media link, preserving previews without exposing daemon
 * credentials in copied URLs, browser history, or image attributes.
 */
export function ArtifactImageViewer({ artifactId, title, projectId, taskId, onOpenTask, onClose }: ArtifactImageViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  const { url, loading, error, reload } = useArtifactImageBlob(artifactId, projectId);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, []);

  return (
    <FloatingWindow
      windowKey={`artifact-media-${artifactId}`}
      title={null}
      modal
      onClose={onClose}
      hideHeader
      dragHandleSelector=".artifact-image-viewer__header"
      className="artifact-image-viewer-window artifacts-gallery-viewer"
      ariaLabel="Artifact media preview"
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      persistGeometryKey="fn-artifact-image-viewer-geometry"
      defaultSize={{ width: 1024, height: 720 }}
      minSize={{ width: 320, height: 280 }}
    >
      <section className="artifact-image-viewer" aria-label={`Image artifact: ${title}`}>
        <header className="artifact-image-viewer__header">
          <h3 className="artifact-image-viewer__title">{title}</h3>
          {taskId && onOpenTask && <button className="btn btn-sm" type="button" onClick={() => onOpenTask(taskId)}>Open task</button>}
          <button ref={closeRef} className="modal-close" type="button" onClick={onClose} aria-label="Close artifact preview">
            <X size={20} />
          </button>
        </header>
        <div className="artifact-image-viewer__content" aria-live="polite">
          {loading && <p>Loading image artifact…</p>}
          {error && (
            <div className="artifact-image-viewer__failure" role="alert">
              <p className="artifact-image-viewer__error">{error}</p>
              <button className="btn btn-sm" type="button" onClick={reload}>Retry</button>
            </div>
          )}
          {url && <img className="artifact-image-viewer__image" src={url} alt={title} />}
        </div>
      </section>
    </FloatingWindow>
  );
}
