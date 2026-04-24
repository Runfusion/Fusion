/**
 * InsightsView - Dashboard component for displaying and managing project insights
 *
 * Features:
 * - Displays insights grouped by all supported insight categories
 * - Manual insight generation trigger
 * - Per-insight dismiss action
 * - Per-insight task creation action
 * - Loading, error, and empty states
 * - Accessible feedback for all actions
 */

import { useCallback, useEffect, useState } from "react";
import {
  Sparkles,
  RefreshCw,
  X,
  Plus,
  AlertCircle,
  CheckCircle,
  Lightbulb,
  Building,
  Users,
  LineChart,
  TrendingUp,
  ExternalLink,
  Archive,
  Clock,
} from "lucide-react";
import { useInsights, type InsightSection } from "../hooks/useInsights";
import type { InsightCategory } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

interface InsightsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onClose?: () => void;
  onCreateTask?: (title: string, description: string) => void;
}

// Category icons mapping
const CATEGORY_ICONS: Record<InsightCategory, React.ComponentType<{ size?: number; className?: string }>> = {
  architecture: Building,
  quality: CheckCircle,
  workflow: Clock,
  performance: TrendingUp,
  reliability: RefreshCw,
  security: AlertCircle,
  ux: Users,
  testability: Archive,
  documentation: ExternalLink,
  dependency: Plus,
  features: Lightbulb,
  competitive_analysis: Users,
  research: LineChart,
  trends: TrendingUp,
  other: Sparkles,
};

