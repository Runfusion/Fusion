import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";
import { handleChunkLoadError } from "../versionCheck";
import i18n from "../i18n";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import {
  REACT_UPDATE_DEPTH_DOC_URL,
  buildErrorBoundaryDiagnostics,
  type ErrorBoundaryDiagnostics,
} from "../utils/errorBoundaryDiagnostics";
import "./ErrorBoundary.css";

declare const __BUILD_VERSION__: string;

/*
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: the fallback must stay diagnosable with NO browser console — the operator hit it on a phone.
It therefore keeps a bounded local snapshot (message, JavaScript stack, component stack, boundary
level, time, injected build id, user agent, viewport sizes) behind collapsible details plus a copy
action.

Constraints this deliberately respects:
- It renders after ANY provider may have died, so it uses plain HTML, i18n defaults, and
  `copyTextToClipboard` only. No toast, no portal, no new managed window, no subscription to the
  failing manager — otherwise the fallback could fail alongside the subtree it reports on.
- The snapshot is taken ONCE in `componentDidCatch`, never during render, so a re-render cannot
  recompute it.
- Retry invalidates the snapshot and any in-flight copy answer through a monotonic generation, so a
  late clipboard result can neither revive a stale report nor contaminate the next error.
- Nothing is sent anywhere, no navigation URL is stored, and sourcemaps stay private.
*/
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  level?: "page" | "modal" | "root";
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

type CopyState = "idle" | "copied" | "failed";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  diagnostics: ErrorBoundaryDiagnostics | null;
  detailsOpen: boolean;
  copyState: CopyState;
}

function resolveBuildVersion(): string | null {
  try {
    return typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : null;
  } catch {
    return null;
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** Bumped by Retry and by unmount so a late copy answer is discarded. */
  private generation = 0;
  private mounted = true;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, diagnostics: null, detailsOpen: false, copyState: "idle" };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, errorInfo);
    // Capture once, here — never in render.
    this.setState({
      diagnostics: buildErrorBoundaryDiagnostics({
        error,
        componentStack: errorInfo?.componentStack ?? null,
        level: this.props.level ?? "page",
        buildVersion: resolveBuildVersion(),
      }),
      copyState: "idle",
      detailsOpen: false,
    });
    if (handleChunkLoadError(error)) return;
    this.props.onError?.(error, errorInfo);
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.generation += 1;
  }

  resetErrorBoundary = (): void => {
    this.generation += 1;
    this.setState({ hasError: false, error: null, diagnostics: null, detailsOpen: false, copyState: "idle" });
  };

  private handleCopy = async (): Promise<void> => {
    const report = this.state.diagnostics?.report;
    if (!report) return;
    const generation = this.generation;
    const ok = await copyTextToClipboard(report);
    // A result that arrives after Retry or unmount belongs to a report that no longer exists.
    if (!this.mounted || generation !== this.generation) return;
    this.setState({ copyState: ok ? "copied" : "failed" });
  };

  private renderDiagnostics(diagnostics: ErrorBoundaryDiagnostics): ReactNode {
    const { copyState, detailsOpen } = this.state;
    const copyLabel = copyState === "copied"
      ? i18n.t("app:errorBoundary.copied", "Copied")
      : copyState === "failed"
        ? i18n.t("app:errorBoundary.copyFailed", "Copy failed — select the text below")
        : i18n.t("app:errorBoundary.copyDetails", "Copy details");

    return (
      <details
        className="error-boundary__details"
        open={detailsOpen}
        onToggle={(event) => this.setState({ detailsOpen: (event.currentTarget as HTMLDetailsElement).open })}
      >
        <summary className="error-boundary__details-summary">
          {i18n.t("app:errorBoundary.technicalDetails", "Technical details")}
        </summary>
        {diagnostics.isUpdateDepthError && (
          <p className="error-boundary__hint">
            {i18n.t(
              "app:errorBoundary.updateDepthHint",
              "React stopped a render loop: a component kept scheduling updates while updating. The details below identify which build and which components were involved.",
            )}{" "}
            <a href={REACT_UPDATE_DEPTH_DOC_URL} target="_blank" rel="noreferrer noopener">
              {REACT_UPDATE_DEPTH_DOC_URL}
            </a>
          </p>
        )}
        {/* Rendered as React text, never HTML, and selectable so copy refusal is still recoverable. */}
        <pre className="error-boundary__report" data-testid="error-boundary-report">{diagnostics.report}</pre>
        {diagnostics.truncated && (
          <p className="error-boundary__hint">
            {i18n.t("app:errorBoundary.reportTruncated", "This report was shortened to stay readable.")}
          </p>
        )}
        <div className="error-boundary__details-actions">
          <button type="button" className="btn btn-sm" onClick={this.handleCopy} aria-live="polite">
            {copyLabel}
          </button>
        </div>
      </details>
    );
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // A host-supplied fallback keeps full priority and receives no extra controls.
    if (this.props.fallback) {
      return this.props.fallback;
    }

    const level = this.props.level ?? "page";
    const isModal = level === "modal";
    const title = isModal
      ? i18n.t("app:errorBoundary.sectionError", "This section encountered an error")
      : i18n.t("app:errorBoundary.genericError", "Something went wrong");

    return (
      <div className={`error-boundary error-boundary--${level}`}>
        <div className="error-boundary__icon">
          <AlertTriangle size={40} />
        </div>
        <div className="error-boundary__title">{title}</div>
        {this.state.error && (
          <pre className="error-boundary__message">{this.state.diagnostics?.message || this.state.error.message}</pre>
        )}
        {this.state.diagnostics && this.renderDiagnostics(this.state.diagnostics)}
        <div className="error-boundary__actions">
          <button className="btn btn-primary" onClick={this.resetErrorBoundary}>
            {i18n.t("app:errorBoundary.retry", "Retry")}
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            {i18n.t("app:errorBoundary.reloadPage", "Reload page")}
          </button>
        </div>
      </div>
    );
  }
}

export function PageErrorBoundary({ children, onError }: { children: ReactNode; onError?: (error: Error, errorInfo: ErrorInfo) => void }) {
  return (
    <ErrorBoundary level="page" onError={onError}>
      {children}
    </ErrorBoundary>
  );
}

export function ModalErrorBoundary({ children, onError }: { children: ReactNode; onError?: (error: Error, errorInfo: ErrorInfo) => void }) {
  return (
    <ErrorBoundary level="modal" onError={onError}>
      {children}
    </ErrorBoundary>
  );
}

export function RootErrorBoundary({ children, onError }: { children: ReactNode; onError?: (error: Error, errorInfo: ErrorInfo) => void }) {
  return (
    <ErrorBoundary level="root" onError={onError}>
      {children}
    </ErrorBoundary>
  );
}
