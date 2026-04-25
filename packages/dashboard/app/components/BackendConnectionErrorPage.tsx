interface BackendConnectionErrorPageProps {
  errorMessage: string;
  isRetrying: boolean;
  onRetry: () => void;
}

export function BackendConnectionErrorPage({
  errorMessage,
  isRetrying,
  onRetry,
}: BackendConnectionErrorPageProps) {
  return (
    <div className="project-overview-empty" role="alert" aria-live="polite">
      <h2>Can&apos;t reach the Fusion backend</h2>
      <p className="settings-muted">
        Fusion couldn&apos;t load your projects right now. Please make sure the backend is running and try again.
      </p>
      <p className="settings-muted">Error: {errorMessage}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry} disabled={isRetrying}>
        {isRetrying ? "Retrying…" : "Retry Connection"}
      </button>
    </div>
  );
}
