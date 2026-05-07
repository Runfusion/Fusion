/**
 * InsightsView - Dashboard component for displaying and managing project insights
 *
 * Two-pane layout: categories on the left, insights for the selected category on the right.
 */

import "./InsightsView.css";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  ArchiveRestore,
  Clock,
  Settings,
} from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { fetchModels, updateGlobalSettings, type ModelInfo } from "../api";
import { useInsights, type InsightSection } from "../hooks/useInsights";
import type { InsightCategory } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

interface InsightsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onClose?: () => void;
  onCreateTask?: (payload: { insightId: string; title: string; description: string }) => Promise<void>;
  models?: ModelInfo[];
}

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

export function InsightsView({ projectId, addToast, onClose, onCreateTask, models: modelsProp }: InsightsViewProps) {
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
    archive = async () => {},
    unarchive = async () => {},
    toggleShowArchived = () => {},
    dismissStates,
    createTaskStates,
    archiveStates = new Map(),
    unarchiveStates = new Map(),
    totalCount,
    archivedCount = 0,
    showArchived = false,
  } = useInsights(projectId);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"success" | "error" | "info">("info");

  const [showModelConfig, setShowModelConfig] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem("fusion-insight-model") ?? ""
  );

  // Fetch models internally if not provided via prop
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [resolvedPlanningProvider, setResolvedPlanningProvider] = useState<string | undefined>();
  useEffect(() => {
    if (modelsProp) return;
    fetchModels()
      .then((res) => {
        setFetchedModels(res.models);
        setFavoriteProviders(res.favoriteProviders);
        setFavoriteModels(res.favoriteModels);
        setResolvedPlanningProvider(res.resolvedPlanningProvider);

        // Clear persisted model override if the model is no longer available
        const savedModel = localStorage.getItem("fusion-insight-model");
        if (savedModel) {
          const available = res.models.some((m) => `${m.provider}/${m.id}` === savedModel);
          if (!available) {
            localStorage.removeItem("fusion-insight-model");
            setSelectedModel("");
          }
        }
      })
      .catch(() => {});
  }, [modelsProp]);
  const models = modelsProp ?? fetchedModels;

  // Auto-promote the resolved planning provider as a favorite when the user
  // hasn't explicitly starred any providers. This ensures the provider they
  // actively use always appears at the top of the dropdown.
  const effectiveFavoriteProviders = useMemo(() => {
    if (favoriteProviders.length > 0) return favoriteProviders;
    if (resolvedPlanningProvider) return [resolvedPlanningProvider];
    return [];
  }, [favoriteProviders, resolvedPlanningProvider]);

  const handleToggleProviderFavorite = useCallback(async (provider: string) => {
    const isFavorite = favoriteProviders.includes(provider);
    const next = isFavorite
      ? favoriteProviders.filter((p) => p !== provider)
      : [provider, ...favoriteProviders];
    setFavoriteProviders(next);
    try {
      await updateGlobalSettings({ favoriteProviders: next, favoriteModels });
    } catch {
      setFavoriteProviders(favoriteProviders);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const isFavorite = favoriteModels.includes(modelId);
    const next = isFavorite
      ? favoriteModels.filter((m) => m !== modelId)
      : [modelId, ...favoriteModels];
    setFavoriteModels(next);
    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: next });
    } catch {
      setFavoriteModels(favoriteModels);
    }
  }, [favoriteModels, favoriteProviders]);

  const handleModelChange = useCallback((value: string) => {
    setSelectedModel(value);
    if (value) {
      localStorage.setItem("fusion-insight-model", value);
    } else {
      localStorage.removeItem("fusion-insight-model");
    }
  }, []);

  const populatedSections = useMemo(
    () => sections.filter((section) => section.items.length > 0),
    [sections],
  );

  const [selectedCategory, setSelectedCategory] = useState<InsightCategory | null>(null);

  // Keep selection valid as data changes; default to first populated section.
  useEffect(() => {
    if (populatedSections.length === 0) {
      if (selectedCategory !== null) setSelectedCategory(null);
      return;
    }
    const stillExists = selectedCategory && populatedSections.some((s) => s.category === selectedCategory);
    if (!stillExists) {
      setSelectedCategory(populatedSections[0].category);
    }
  }, [populatedSections, selectedCategory]);

  const activeSection: InsightSection | undefined = useMemo(
    () => populatedSections.find((s) => s.category === selectedCategory) ?? populatedSections[0],
    [populatedSections, selectedCategory],
  );

  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  const handleRun = useCallback(async () => {
    try {
      setStatusMessage("Generating insights...");
      setStatusType("info");

      let modelProvider: string | undefined;
      let modelId: string | undefined;
      if (selectedModel) {
        const slashIdx = selectedModel.indexOf("/");
        if (slashIdx !== -1) {
          const provider = selectedModel.slice(0, slashIdx);
          const id = selectedModel.slice(slashIdx + 1);
          if (provider && id) {
            modelProvider = provider;
            modelId = id;
          }
        }
      }

      await runInsights(modelProvider, modelId);
      setStatusMessage("Insight generation started");
      setStatusType("success");
      addToast("Insight generation started", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start generation";
      setStatusMessage(message);
      setStatusType("error");
      addToast(message, "error");
    }
  }, [runInsights, addToast, selectedModel]);

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

  const handleArchive = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(`Archiving "${title}"...`);
        setStatusType("info");
        await archive(id);
        setStatusMessage(`Archived "${title}"`);
        setStatusType("success");
        addToast(`Insight archived: ${title}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to archive insight";
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [archive, addToast],
  );

  const handleUnarchive = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(`Unarchiving "${title}"...`);
        setStatusType("info");
        await unarchive(id);
        setStatusMessage(`Unarchived "${title}"`);
        setStatusType("success");
        addToast(`Insight unarchived: ${title}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to unarchive insight";
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [unarchive, addToast],
  );

  const handleCreateTask = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(`Creating task from "${title}"...`);
        setStatusType("info");

        if (!onCreateTask) {
          throw new Error("Task creation is unavailable in this view");
        }

        const taskData = await createTaskFromInsight(id);
        if (!taskData) {
          throw new Error("Failed to prepare task payload from insight");
        }

        await onCreateTask({
          insightId: id,
          title: taskData.title,
          description: taskData.description,
        });

        setStatusMessage(`Task created from "${title}"`);
        setStatusType("success");
        addToast(`Task created: ${taskData.title}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create task";
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [createTaskFromInsight, onCreateTask, addToast],
  );

  const renderCategoryItem = (section: InsightSection) => {
    const IconComponent = CATEGORY_ICONS[section.category] ?? Sparkles;
    const isActive = activeSection?.category === section.category;
    return (
      <li key={section.category}>
        <button
          type="button"
          className={`insights-category-item${isActive ? " insights-category-item--active" : ""}`}
          onClick={() => setSelectedCategory(section.category)}
          aria-current={isActive ? "true" : undefined}
          data-testid={`insights-category-${section.category}`}
        >
          <IconComponent size={16} className="insights-category-icon" />
          <span className="insights-category-label">{section.label}</span>
          <span className="insights-category-count">{section.items.length}</span>
        </button>
      </li>
    );
  };

  const renderActiveInsights = () => {
    if (!activeSection) return null;
    const IconComponent = CATEGORY_ICONS[activeSection.category] ?? Sparkles;

    return (
      <section
        className="insights-section"
        data-testid={`insights-section-${activeSection.category}`}
      >
        <div className="insights-section-header">
          <div className="insights-section-title">
            <IconComponent size={20} className="insights-section-icon" />
            <h3>{activeSection.label}</h3>
            <span className="insights-section-count">{activeSection.items.length}</span>
          </div>
        </div>

        <div className="insights-section-content">
          <ul className="insights-list">
            {activeSection.items.map((insight) => {
              const dismissState = dismissStates.get(insight.id);
              const createState = createTaskStates.get(insight.id);
              const archiveState = archiveStates.get(insight.id);
              const unarchiveState = unarchiveStates.get(insight.id);
              const isDismissInFlight = dismissState?.running ?? false;
              const isCreateInFlight = createState?.running ?? false;
              const isArchiveInFlight = archiveState?.running ?? false;
              const isUnarchiveInFlight = unarchiveState?.running ?? false;
              const isArchived = insight.status === "archived";
              const isAnyActionInFlight = activeSection.items.some(
                (item) =>
                  dismissStates.get(item.id)?.running ||
                  createTaskStates.get(item.id)?.running ||
                  archiveStates.get(item.id)?.running ||
                  unarchiveStates.get(item.id)?.running,
              );

              return (
                <li key={insight.id} className={`insight-item${isArchived ? " insight-item--archived" : ""}`} data-insight-id={insight.id}>
                  <div className="insight-item-header">
                    <h4 className="insight-item-title">{insight.title}</h4>
                    <div className="insight-item-actions">
                      {isArchived ? (
                        <button
                          className="insight-item-action-btn"
                          onClick={() => void handleUnarchive(insight.id, insight.title)}
                          disabled={isUnarchiveInFlight || isAnyActionInFlight}
                          title="Unarchive this insight"
                          aria-label="Unarchive this insight"
                          data-testid={`unarchive-${insight.id}`}
                        >
                          {isUnarchiveInFlight ? <RefreshCw size={20} className="spin" /> : <ArchiveRestore size={20} />}
                        </button>
                      ) : (
                        <>
                          <button
                            className="insight-item-action-btn"
                            onClick={() => void handleCreateTask(insight.id, insight.title)}
                            disabled={isCreateInFlight || isAnyActionInFlight}
                            title="Create task from this insight"
                            aria-label="Create task from this insight"
                            data-testid={`create-task-${insight.id}`}
                          >
                            {isCreateInFlight ? <RefreshCw size={20} className="spin" /> : <Plus size={20} />}
                          </button>
                          <button
                            className="insight-item-action-btn"
                            onClick={() => void handleArchive(insight.id, insight.title)}
                            disabled={isArchiveInFlight || isAnyActionInFlight}
                            title="Archive this insight"
                            aria-label="Archive this insight"
                            data-testid={`archive-${insight.id}`}
                          >
                            {isArchiveInFlight ? <RefreshCw size={20} className="spin" /> : <Archive size={20} />}
                          </button>
                        </>
                      )}
                      <button
                        className="insight-item-action-btn"
                        onClick={() => void handleDismiss(insight.id, insight.title)}
                        disabled={isDismissInFlight || isAnyActionInFlight}
                        title="Dismiss this insight"
                        aria-label="Dismiss this insight"
                        data-testid={`dismiss-${insight.id}`}
                      >
                        {isDismissInFlight ? (
                          <RefreshCw size={20} className="spin" />
                        ) : (
                          <X size={20} />
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
              className="btn btn-sm insights-view-close"
              onClick={onClose}
              aria-label="Close insights view"
              title="Close"
            >
              <X size={16} />
            </button>
          )}
          {archivedCount > 0 && (
            <button
              className="btn btn-sm insights-show-archived-toggle"
              onClick={toggleShowArchived}
              aria-label={showArchived ? "Hide archived insights" : "Show archived insights"}
              data-testid="toggle-archived-insights"
            >
              <Archive size={14} />
              {showArchived ? "Hide Archived" : `Show Archived (${archivedCount})`}
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
            className="btn btn-sm insights-model-toggle"
            onClick={() => setShowModelConfig((prev) => !prev)}
            aria-label="Configure insight generation model"
            aria-expanded={showModelConfig}
            data-testid="toggle-model-config"
            title={selectedModel ? `Model: ${selectedModel}` : "Configure model"}
          >
            <Settings size={14} />
            {selectedModel && <span className="insights-model-indicator" />}
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

      {showModelConfig && (
        <div className="insights-model-config" data-testid="model-config">
          <label htmlFor="insight-model-select" className="insights-model-label">
            Model
          </label>
          <CustomModelDropdown
            models={models}
            value={selectedModel}
            onChange={handleModelChange}
            placeholder="Use planning default"
            label="Insight generation model"
            disabled={isRunInFlight}
            id="insight-model-select"
            favoriteProviders={effectiveFavoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleProviderFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
          />
        </div>
      )}

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

      {runError && (
        <div className="insights-error-callout" role="alert" data-testid="run-error">
          <AlertCircle size={16} />
          <span>{runError}</span>
        </div>
      )}

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
        <div className="insights-body">
          <aside className="insights-sidebar" aria-label="Insight categories">
            <ul className="insights-category-list">
              {populatedSections.map(renderCategoryItem)}
            </ul>
          </aside>
          <div className="insights-detail">
            {renderActiveInsights()}
          </div>
        </div>
      )}
    </div>
  );
}
