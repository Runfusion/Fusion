import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Minimize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { FloatingWindow } from "./FloatingWindow";
import { useArtifactImageBlob } from "../hooks/useArtifactImageBlob";
import "./ArtifactImageViewer.css";

export const ARTIFACT_IMAGE_SCALE_MIN = 1;
export const ARTIFACT_IMAGE_SCALE_MAX = 8;
export const ARTIFACT_IMAGE_SCALE_STEP = 1.25;
export const ARTIFACT_IMAGE_DOUBLE_CLICK_SCALE = 2;

export interface ArtifactImageTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ArtifactImageSize {
  width: number;
  height: number;
}

const RESET_TRANSFORM: ArtifactImageTransform = { scale: ARTIFACT_IMAGE_SCALE_MIN, x: 0, y: 0 };

export function clampArtifactImageTransform(
  next: ArtifactImageTransform,
  viewportSize: ArtifactImageSize,
  imageSize: ArtifactImageSize,
): ArtifactImageTransform {
  const scale = Math.min(ARTIFACT_IMAGE_SCALE_MAX, Math.max(ARTIFACT_IMAGE_SCALE_MIN, next.scale));
  if (viewportSize.width <= 0 || viewportSize.height <= 0 || imageSize.width <= 0 || imageSize.height <= 0) {
    return { ...next, scale };
  }

  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    scale,
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, next.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, next.y)),
  };
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

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
 *
 * FNXC:ArtifactImageZoom 2026-09-03-04:56:
 * The shared viewer owns zoom and pan so every artifact host receives the same controls while the
 * blob-URL credential contract remains unchanged. Wheel zoom uses a native non-passive listener
 * because React's root listener is passive, and unmeasured layouts clamp scale without locking pan.
 */
