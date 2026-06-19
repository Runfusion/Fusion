import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Gauge, Loader2 } from "lucide-react";
import "./areas.css";

export interface AreaShellProps {
  /** Stable test id prefix, e.g. "tokens" → cc-area-tokens. */
  testId: string;
  isLoading: boolean;
  error: string | null;
  /** True when the loaded data has nothing to display. */
  isEmpty: boolean;
  /** Custom empty-state message; defaults to the shared "no data" copy. */
  emptyMessage?: string;
  children: ReactNode;
}

/**
 * Shared loading / error / empty wrapper for the historical-analytics areas,
 * mirroring `ReliabilityView`'s state handling. Renders children only once
 * there is data to show; never crashes on an empty area (degrades to the
 * empty state instead).
 */
export function AreaShell({ testId, isLoading, error, isEmpty, emptyMessage, children }: AreaShellProps) {
  const { t } = useTranslation("app");

  if (isLoading) {
    return (
      <div className="cc-loading-inline" data-testid={`cc-area-${testId}-loading`}>
        <Loader2 size={18} className="spin" />
        <span>{t("commandCenter.area.loading", "Loading…")}</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="cc-area-error" data-testid={`cc-area-${testId}-error`} role="alert">
        <AlertCircle size={22} />
        <p>{error}</p>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="cc-area-empty" data-testid={`cc-area-${testId}-empty`}>
        <Gauge size={24} />
        <p>{emptyMessage ?? t("commandCenter.area.empty", "No data for the selected range.")}</p>
      </div>
    );
  }

  return (
    <div className="cc-area" data-testid={`cc-area-${testId}`}>
      {children}
    </div>
  );
}