export function InsightsView({ projectId, addToast, onClose, onCreateTask }: InsightsViewProps) {
  const {
    sections,
    loading,
    error,
    latestRun,
    isRunInFlight,
    runError,
    refresh,
    runInsights,
    dismiss,
    createTask: createTaskFromInsight,
    dismissStates,
    createTaskStates,
    totalCount,
  } = useInsights(projectId);

  // Track inline feedback messages
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"success" | "error" | "info">("info");

  // Clear status message after delay
  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  // Handle manual run
  const handleRun = useCallback(async () => {
    try {
      setStatusMessage("Generating insights...");
      setStatusType("info");
      await runInsights();
      setStatusMessage("Insight generation started");
      setStatusType("success");
      addToast("Insight generation started", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start generation";
      setStatusMessage(message);
      setStatusType("error");
      addToast(message, "error");
    }
  }, [runInsights, addToast]);

  // Handle dismiss
  const handleDismiss = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(`Dismissing "${title}"...`);
        setStatusType("info");
        await dismiss(id);
        setStatusMessage(`Dismissed "${title}"`);
        setStatusType("success");
        addToast(`Insight dismissed: ${title}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to dismiss insight";
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [dismiss, addToast],
  );

  // Handle create task
  const handleCreateTask = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(`Creating task from "${title}"...`);
        setStatusType("info");
        const taskData = await createTaskFromInsight(id);
        if (taskData && onCreateTask) {
          onCreateTask(taskData.title, taskData.description);
        }
        setStatusMessage(`Task created from "${title}"`);
        setStatusType("success");
        addToast(`Task created: ${taskData?.title ?? title}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create task";
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [createTaskFromInsight, onCreateTask, addToast],
  );

  // Render section
  const renderSection = (section: InsightSection) => {
    const IconComponent = CATEGORY_ICONS[section.category] ?? Sparkles;
    const isAnyActionInFlight =
      section.items.some((item) => dismissStates.get(item.id)?.running || createTaskStates.get(item.id)?.running) ?? false;

    return (
      <section key={section.category} className="insights-section" data-testid={`insights-section-${section.category}`}>
        <div className="insights-section-header">
          <div className="insights-section-title">
            <IconComponent size={18} className="insights-section-icon" />
            <h3>{section.label}</h3>
            <span className="insights-section-count">{section.items.length}</span>
          </div>
        </div>

        <div className="insights-section-content">
          {section.items.length === 0 ? (
            <div className="insights-empty-section" data-testid={`insights-empty-${section.category}`}>
              <p>No insights in this category</p>
            </div>
          ) : (
            <ul className="insights-list">
              {section.items.map((insight) => {
                const dismissState = dismissStates.get(insight.id);
                const createState = createTaskStates.get(insight.id);
                const isDismissInFlight = dismissState?.running ?? false;
                const isCreateInFlight = createState?.running ?? false;

                return (
                  <li key={insight.id} className="insight-item" data-insight-id={insight.id}>
                    <div className="insight-item-header">
                      <h4 className="insight-item-title">{insight.title}</h4>
                      <div className="insight-item-actions">
                        <button
                          className="btn btn-sm btn-icon"
                          onClick={() => void handleCreateTask(insight.id, insight.title)}
                          disabled={isCreateInFlight || isAnyActionInFlight}
                          title="Create task from this insight"
                          aria-label="Create task from this insight"
                          data-testid={`create-task-${insight.id}`}
                        >
                          {isCreateInFlight ? (
                            <RefreshCw size={14} className="spin" />
                          ) : (
                            <Plus size={14} />
                          )}
                        </button>
                        <button
                          className="btn btn-sm btn-icon"
                          onClick={() => void handleDismiss(insight.id, insight.title)}
                          disabled={isDismissInFlight || isAnyActionInFlight}
                          title="Dismiss this insight"
                          aria-label="Dismiss this insight"
                          data-testid={`dismiss-${insight.id}`}
                        >
                          {isDismissInFlight ? (
                            <RefreshCw size={14} className="spin" />
                          ) : (
                            <X size={14} />
                          )}
                        </button>
                      </div>
                    </div>
                    {insight.content && (
                      <p className="insight-item-content">{insight.content}</p>
                    )}
                    <div className="insight-item-meta">
                      <span className={`insight-item-status insight-item-status--${insight.status}`}>
                        {insight.status}
                      </span>
                      {insight.createdAt && (
                        <span className="insight-item-date">
                          <Clock size={12} />
                          {new Date(insight.createdAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="insights-view" data-testid="insights-view">
      <div className="insights-view-header">
        <div className="insights-view-title">
          <h2>
            <Sparkles size={20} />
            Insights
          </h2>
          <span className="insights-view-count">{totalCount} total</span>
        </div>

        <div className="insights-view-actions">
          {onClose && (
            <button
              className="btn btn-icon insights-view-close"
              onClick={onClose}
              aria-label="Close insights view"
            >
              <X size={16} />
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh insights"
            data-testid="refresh-insights"
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Refresh
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleRun()}
            disabled={isRunInFlight}
            aria-label="Generate new insights"
            data-testid="run-insights"
          >
            {isRunInFlight ? (
              <>
                <RefreshCw size={14} className="spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Generate Insights
              </>
            )}
          </button>
        </div>
      </div>

      {/* Inline status region */}
      <div
        className="insights-status-region"
        aria-live="polite"
        data-testid="insights-status"
      >
        {statusMessage && (
          <div
            className={`insights-status-message insights-status-message--${statusType}`}
            role={statusType === "error" ? "alert" : undefined}
          >
            {statusType === "success" && <CheckCircle size={16} />}
            {statusType === "error" && <AlertCircle size={16} />}
            {statusType === "info" && <Sparkles size={16} />}
            <span>{statusMessage}</span>
          </div>
        )}
      </div>

      {/* Run error callout */}
      {runError && (
        <div className="insights-error-callout" role="alert" data-testid="run-error">
          <AlertCircle size={16} />
          <span>{runError}</span>
        </div>
      )}

      {/* Latest run info */}
      {latestRun && (
        <div className="insights-run-info" data-testid="latest-run">
          <span className="insights-run-status">
            Latest run: {latestRun.status}
            {latestRun.status === "completed" && (
              <> — {latestRun.insightsCreated} created, {latestRun.insightsUpdated} updated</>
            )}
            {latestRun.status === "failed" && latestRun.error && (
              <> — {latestRun.error}</>
            )}
          </span>
        </div>
      )}

      {loading ? (
        <div className="insights-loading" data-testid="insights-loading">
          <RefreshCw size={24} className="spin" />
          <p>Loading insights...</p>
        </div>
      ) : error ? (
        <div className="insights-error" data-testid="insights-error">
          <AlertCircle size={24} />
          <p>{error}</p>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : totalCount === 0 ? (
        <div className="insights-empty" data-testid="insights-empty">
          <Sparkles size={48} />
          <h3>No insights yet</h3>
          <p>Generate insights to get AI-powered recommendations for your project.</p>
          <button className="btn btn-primary" onClick={() => void handleRun()}>
            <Sparkles size={14} />
            Generate First Insights
          </button>
        </div>
      ) : (
        <div className="insights-sections">
          {sections.map(renderSection)}
        </div>
      )}
    </div>
  );
}