export function ArtifactImageViewer({ artifactId, title, projectId, taskId, onOpenTask, onClose }: ArtifactImageViewerProps) {
  const { t } = useTranslation("app");
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panStartRef = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number; centerX: number; centerY: number } | null>(null);
  const [transform, setTransform] = useState<ArtifactImageTransform>(RESET_TRANSFORM);
  const transformRef = useRef<ArtifactImageTransform>(RESET_TRANSFORM);
  const [isPanning, setIsPanning] = useState(false);
  const { url, loading, error, reload } = useArtifactImageBlob(artifactId, projectId);

  const measure = useCallback(() => ({
    viewportSize: {
      width: viewportRef.current?.clientWidth ?? 0,
      height: viewportRef.current?.clientHeight ?? 0,
    },
    imageSize: {
      width: imageRef.current?.clientWidth ?? 0,
      height: imageRef.current?.clientHeight ?? 0,
    },
  }), []);

  const updateTransform = useCallback((resolve: (current: ArtifactImageTransform) => ArtifactImageTransform) => {
    setTransform((current) => {
      const { viewportSize, imageSize } = measure();
      const next = clampArtifactImageTransform(resolve(current), viewportSize, imageSize);
      transformRef.current = next;
      return next;
    });
  }, [measure]);

  const resetTransform = useCallback(() => {
    transformRef.current = RESET_TRANSFORM;
    setTransform(RESET_TRANSFORM);
    activePointersRef.current.clear();
    panStartRef.current = null;
    pinchStartRef.current = null;
    setIsPanning(false);
  }, []);

  const zoomAtPoint = useCallback((requestedScale: number, clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    updateTransform((current) => {
      const scale = Math.min(ARTIFACT_IMAGE_SCALE_MAX, Math.max(ARTIFACT_IMAGE_SCALE_MIN, requestedScale));
      const ratio = scale / current.scale;
      const pointX = clientX - (rect.left + rect.width / 2);
      const pointY = clientY - (rect.top + rect.height / 2);
      return {
        scale,
        x: pointX - (pointX - current.x) * ratio,
        y: pointY - (pointY - current.y) * ratio,
      };
    });
  }, [updateTransform]);

  const zoomBy = useCallback((factor: number) => {
    updateTransform((current) => ({ ...current, scale: current.scale * factor }));
  }, [updateTransform]);

  const keyboardActionsRef = useRef<{ zoomIn: () => void; zoomOut: () => void; reset: () => void }>({
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    reset: () => undefined,
  });
  keyboardActionsRef.current = {
    zoomIn: () => zoomBy(ARTIFACT_IMAGE_SCALE_STEP),
    zoomOut: () => zoomBy(1 / ARTIFACT_IMAGE_SCALE_STEP),
    reset: resetTransform,
  };

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (isEditableKeyboardTarget(event.target)) return;
      if (event.key === "+" || event.key === "=") keyboardActionsRef.current.zoomIn();
      else if (event.key === "-" || event.key === "_") keyboardActionsRef.current.zoomOut();
      else if (event.key === "0") keyboardActionsRef.current.reset();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    resetTransform();
  }, [artifactId, resetTransform, url]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !url) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? ARTIFACT_IMAGE_SCALE_STEP : 1 / ARTIFACT_IMAGE_SCALE_STEP;
      zoomAtPoint(transformRef.current.scale * factor, event.clientX, event.clientY);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [url, zoomAtPoint]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size === 1) {
      const current = transformRef.current;
      if (current.scale > ARTIFACT_IMAGE_SCALE_MIN) {
        panStartRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          x: current.x,
          y: current.y,
        };
        setIsPanning(true);
      }
      return;
    }

    if (activePointersRef.current.size === 2) {
      const [first, second] = Array.from(activePointersRef.current.values());
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (distance > 0) {
        pinchStartRef.current = {
          distance,
          scale: transformRef.current.scale,
          centerX: (first.x + second.x) / 2,
          centerY: (first.y + second.y) / 2,
        };
      }
      panStartRef.current = null;
      setIsPanning(false);
    }
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size >= 2) {
      const [first, second] = Array.from(activePointersRef.current.values());
      const start = pinchStartRef.current;
      if (!start || start.distance <= 0) return;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      zoomAtPoint(start.scale * (distance / start.distance), start.centerX, start.centerY);
      return;
    }

    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId || transformRef.current.scale <= ARTIFACT_IMAGE_SCALE_MIN) return;
    updateTransform((current) => ({
      ...current,
      x: start.x + event.clientX - start.clientX,
      y: start.y + event.clientY - start.clientY,
    }));
  }, [updateTransform, zoomAtPoint]);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    pinchStartRef.current = null;

    const remaining = Array.from(activePointersRef.current.entries());
    if (remaining.length === 1 && transformRef.current.scale > ARTIFACT_IMAGE_SCALE_MIN) {
      const [pointerId, point] = remaining[0];
      panStartRef.current = {
        pointerId,
        clientX: point.x,
        clientY: point.y,
        x: transformRef.current.x,
        y: transformRef.current.y,
      };
      setIsPanning(true);
      return;
    }

    panStartRef.current = null;
    setIsPanning(false);
  }, []);

  const handleDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (transformRef.current.scale > ARTIFACT_IMAGE_SCALE_MIN) {
      resetTransform();
    } else {
      zoomAtPoint(ARTIFACT_IMAGE_DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
    }
  }, [resetTransform, zoomAtPoint]);

  const zoomPercent = Math.round(transform.scale * 100);
  const resetDisabled = transform.scale === ARTIFACT_IMAGE_SCALE_MIN && transform.x === 0 && transform.y === 0;

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
          {taskId && onOpenTask && <button className="btn btn-sm" type="button" onClick={() => onOpenTask(taskId)}>{t("artifactImageViewer.openTask", "Open task")}</button>}
          <button ref={closeRef} className="modal-close" type="button" onClick={onClose} aria-label={t("artifactImageViewer.close", "Close artifact preview")}>
            <X size={20} />
          </button>
        </header>
        <div className="artifact-image-viewer__content" aria-live="polite">
          {loading && <p>{t("artifactImageViewer.loading", "Loading image artifact…")}</p>}
          {error && (
            <div className="artifact-image-viewer__failure" role="alert">
              <p className="artifact-image-viewer__error">{error}</p>
              <button className="btn btn-sm" type="button" onClick={reload}>{t("artifactImageViewer.retry", "Retry")}</button>
            </div>
          )}
          {url && (
            <div
              ref={viewportRef}
              className="artifact-image-viewer__viewport"
              data-testid="artifact-image-viewer-viewport"
              data-zoomed={transform.scale > ARTIFACT_IMAGE_SCALE_MIN ? "true" : "false"}
              data-panning={isPanning ? "true" : "false"}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onDoubleClick={handleDoubleClick}
            >
              <img
                ref={imageRef}
                className="artifact-image-viewer__image"
                src={url}
                alt={title}
                draggable={false}
                onLoad={resetTransform}
                style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
              />
            </div>
          )}
        </div>
        {url && (
          <div className="artifact-image-viewer__toolbar" onPointerDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="btn-icon touch-target"
              data-testid="artifact-image-viewer-zoom-out"
              onClick={() => zoomBy(1 / ARTIFACT_IMAGE_SCALE_STEP)}
              disabled={transform.scale <= ARTIFACT_IMAGE_SCALE_MIN}
              aria-label={t("artifactImageViewer.zoomOut", "Zoom out")}
              title={t("artifactImageViewer.zoomOut", "Zoom out")}
            >
              <ZoomOut />
            </button>
            <span
              className="artifact-image-viewer__zoom-level"
              data-testid="artifact-image-viewer-zoom-level"
              aria-live="polite"
              aria-label={t("artifactImageViewer.zoomLevel", "{{percent}}% zoom", { percent: zoomPercent })}
            >
              {zoomPercent}%
            </span>
            <button
              type="button"
              className="btn-icon touch-target"
              data-testid="artifact-image-viewer-zoom-in"
              onClick={() => zoomBy(ARTIFACT_IMAGE_SCALE_STEP)}
              disabled={transform.scale >= ARTIFACT_IMAGE_SCALE_MAX}
              aria-label={t("artifactImageViewer.zoomIn", "Zoom in")}
              title={t("artifactImageViewer.zoomIn", "Zoom in")}
            >
              <ZoomIn />
            </button>
            <button
              type="button"
              className="btn-icon touch-target"
              data-testid="artifact-image-viewer-zoom-reset"
              onClick={resetTransform}
              disabled={resetDisabled}
              aria-label={t("artifactImageViewer.resetZoom", "Reset zoom")}
              title={t("artifactImageViewer.resetZoom", "Reset zoom")}
            >
              <Minimize2 />
            </button>
          </div>
        )}
      </section>
    </FloatingWindow>
  );
}
