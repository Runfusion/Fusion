import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { AgentPerformanceSummary, AgentReflection } from "../api";
import {
  fetchAgentPerformance,
  fetchAgentReflections,
  triggerAgentReflection,
} from "../api";

interface AgentReflectionsTabProps {
  agentId: string;
  projectId?: string;
  addToast: (msg: string, type?: "success" | "error") => void;
}

/** Format a number in milliseconds to a human-readable duration string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Format a percentage value (0-1) to a percentage string */
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Format an ISO timestamp to a relative time string */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return "in a moment";
    if (absDiff < 3_600_000) return `in ${Math.floor(absDiff / 60_000)}m`;
    if (absDiff < 86_400_000) return `in ${Math.floor(absDiff / 3_600_000)}h`;
    return `in ${Math.floor(absDiff / 86_400_000)}d`;
  }

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/** Get display label for a trigger type */
function getTriggerLabel(trigger: string): string {
  switch (trigger) {
    case "periodic":
      return "Periodic";
    case "post-task":
      return "Post-Task";
    case "manual":
      return "Manual";
    case "user-requested":
      return "User Requested";
    default:
      return trigger;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

export function AgentReflectionsTab({ agentId, projectId, addToast }: AgentReflectionsTabProps) {
  const [reflections, setReflections] = useState<AgentReflection[]>([]);
  const [performance, setPerformance] = useState<AgentPerformanceSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReflecting, setIsReflecting] = useState(false);
  const [expandedReflectionId, setExpandedReflectionId] = useState<string | null>(null);

  // Load data on mount
  const loadData = useCallback(async () => {
    try {
      const [reflectionsData, performanceData] = await Promise.all([
        fetchAgentReflections(agentId, 20, projectId),
        fetchAgentPerformance(agentId, undefined, projectId),
      ]);
      setReflections(reflectionsData);
      setPerformance(performanceData);
    } catch (err: any) {
      addToast(`Failed to load reflections: ${err.message}`, "error");
    } finally {
      setIsLoading(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Handle reflect now button
  const handleReflectNow = async () => {
    setIsReflecting(true);
    try {
      const reflection = await triggerAgentReflection(agentId, projectId);
      if (!reflection) {
        addToast("Not enough history to generate a reflection yet", "error");
        return;
      }

      addToast("Reflection generated successfully", "success");
      setIsLoading(true);
      await loadData();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const normalizedMessage = message.toLowerCase();

      if (normalizedMessage.includes("agent not found") || normalizedMessage.includes("not found")) {
        addToast("This agent is no longer available. It may have been deleted.", "error");
      } else if (normalizedMessage.includes("insufficient history")) {
        addToast("Not enough history to generate a reflection yet", "error");
      } else {
        addToast(`Failed to generate reflection: ${message}`, "error");
      }
    } finally {
      setIsReflecting(false);
    }
  };

  // Toggle expanded state
  const toggleExpanded = (id: string) => {
    setExpandedReflectionId((prev) => (prev === id ? null : id));
  };

  if (isLoading) {
    return (
      <div className="reflections-tab">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "24px",
            justifyContent: "center",
          }}
        >
          <Loader2 size={16} className="animate-spin" />
          <span className="text-muted">Loading reflections...</span>
        </div>
      </div>
    );
  }

  // Check if performance summary has no data
  const hasNoPerformanceData =
    performance &&
    performance.totalTasksCompleted === 0 &&
    performance.totalTasksFailed === 0 &&
    performance.recentReflectionCount === 0;

  return (
    <div className="reflections-tab">
      {/* Header */}
      <div className="reflections-header">
        <h3>
          <BarChart3 size={16} />
          Performance & Reflections
        </h3>
        <button
          className="btn btn-secondary"
          onClick={handleReflectNow}
          disabled={isReflecting}
          title="Generate a manual reflection"
        >
          {isReflecting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Reflecting...
            </>
          ) : (
            <>
              <RefreshCw size={14} />
              Reflect Now
            </>
          )}
        </button>
      </div>

      {/* Performance Summary Grid */}
      {performance && !hasNoPerformanceData && (
        <div className="reflections-stats-grid">
          <div className="reflections-stat-card">
            <div className="stat-value">
              <TrendingUp size={16} style={{ color: "var(--color-success)" }} />
              {performance.totalTasksCompleted}
            </div>
            <div className="stat-label">Tasks Completed</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <TrendingDown size={16} style={{ color: "var(--color-error)" }} />
              {performance.totalTasksFailed}
            </div>
            <div className="stat-label">Tasks Failed</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <Zap size={16} style={{ color: "var(--in-progress)" }} />
              {formatDuration(performance.avgDurationMs)}
            </div>
            <div className="stat-label">Avg Duration</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <BarChart3
                size={16}
                style={{
                  color:
                    performance.successRate >= 0.8
                      ? "var(--color-success)"
                      : performance.successRate >= 0.5
                        ? "var(--color-warning)"
                        : "var(--color-error)",
                }}
              />
              {formatPercent(performance.successRate)}
            </div>
            <div className="stat-label">Success Rate</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <Lightbulb size={16} style={{ color: "var(--color-info)" }} />
              {performance.recentReflectionCount}
            </div>
            <div className="stat-label">Reflections</div>
          </div>
        </div>
      )}

      {hasNoPerformanceData && (
        <div className="reflections-no-data">
          <BarChart3 size={24} opacity={0.3} />
          <p>No performance data yet</p>
        </div>
      )}

      {/* Reflections List */}
      <div className="reflections-list">
        <h4>Reflection History</h4>

        {reflections.length === 0 ? (
          <div className="reflection-empty">
            <Lightbulb size={32} opacity={0.3} />
            <p>No reflections yet</p>
            <p className="text-secondary">Trigger a reflection to get started</p>
          </div>
        ) : (
          <div className="reflection-cards">
            {reflections.map((reflection) => {
              const isExpanded = expandedReflectionId === reflection.id;
              return (
                <div
                  key={reflection.id}
                  className={`reflection-card ${isExpanded ? "reflection-card--expanded" : ""}`}
                  onClick={() => toggleExpanded(reflection.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && toggleExpanded(reflection.id)}
                >
                  <div className="reflection-card-header">
                    <span className={`reflection-trigger-badge reflection-trigger-${reflection.trigger}`}>
                      {getTriggerLabel(reflection.trigger)}
                    </span>
                    <span className="reflection-timestamp">{relativeTime(reflection.timestamp)}</span>
                    <span className="reflection-chevron">
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                  </div>

                  <div className="reflection-summary">{reflection.summary}</div>

                  {isExpanded && (
                    <div className="reflection-details">
                      {reflection.insights.length > 0 && (
                        <div className="reflection-insights">
                          <h5>
                            <Lightbulb size={14} /> Insights
                          </h5>
                          <ul>
                            {reflection.insights.map((insight, i) => (
                              <li key={i}>{insight}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {reflection.suggestedImprovements.length > 0 && (
                        <div className="reflection-suggestions">
                          <h5>
                            <TrendingUp size={14} /> Suggested Improvements
                          </h5>
                          <ul>
                            {reflection.suggestedImprovements.map((suggestion, i) => (
                              <li key={i}>{suggestion}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {reflection.metrics && (
                        <div className="reflection-metrics">
                          <h5>Metrics</h5>
                          <div className="metrics-grid">
                            {reflection.metrics.tasksCompleted !== undefined && (
                              <div className="metric">
                                <span className="metric-label">Tasks:</span>
                                <span className="metric-value">{reflection.metrics.tasksCompleted}</span>
                              </div>
                            )}
                            {reflection.metrics.tasksFailed !== undefined && (
                              <div className="metric">
                                <span className="metric-label">Failed:</span>
                                <span className="metric-value">{reflection.metrics.tasksFailed}</span>
                              </div>
                            )}
                            {reflection.metrics.avgDurationMs !== undefined && (
                              <div className="metric">
                                <span className="metric-label">Avg Duration:</span>
                                <span className="metric-value">{formatDuration(reflection.metrics.avgDurationMs)}</span>
                              </div>
                            )}
                            {reflection.metrics.errorCount !== undefined && (
                              <div className="metric">
                                <span className="metric-label">Errors:</span>
                                <span className="metric-value">{reflection.metrics.errorCount}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
