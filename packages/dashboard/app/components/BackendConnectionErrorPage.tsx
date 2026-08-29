import "./BackendConnectionErrorPage.css";
import { useTranslation } from "react-i18next";

interface BackendConnectionErrorPageProps {
  errorMessage: string;
  isRetrying: boolean;
  onRetry: () => void;
  onManageConnection?: () => void;
}

function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.fusionShell?.resetDesktopMode === "function";
}

async function changeLaunchMode(): Promise<void> {
  const shell = typeof window !== "undefined" ? window.fusionShell : undefined;
  try {
    await shell?.resetDesktopMode?.();
  } catch {
    // Best-effort; still strip query params and reload.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("serverBaseUrl");
  url.searchParams.delete("shellMode");
  window.location.replace(url.toString());
}

export function BackendConnectionErrorPage({
  errorMessage,
  isRetrying,
  onRetry,
  onManageConnection,
}: BackendConnectionErrorPageProps) {
  const { t } = useTranslation("app");
  const showChangeLaunchMode = isDesktopShell();
  return (
    <div className="project-overview-empty" role="alert" aria-live="polite">
      <h2>{t("backend.connectionError", "Can't reach the Fusion backend")}</h2>
      <p className="settings-muted">
        {t("backend.couldNotLoad", "Fusion couldn't load your projects right now. Please make sure the backend is running and try again.")}
      </p>
      <p className="settings-muted">{t("backend.error", "Error: {{error}}", { error: errorMessage })}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t("backend.retrying", "Retrying…") : t("backend.retryConnection", "Retry Connection")}
        </button>
        {showChangeLaunchMode && (
          <button type="button" className="btn" onClick={() => void changeLaunchMode()}>
            {t("backend.changeLaunchMode", "Change Launch Mode…")}
          </button>
        )}
        {onManageConnection && (
          <button type="button" className="btn" onClick={onManageConnection}>
            {t("backend.manageConnection", "Manage Connection")}
          </button>
        )}
      </div>
    </div>
  );
}
