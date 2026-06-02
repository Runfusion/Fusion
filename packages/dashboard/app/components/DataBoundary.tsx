import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { getErrorMessage } from "@fusion/core";
import { AgentEmptyState } from "./AgentEmptyState";
import { ProjectGridSkeleton } from "./ProjectGridSkeleton";

export interface DataBoundaryProps {
  isEmpty: boolean;
  isLoading?: boolean;
  hasFetched?: boolean;
  error?: unknown;
  loadingFallback?: ReactNode;
  emptyFallback?: ReactNode;
  errorFallback?: ReactNode;
  children: ReactNode;
}

function DefaultErrorFallback({ error }: { error: unknown }) {
  return (
    <div className="agent-empty" data-testid="data-boundary-error">
      <AlertCircle className="agent-empty-state__icon" size={48} opacity={0.3} />
      <p className="agent-empty-state__title">Unable to load data</p>
      <p className="agent-empty-state__description text-secondary">
        {getErrorMessage(error) || "Something went wrong while loading this view."}
      </p>
    </div>
  );
}

export function DataBoundary({
  isEmpty,
  isLoading = false,
  hasFetched = false,
  error,
  loadingFallback,
  emptyFallback,
  errorFallback,
  children,
}: DataBoundaryProps) {
  if (error) {
    return <>{errorFallback ?? <DefaultErrorFallback error={error} />}</>;
  }

  const shouldShowLoading = isLoading || (!hasFetched && !error);
  if (shouldShowLoading) {
    return <>{loadingFallback ?? <ProjectGridSkeleton />}</>;
  }

  if (hasFetched && isEmpty) {
    return (
      <>
        {emptyFallback ?? (
          <AgentEmptyState
            title="No data available"
            description="There is nothing to show yet."
            ctaLabel=""
          />
        )}
      </>
    );
  }

  return <>{children}</>;
}
