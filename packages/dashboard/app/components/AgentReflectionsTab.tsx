import "./AgentReflectionsTab.css";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import type {
  AgentPerformanceSummary,
  AgentReflection,
} from "../api";
import type { AgentRating, AgentRatingSummary } from "@fusion/core";
import {
  addAgentRating,
  deleteAgentRating,
  fetchAgentPerformance,
  fetchAgentRatings,
  fetchAgentRatingSummary,
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

/**
 * Format an ISO timestamp to a relative time string.
 *
 * FNXC:RelativeTime 2026-06-17-20:48:
 * FN-6618 intentionally leaves AgentReflectionsTab local because its `agents.time.in*` future-time i18n outputs would be lost if getRelativeTimeBucket's negative-diff null were treated as an invalid timestamp.
 */
function relativeTime(iso: string, t: (key: string, defaultValue: string, opts?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    const absDiff = Math.abs(diffMs);
    if (absDiff < 60_000) return t("agents.time.inAMoment", "in a moment");
    if (absDiff < 3_600_000) return t("agents.time.inMinutes", "in {{count}}m", { count: Math.floor(absDiff / 60_000) });
    if (absDiff < 86_400_000) return t("agents.time.inHours", "in {{count}}h", { count: Math.floor(absDiff / 3_600_000) });
    return t("agents.time.inDays", "in {{count}}d", { count: Math.floor(absDiff / 86_400_000) });
  }

  if (diffMs < 60_000) return t("agents.time.justNow", "just now");
  if (diffMs < 3_600_000) return t("agents.time.minutesAgo", "{{count}}m ago", { count: Math.floor(diffMs / 60_000) });
  if (diffMs < 86_400_000) return t("agents.time.hoursAgo", "{{count}}h ago", { count: Math.floor(diffMs / 3_600_000) });
  return t("agents.time.daysAgo", "{{count}}d ago", { count: Math.floor(diffMs / 86_400_000) });
}

/** Get display label for a trigger type */
function getTriggerLabel(trigger: string, t: (key: string, defaultValue: string) => string): string {
  switch (trigger) {
    case "periodic":
      return t("agents.reflections.triggerPeriodic", "Periodic");
    case "post-task":
      return t("agents.reflections.triggerPostTask", "Post-Task");
    case "manual":
      return t("agents.reflections.triggerManual", "Manual");
    case "user-requested":
      return t("agents.reflections.triggerUserRequested", "User Requested");
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

function getTrendLabel(trend: string, t: (key: string, defaultValue: string) => string): string {
  switch (trend) {
    case "improving":
      return t("agents.ratings.trendImproving", "↑ Improving");
    case "declining":
      return t("agents.ratings.trendDeclining", "↓ Declining");
    case "stable":
      return t("agents.ratings.trendStable", "→ Stable");
    default:
      return t("agents.ratings.trendInsufficient", "Insufficient data");
  }
}

function getTrendClass(trend: string): string {
  switch (trend) {
    case "improving":
      return "trend-improving";
    case "declining":
      return "trend-declining";
    case "stable":
      return "trend-stable";
    default:
      return "trend-insufficient";
  }
}

function renderStars(score: number, maxScore: number = 5) {
  return (
    <span className="rating-stars">
      {Array.from({ length: maxScore }, (_, i) => (
        <Star
          key={i}
          size={14}
          className={i < score ? "star-filled" : "star-empty"}
          fill={i < score ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}

export function AgentReflectionsTab({ agentId, projectId, addToast }: AgentReflectionsTabProps) {
  const { t } = useTranslation("app");
  const [reflections, setReflections] = useState<AgentReflection[]>([]);
  const [performance, setPerformance] = useState<AgentPerformanceSummary | null>(null);
  const [ratingSummary, setRatingSummary] = useState<AgentRatingSummary | null>(null);
  const [ratings, setRatings] = useState<AgentRating[]>([]);
  const [isLoadingReflections, setIsLoadingReflections] = useState(true);
  const [isLoadingRatings, setIsLoadingRatings] = useState(true);
  const [isReflecting, setIsReflecting] = useState(false);
  const [isSubmittingRating, setIsSubmittingRating] = useState(false);
  const [expandedReflectionId, setExpandedReflectionId] = useState<string | null>(null);
  const [newScore, setNewScore] = useState(0);
  const [newCategory, setNewCategory] = useState("");
  const [newComment, setNewComment] = useState("");

  const loadReflectionData = useCallback(async () => {
    try {
      const [reflectionsData, performanceData] = await Promise.all([
        fetchAgentReflections(agentId, 20, projectId),
        fetchAgentPerformance(agentId, undefined, projectId),
      ]);
      setReflections(reflectionsData);
      setPerformance(performanceData);
    } catch (err) {
      addToast(t("agents.reflections.loadError", "Failed to load reflections: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsLoadingReflections(false);
    }
  }, [agentId, projectId, addToast]);

  const loadRatingsData = useCallback(async () => {
    try {
      const [summaryData, ratingsData] = await Promise.all([
        fetchAgentRatingSummary(agentId, projectId),
        fetchAgentRatings(agentId, { limit: 50 }, projectId),
      ]);
      setRatingSummary(summaryData);
      setRatings(ratingsData);
    } catch (err) {
      addToast(t("agents.ratings.loadError", "Failed to load ratings: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsLoadingRatings(false);
    }
  }, [agentId, projectId, addToast]);

  useEffect(() => {
    void loadReflectionData();
    void loadRatingsData();
  }, [loadReflectionData, loadRatingsData]);

  const handleReflectNow = async () => {
    setIsReflecting(true);
    try {
      const reflection = await triggerAgentReflection(agentId, projectId);
      if (!reflection) {
        addToast(t("agents.reflections.insufficientHistory", "Not enough history to generate a reflection yet"), "error");
        return;
      }

      addToast(t("agents.reflections.generateSuccess", "Reflection generated successfully"), "success");
      setIsLoadingReflections(true);
      await loadReflectionData();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const normalizedMessage = message.toLowerCase();

      if (normalizedMessage.includes("agent not found") || normalizedMessage.includes("not found")) {
        addToast(t("agents.reflections.agentNotFound", "This agent is no longer available. It may have been deleted."), "error");
      } else if (normalizedMessage.includes("insufficient history")) {
        addToast(t("agents.reflections.insufficientHistory", "Not enough history to generate a reflection yet"), "error");
      } else {
        addToast(t("agents.reflections.generateError", "Failed to generate reflection: {{error}}", { error: message }), "error");
      }
    } finally {
      setIsReflecting(false);
    }
  };

  const handleSubmitRating = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newScore === 0) return;

    setIsSubmittingRating(true);
    try {
      await addAgentRating(agentId, {
        score: newScore,
        category: newCategory || undefined,
        comment: newComment || undefined,
        raterType: "user",
      }, projectId);

      setNewScore(0);
      setNewCategory("");
      setNewComment("");
      addToast(t("agents.ratings.addSuccess", "Rating added"), "success");
      await loadRatingsData();
    } catch (err) {
      addToast(t("agents.ratings.addError", "Failed to add rating: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsSubmittingRating(false);
    }
  };

  const handleDeleteRating = async (ratingId: string) => {
    try {
      await deleteAgentRating(agentId, ratingId, projectId);
      addToast(t("agents.ratings.deleteSuccess", "Rating deleted"), "success");
      await loadRatingsData();
    } catch (err) {
      addToast(t("agents.ratings.deleteError", "Failed to delete rating: {{error}}", { error: getErrorMessage(err) }), "error");
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedReflectionId((prev) => (prev === id ? null : id));
  };

  if (isLoadingReflections && isLoadingRatings) {
    return (
      <div className="reflections-tab">
        <div className="reflections-loading-indicator">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-muted">{t("agents.reflections.loadingEvaluation", "Loading evaluation...")}</span>
        </div>
      </div>
    );
  }

  const hasNoPerformanceData =
    performance &&
    performance.totalTasksCompleted === 0 &&
    performance.totalTasksFailed === 0 &&
    performance.recentReflectionCount === 0;

  return (
    <div className="reflections-tab">
      <div className="reflections-header">
        <h3>
          <BarChart3 size={16} />
          {t("agents.reflections.sectionTitle", "Performance, Reflections & Ratings")}
        </h3>
        <button
          className="btn btn-secondary"
          onClick={handleReflectNow}
          disabled={isReflecting}
          title={t("agents.reflections.reflectNowTitle", "Generate a manual reflection")}
        >
          {isReflecting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t("agents.reflections.reflecting", "Reflecting...")}
            </>
          ) : (
            <>
              <RefreshCw size={14} />
              {t("agents.reflections.reflectNow", "Reflect Now")}
            </>
          )}
        </button>
      </div>

      {performance && !hasNoPerformanceData && (
        <div className="reflections-stats-grid">
          <div className="reflections-stat-card">
            <div className="stat-value">
              <TrendingUp size={16} style={{ color: "var(--color-success)" }} />
              {performance.totalTasksCompleted}
            </div>
            <div className="stat-label">{t("agents.performance.tasksCompleted", "Tasks Completed")}</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <TrendingDown size={16} style={{ color: "var(--color-error)" }} />
              {performance.totalTasksFailed}
            </div>
            <div className="stat-label">{t("agents.performance.tasksFailed", "Tasks Failed")}</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <Zap size={16} style={{ color: "var(--in-progress)" }} />
              {formatDuration(performance.avgDurationMs)}
            </div>
            <div className="stat-label">{t("agents.performance.avgDuration", "Avg Duration")}</div>
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
            <div className="stat-label">{t("agents.performance.successRate", "Success Rate")}</div>
          </div>

          <div className="reflections-stat-card">
            <div className="stat-value">
              <Lightbulb size={16} style={{ color: "var(--color-info)" }} />
              {performance.recentReflectionCount}
            </div>
            <div className="stat-label">{t("agents.performance.reflections", "Reflections")}</div>
          </div>
        </div>
      )}

      {hasNoPerformanceData && (
        <div className="reflections-no-data">
          <BarChart3 size={24} opacity={0.3} />
          <p>{t("agents.performance.noData", "No performance data yet")}</p>
        </div>
      )}

      <div className="reflections-ratings-section">
        <h4>{t("agents.ratings.title", "User Ratings")}</h4>

        {isLoadingRatings ? (
          <div className="reflections-loading-indicator">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-muted">{t("agents.ratings.loading", "Loading ratings...")}</span>
          </div>
        ) : (
          <>
            {ratingSummary && (
              <div className="rating-summary-card">
                <div className="rating-score-display">
                  <span className="rating-average">{ratingSummary.averageScore.toFixed(1)}</span>
                  {renderStars(Math.round(ratingSummary.averageScore))}
                </div>
                <div className="rating-stats">
                  <span className="rating-count">{t("agents.ratings.count", "{{count}} ratings", { count: ratingSummary.totalRatings })}</span>
                  <span className={`rating-trend-badge ${getTrendClass(ratingSummary.trend)}`}>
                    {getTrendLabel(ratingSummary.trend, t)}
                  </span>
                </div>
              </div>
            )}

            {ratingSummary && Object.keys(ratingSummary.categoryAverages).length > 0 && (
              <div className="category-breakdown">
                <h4>{t("agents.ratings.categoryAverages", "Category Averages")}</h4>
                {Object.entries(ratingSummary.categoryAverages as Record<string, number>).map(([category, avg]) => (
                  <div key={category} className="category-item">
                    <span className="category-name">{category}</span>
                    <span className="category-score">{avg.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}

            <form className="add-rating-form" onSubmit={handleSubmitRating}>
              <h4>{t("agents.ratings.addRating", "Add Rating")}</h4>
              <div className="star-selector">
                {[1, 2, 3, 4, 5].map((score) => (
                  <button
                    key={score}
                    type="button"
                    className="star-btn touch-target"
                    onClick={() => setNewScore(score)}
                    title={t("agents.ratings.starCount", "{{count}} star", { count: score, defaultValue_one: "{{count}} star", defaultValue_other: "{{count}} stars" })}
                  >
                    <Star
                      size={24}
                      fill={score <= newScore ? "currentColor" : "none"}
                      className={score <= newScore ? "star-filled" : "star-empty"}
                    />
                  </button>
                ))}
              </div>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="select add-rating-category-select"
              >
                <option value="">{t("agents.ratings.categorySelect", "Select category...")}</option>
                <option value="quality">{t("agents.ratings.categoryQuality", "Quality")}</option>
                <option value="speed">{t("agents.ratings.categorySpeed", "Speed")}</option>
                <option value="communication">{t("agents.ratings.categoryCommunication", "Communication")}</option>
                <option value="reliability">{t("agents.ratings.categoryReliability", "Reliability")}</option>
                <option value="other">{t("agents.ratings.categoryOther", "Other")}</option>
              </select>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={t("agents.ratings.commentPlaceholder", "Optional comment...")}
                className="input add-rating-comment-input"
                rows={3}
              />
              <button
                type="submit"
                className="btn btn-task-create"
                disabled={newScore === 0 || isSubmittingRating}
              >
                {isSubmittingRating ? t("agents.ratings.submitting", "Submitting...") : t("agents.ratings.submitRating", "Submit Rating")}
              </button>
            </form>

            <div className="rating-history">
              <h4>{t("agents.ratings.historyTitle", "Rating History")}</h4>
              {ratings.length === 0 ? (
                <p className="no-ratings">{t("agents.ratings.noRatings", "No ratings yet")}</p>
              ) : (
                ratings.map((rating) => (
                  <div key={rating.id} className="rating-history-item">
                    <div className="rating-item-header">
                      {renderStars(rating.score)}
                      {rating.category && (
                        <span className="rating-category-badge">{rating.category}</span>
                      )}
                      <span className="rating-time">{relativeTime(rating.createdAt, t)}</span>
                      <button
                        type="button"
                        className="rating-delete-btn touch-target"
                        onClick={() => void handleDeleteRating(rating.id)}
                        title={t("agents.ratings.deleteRating", "Delete rating")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {rating.comment && (
                      <p className="rating-comment">{rating.comment}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="reflections-list">
        <h4>{t("agents.reflections.historyTitle", "Reflection History")}</h4>

        {isLoadingReflections ? (
          <div className="reflections-loading-indicator">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-muted">{t("agents.reflections.loading", "Loading reflections...")}</span>
          </div>
        ) : reflections.length === 0 ? (
          <div className="reflection-empty">
            <Lightbulb size={32} opacity={0.3} />
            <p>{t("agents.reflections.noReflections", "No reflections yet")}</p>
            <p className="text-secondary">{t("agents.reflections.getStarted", "Trigger a reflection to get started")}</p>
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
                      {getTriggerLabel(reflection.trigger, t)}
                    </span>
                    <span className="reflection-timestamp">{relativeTime(reflection.timestamp, t)}</span>
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
                            <Lightbulb size={14} /> {t("agents.reflections.insights", "Insights")}
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
                            <TrendingUp size={14} /> {t("agents.reflections.suggestedImprovements", "Suggested Improvements")}
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
                          <h5>{t("agents.reflections.metrics", "Metrics")}</h5>
                          <div className="metrics-grid">
                            {reflection.metrics.tasksCompleted !== undefined && (
                              <div className="metric">
                                <span className="metric-label">{t("agents.reflections.metricTasks", "Tasks:")}</span>
                                <span className="metric-value">{reflection.metrics.tasksCompleted}</span>
                              </div>
                            )}
                            {reflection.metrics.tasksFailed !== undefined && (
                              <div className="metric">
                                <span className="metric-label">{t("agents.reflections.metricFailed", "Failed:")}</span>
                                <span className="metric-value">{reflection.metrics.tasksFailed}</span>
                              </div>
                            )}
                            {reflection.metrics.avgDurationMs !== undefined && (
                              <div className="metric">
                                <span className="metric-label">{t("agents.reflections.metricAvgDuration", "Avg Duration:")}</span>
                                <span className="metric-value">{formatDuration(reflection.metrics.avgDurationMs)}</span>
                              </div>
                            )}
                            {reflection.metrics.errorCount !== undefined && (
                              <div className="metric">
                                <span className="metric-label">{t("agents.reflections.metricErrors", "Errors:")}</span>
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
