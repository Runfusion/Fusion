import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";
import { handleChunkLoadError } from "../versionCheck";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  level?: "page" | "modal" | "root";
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, errorInfo);
    if (handleChunkLoadError(error)) return;
    this.props.onError?.(error, errorInfo);
  }

  resetErrorBoundary = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    const level = this.props.level ?? "page";
    const isModal = level === "modal";
    const title = isModal
      ? "This section encountered an error"
      : "Something went wrong";

    return (
      <div className={`error-boundary error-boundary--${level}`}>
        <div className="error-boundary__icon">
          <AlertTriangle size={40} />
        </div>
        <div className="error-boundary__title">{title}</div>
        {this.state.error && (
          <pre className="error-boundary__message">{this.state.error.message}</pre>
        )}
        <div className="error-boundary__actions">
          <button className="btn btn-primary" onClick={this.resetErrorBoundary}>
            Retry
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload page
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
