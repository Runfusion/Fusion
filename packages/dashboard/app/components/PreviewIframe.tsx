import { useCallback, useEffect, useState, type RefObject, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import type { EmbedStatus } from "../hooks/usePreviewEmbed";

export interface PreviewIframeProps {
  url: string | null;
  embedStatus: EmbedStatus;
  onEmbedStatusChange: (status: EmbedStatus) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  blockReason: string | null;
  onRetry?: () => void;
  className?: string;
  /** @deprecated Use blockReason instead */
  embedContext?: string | null;
}

const DEFAULT_IFRAME_CLASS = "devserver-preview-iframe";

export function PreviewIframe({
  url,
  embedStatus,
  onEmbedStatusChange,
  iframeRef,
  blockReason,
  onRetry,
  className = DEFAULT_IFRAME_CLASS,
  embedContext: deprecatedEmbedContext,
}: PreviewIframeProps) {
  const { t } = useTranslation("app");
  // Support both blockReason and legacy embedContext
  const context = blockReason ?? deprecatedEmbedContext ?? null;

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!url || embedStatus !== "unknown") {
      return;
    }

    setAttempt((current) => current + 1);
    onEmbedStatusChange("loading");
  }, [embedStatus, onEmbedStatusChange, url]);

  const handleLoad = useCallback(() => {
    const iframeEl = iframeRef.current;
    if (!iframeEl) {
      onEmbedStatusChange("embedded");
      return;
    }

    try {
      const frameHref = iframeEl.contentWindow?.location?.href;
      if (frameHref === "about:blank" && iframeEl.src !== "about:blank") {
        onEmbedStatusChange("blocked");
        return;
      }
    } catch {
      // Cross-origin access can throw; do not treat it as blocked.
    }

    onEmbedStatusChange("embedded");
  }, [iframeRef, onEmbedStatusChange]);

  const handleError = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    event.stopPropagation();
    onEmbedStatusChange("error");
  }, [onEmbedStatusChange]);

  const handleOpenInNewTab = useCallback(() => {
    if (!url) {
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  if (!url) {
    return null;
  }

  return (
    <div className="devserver-preview-iframe-shell">
      <iframe
        key={`${url}-${attempt}`}
        src={url}
        ref={iframeRef}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        className={className}
        title="Dev server preview"
        onLoad={handleLoad}
        onError={handleError}
        onErrorCapture={handleError}
        data-testid="devserver-preview-iframe"
      />

      {embedStatus === "loading" && (
        <div className="devserver-preview-overlay" data-testid="devserver-preview-loading">
          <Loader2 size={16} className="dev-server-spin" />
          <span>{t("preview.loading", "Loading preview...")}</span>
        </div>
      )}

      {embedStatus === "blocked" && (
        <div className="devserver-preview-blocked-panel" role="alert" data-testid="devserver-preview-blocked-panel">
          <ShieldAlert className="devserver-preview-blocked-icon" aria-hidden="true" />
          <div>
            <p className="devserver-preview-blocked-title">{t("preview.blockedTitle", "Preview cannot be embedded")}</p>
            {context && <p className="devserver-preview-blocked-context">{context}</p>}
          </div>
          <p className="devserver-preview-blocked-description">{t("preview.blockedDescription", "You can view the preview in a separate browser tab.")}</p>
          <div className="devserver-preview-blocked-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleOpenInNewTab}
            >
              {t("preview.openInNewTab", "Open in new tab")}
            </button>
            {onRetry && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRetry}
              >
                {t("actions.retry", "Retry")}
              </button>
            )}
          </div>
        </div>
      )}

      {embedStatus === "error" && (
        <div className="devserver-preview-error-panel" role="alert" data-testid="devserver-preview-error-panel">
          <AlertTriangle className="devserver-preview-blocked-icon" aria-hidden="true" />
          <div>
            <p className="devserver-preview-blocked-title">{t("preview.errorTitle", "Unable to load preview")}</p>
            {context && <p className="devserver-preview-blocked-context">{context}</p>}
          </div>
          <p className="devserver-preview-blocked-description">{t("preview.blockedDescription", "You can view the preview in a separate browser tab.")}</p>
          <div className="devserver-preview-blocked-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleOpenInNewTab}
            >
              {t("preview.openInNewTab", "Open in new tab")}
            </button>
            {onRetry && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRetry}
              >
                {t("actions.retry", "Retry")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
