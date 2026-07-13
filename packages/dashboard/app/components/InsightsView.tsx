/**
 * InsightsView - Dashboard component for displaying and managing project insights
 *
 * Two-pane layout: categories on the left, insights for the selected category on the right.
 */

import "./InsightsView.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  Activity,
} from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ViewHeader } from "./ViewHeader";
import { fetchModels, updateGlobalSettings, type ModelInfo } from "../api";
import { useInsights, type InsightSection } from "../hooks/useInsights";
import { BACKLOG_HEALTH_TITLE_PREFIXES, isBacklogHealthInsight } from "./backlog-health-filter";
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
  const { t } = useTranslation("app");
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
  const [backlogHealthOnly, setBacklogHealthOnly] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem("fusion-insight-model") ?? ""
  );
  const [selectedThinking, setSelectedThinking] = useState<string>(
    () => localStorage.getItem("fusion-insight-thinking") ?? ""
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

  const handleThinkingChange = useCallback((value: string) => {
    setSelectedThinking(value);
    if (value) {
      localStorage.setItem("fusion-insight-thinking", value);
    } else {
      localStorage.removeItem("fusion-insight-thinking");
    }
  }, []);

  const populatedSections = useMemo(
    () => sections.filter((section) => section.items.length > 0),
    [sections],
  );

  const backlogHealthCount = useMemo(
    () => populatedSections.reduce((total, section) => total + section.items.filter(isBacklogHealthInsight).length, 0),
    [populatedSections],
  );

  const filteredSections = useMemo(() => {
    if (!backlogHealthOnly) {
      return populatedSections;
    }

    return populatedSections
      .map((section) => ({
        ...section,
        items: section.items.filter(isBacklogHealthInsight),
      }))
      .filter((section) => section.items.length > 0);
  }, [populatedSections, backlogHealthOnly]);

  const [selectedCategory, setSelectedCategory] = useState<InsightCategory | null>(null);

  // Keep selection valid as data changes; default to first populated section.
  useEffect(() => {
    if (filteredSections.length === 0) {
      if (selectedCategory !== null) setSelectedCategory(null);
      return;
    }
    const stillExists = selectedCategory && filteredSections.some((s) => s.category === selectedCategory && s.items.length > 0);
    if (!stillExists) {
      setSelectedCategory(filteredSections[0].category);
    }
  }, [filteredSections, selectedCategory]);

  const activeSection: InsightSection | undefined = useMemo(
    () => filteredSections.find((s) => s.category === selectedCategory) ?? filteredSections[0],
    [filteredSections, selectedCategory],
  );

  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  const handleRun = useCallback(async () => {
    try {
      setStatusMessage(t("insights.generatingInsights", "Generating insights..."));
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

      await runInsights(modelProvider, modelId, selectedThinking || undefined);
      setStatusMessage(t("insights.generationStarted", "Insight generation started"));
      setStatusType("success");
      addToast(t("insights.generationStarted", "Insight generation started"), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("insights.failedToStart", "Failed to start generation");
      if (message === "Insight generation is already running") {
        setStatusMessage(t("insights.alreadyRunning", "Insight generation is already running. Showing the active run."));
        setStatusType("info");
        addToast(t("insights.alreadyRunningShort", "Insight generation is already running"), "info");
        return;
      }
      setStatusMessage(message);
      setStatusType("error");
      addToast(message, "error");
    }
  }, [runInsights, addToast, selectedModel, selectedThinking, t]);

  const handleDismiss = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(t("insights.dismissing", "Dismissing \"{{title}}\"...", { title }));
        setStatusType("info");
        await dismiss(id);
        setStatusMessage(t("insights.dismissed", "Dismissed \"{{title}}\"", { title }));
        setStatusType("success");
        addToast(t("insights.dismissedMsg", "Insight dismissed: {{title}}", { title }), "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : t("insights.failedToDismiss", "Failed to dismiss insight");
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [dismiss, addToast, t],
  );

  const handleArchive = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(t("insights.archiving", "Archiving \"{{title}}\"...", { title }));
        setStatusType("info");
        await archive(id);
        setStatusMessage(t("insights.archived", "Archived \"{{title}}\"", { title }));
        setStatusType("success");
        addToast(t("insights.archivedMsg", "Insight archived: {{title}}", { title }), "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : t("insights.failedToArchive", "Failed to archive insight");
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [archive, addToast, t],
  );

  const handleUnarchive = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(t("insights.unarchiving", "Unarchiving \"{{title}}\"...", { title }));
        setStatusType("info");
        await unarchive(id);
        setStatusMessage(t("insights.unarchived", "Unarchived \"{{title}}\"", { title }));
        setStatusType("success");
        addToast(t("insights.unarchivedMsg", "Insight unarchived: {{title}}", { title }), "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : t("insights.failedToUnarchive", "Failed to unarchive insight");
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [unarchive, addToast, t],
  );

  const handleCreateTask = useCallback(
    async (id: string, title: string) => {
      try {
        setStatusMessage(t("insights.creatingTask", "Creating task from \"{{title}}\"...", { title }));
        setStatusType("info");

        if (!onCreateTask) {
          throw new Error(t("insights.taskCreationUnavailable", "Task creation is unavailable in this view"));
        }

        const taskData = await createTaskFromInsight(id);
        if (!taskData) {
          throw new Error(t("insights.failedToPreparePayload", "Failed to prepare task payload from insight"));
        }

        await onCreateTask({
          insightId: id,
          title: taskData.title,
          description: taskData.description,
        });

        setStatusMessage(t("insights.taskCreated", "Task created from \"{{title}}\"", { title }));
        setStatusType("success");
        addToast(t("insights.taskCreatedMsg", "Task created: {{title}}", { title: taskData.title }), "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : t("insights.failedToCreateTask", "Failed to create task");
        setStatusMessage(message);
        setStatusType("error");
        addToast(message, "error");
      }
    },
    [createTaskFromInsight, onCreateTask, addToast, t],
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
            <IconComponent size={18} className="insights-section-icon" />
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
                          title={t("insights.unarchiveTitle", "Unarchive this insight")}
                          aria-label={t("insights.unarchiveLabel", "Unarchive this insight")}
                          data-testid={`unarchive-${insight.id}`}
                        >
                          {isUnarchiveInFlight ? <RefreshCw size={16} className="spin" /> : <ArchiveRestore size={16} />}
                        </button>
                      ) : (
                        <>
                          <button
                            className="insight-item-action-btn"
                            onClick={() => void handleCreateTask(insight.id, insight.title)}
                            disabled={isCreateInFlight || isAnyActionInFlight}
                            title={t("insights.createTaskTitle", "Create task from this insight")}
                            aria-label={t("insights.createTaskLabel", "Create task from this insight")}
                            data-testid={`create-task-${insight.id}`}
                          >
                            {isCreateInFlight ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
                          </button>
                          <button
                            className="insight-item-action-btn"
                            onClick={() => void handleArchive(insight.id, insight.title)}
                            disabled={isArchiveInFlight || isAnyActionInFlight}
                            title={t("insights.archiveTitle", "Archive this insight")}
                            aria-label={t("insights.archiveLabel", "Archive this insight")}
                            data-testid={`archive-${insight.id}`}
                          >
                            {isArchiveInFlight ? <RefreshCw size={16} className="spin" /> : <Archive size={16} />}
                          </button>
                        </>
                      )}
                      <button
                        className="insight-item-action-btn"
                        onClick={() => void handleDismiss(insight.id, insight.title)}
                        disabled={isDismissInFlight || isAnyActionInFlight}
                        title={t("insights.dismissTitle", "Dismiss this insight")}
                        aria-label={t("insights.dismissLabel", "Dismiss this insight")}
                        data-testid={`dismiss-${insight.id}`}
                      >
                        {isDismissInFlight ? (
                          <RefreshCw size={16} className="spin" />
                        ) : (
                          <X size={16} />
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
      {/*
      FNXC:Insights 2026-06-22-01:00:
      Migrated to the shared ViewHeader for consistency with other main-content views. The insight count and action buttons live in the actions slot; ViewHeader already provides the --space-lg side/top padding and --space-md bottom gap, so the view body must not repeat the top padding.

      FNXC:Insights 2026-06-23-19:20:
      The refresh action must be icon-only in the Insights header. Keeping the visible label out of this button preserves room for the title and neighboring controls while aria-label/title retain the accessible command name.

      FNXC:Insights 2026-06-23-00:23:
      Insights header filter chips need compact visible labels. Keep the descriptive accessibility copy, but show Backlog instead of Backlog Health and Archived instead of Show Archived/Hide Archived.
      */}
      <ViewHeader
        icon={Sparkles}
        title={t("insights.title", "Insights")}
        actions={(
          <>
            <span className="insights-view-count">{totalCount} {t("common.total", "total")}</span>
          {backlogHealthCount > 0 && (
            <button
              className={`btn btn-sm insights-backlog-health-toggle${backlogHealthOnly ? " btn-icon--active" : ""}`}
              onClick={() => setBacklogHealthOnly((prev) => !prev)}
              aria-pressed={backlogHealthOnly}
              aria-label={backlogHealthOnly ? t("insights.showAllInsights", "Show all insights") : t("insights.showBacklogHealth", "Show only backlog health insights")}
              data-testid="toggle-backlog-health"
              title={BACKLOG_HEALTH_TITLE_PREFIXES.join(", ")}
            >
              <Activity size={14} />
              {backlogHealthOnly ? t("insights.allInsights", "All Insights") : t("insights.backlogHealth", "Backlog")} <span>({backlogHealthCount})</span>
            </button>
          )}
          {onClose && (
            <button
              className="btn btn-sm insights-view-close"
              onClick={onClose}
              aria-label={t("actions.closeInsightsView", "Close insights view")}
              title={t("actions.close", "Close")}
            >
              <X size={16} />
            </button>
          )}
          {archivedCount > 0 && (
            <button
              className="btn btn-sm insights-show-archived-toggle"
              onClick={toggleShowArchived}
              aria-label={showArchived ? t("insights.hideArchived", "Hide archived insights") : t("insights.showArchived", "Show archived insights")}
              data-testid="toggle-archived-insights"
            >
              <Archive size={14} />
              {showArchived ? t("insights.hideArchivedLabel", "Archived") : t("insights.showArchivedLabel", "Archived ({{count}})", { count: archivedCount })}
            </button>
          )}
          <button
            className="btn btn-icon btn-sm insights-refresh-btn"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("actions.refreshInsights", "Refresh insights")}
            title={t("actions.refreshInsights", "Refresh insights")}
            data-testid="refresh-insights"
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button
            className="btn btn-sm insights-model-toggle"
            onClick={() => setShowModelConfig((prev) => !prev)}
            aria-label={t("insights.configureModel", "Configure insight generation model")}
            aria-expanded={showModelConfig}
            data-testid="toggle-model-config"
            title={selectedModel ? t("insights.modelConfigured", "Model: {{model}}", { model: selectedModel }) : t("insights.configureModelTitle", "Configure model")}
          >
            <Settings size={14} />
            {selectedModel && <span className="insights-model-indicator" />}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleRun()}
            disabled={isRunInFlight}
            aria-label={t("insights.generateInsights", "Generate new insights")}
            data-testid="run-insights"
          >
            {isRunInFlight ? (
              <>
                <RefreshCw size={14} className="spin" />
                {t("insights.generating", "Generating...")}
              </>
            ) : (
              <>
                <Sparkles size={14} />
                {t("insights.generateInsightsBtn", "Generate Insights")}
              </>
            )}
          </button>
          </>
        )}
      />

      {showModelConfig && (
        <div className="insights-model-config" data-testid="model-config">
          {/*
          FNXC:Insights-ThinkingLevel 2026-07-12-19:24:
          The insight model-config popover must expose the shared inline reasoning-effort selector and persist the operator's choice next to the model override so Generate Insights can send a real per-run selection.
          */}
          <label htmlFor="insight-model-select" className="insights-model-label">
            {t("insights.model", "Model")}
          </label>
          <CustomModelDropdown
            models={models}
            value={selectedModel}
            onChange={handleModelChange}
            placeholder={t("insights.usePlanningDefault", "Use planning default")}
            label={t("insights.generationModel", "Insight generation model")}
            disabled={isRunInFlight}
            id="insight-model-select"
            favoriteProviders={effectiveFavoriteProviders}
            favoriteModels={favoriteModels}
            onToggleFavorite={handleToggleProviderFavorite}
            onToggleModelFavorite={handleToggleModelFavorite}
            showThinkingLevel
            thinkingLevel={selectedThinking}
            onThinkingLevelChange={handleThinkingChange}
            defaultThinkingLevel="off"
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
            {t("insights.latestRun", "Latest run:")} {latestRun.status}
            {latestRun.status === "completed" && (
              <> — {t("insights.runCompleted", "{{created}} created, {{updated}} updated", { created: latestRun.insightsCreated, updated: latestRun.insightsUpdated })}</>
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
          <p>{t("insights.loading", "Loading insights...")}</p>
        </div>
      ) : error ? (
        <div className="insights-error" data-testid="insights-error">
          <AlertCircle size={24} />
          <p>{error}</p>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            {t("actions.retry", "Retry")}
          </button>
        </div>
      ) : totalCount === 0 ? (
        <div className="insights-empty" data-testid="insights-empty">
          <Sparkles size={48} />
          <h3>{t("insights.noInsightsYet", "No insights yet")}</h3>
          <p>{t("insights.generateDescription", "Generate insights to get AI-powered recommendations for your project.")}</p>
          <button className="btn btn-primary" onClick={() => void handleRun()}>
            <Sparkles size={14} />
            {t("insights.generateFirst", "Generate First Insights")}
          </button>
        </div>
      ) : (
        <div className="insights-body">
          <aside className="insights-sidebar" aria-label={t("insights.categoriesLabel", "Insight categories")}>
            <ul className="insights-category-list">
              {filteredSections.map(renderCategoryItem)}
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
