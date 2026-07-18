import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { resolveResearchFindingId, resolveResearchSettings, type Settings } from "@fusion/core";
import { Loader2, Search } from "lucide-react";
import { fetchAuthStatus, fetchSettings } from "../api";
import { useResearch } from "../hooks/useResearch";
import type { ResearchProviderOption } from "../research-types";
import { ResearchTaskActionModal } from "./ResearchTaskActionModal";
import { LoadingSpinner } from "./LoadingSpinner";
import { ViewHeader } from "./ViewHeader";
import type { SectionId } from "./SettingsModal";
import "./ResearchView.css";
import { recordResumeEvent } from "../utils/resumeInstrumentation";

interface ResearchViewProps {
  projectId?: string;
  addToast?: (message: string, type?: "success" | "error" | "info") => void;
  onOpenSettings?: (section?: SectionId) => void;
  readinessVersion?: number;
}

const DEFAULT_PROVIDERS: ResearchProviderOption[] = ["web-search", "page-fetch", "github", "local-docs", "llm-synthesis"];

const PROVIDER_TO_SOURCE_KEY: Record<ResearchProviderOption, keyof ReturnType<typeof resolveResearchSettings>["enabledSources"]> = {
  "web-search": "webSearch",
  "page-fetch": "pageFetch",
  github: "github",
  "local-docs": "localDocs",
  "llm-synthesis": "llmSynthesis",
};

function useProviderLabels(t: TFunction): Record<ResearchProviderOption, string> {
  return {
    "web-search": t("research.providerWebSearch", "Web Search"),
    "page-fetch": t("research.providerPageFetch", "Page Fetch"),
    github: t("research.providerGitHub", "GitHub"),
    "local-docs": t("research.providerLocalDocs", "Local Docs"),
    "llm-synthesis": t("research.providerLlmSynthesis", "LLM Synthesis"),
  };
}

let researchViewWasPreviouslyInactive = false;

export function ResearchView({ projectId, addToast, onOpenSettings, readinessVersion = 0 }: ResearchViewProps) {
  const { t } = useTranslation("app");
  const providerLabels = useProviderLabels(t);

  useEffect(() => {
    recordResumeEvent({
      view: "ResearchView",
      trigger: researchViewWasPreviouslyInactive ? "route-active" : "remount",
      projectId,
      replayAttempted: false,
    });
    researchViewWasPreviouslyInactive = false;

    return () => {
      researchViewWasPreviouslyInactive = true;
      recordResumeEvent({
        view: "ResearchView",
        trigger: "route-inactive",
        projectId,
        replayAttempted: false,
      });
    };
  }, [projectId]);
  const {
    runs,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    availability,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    createRun,
    cancelRun,
    retryRun,
    exportRun,
    createTaskFromRun,
    attachRunToTask,
    promoteFinding,
    statusCounts,
    refresh,
    uiError,
    runActionState,
  } = useResearch({ projectId });
  const [query, setQuery] = useState("");
  const [effectiveSettings, setEffectiveSettings] = useState(() => resolveResearchSettings(undefined));
  const [authProviders, setAuthProviders] = useState<Array<{ id: string; authenticated: boolean }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<ResearchProviderOption[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [modalState, setModalState] = useState<null | { mode: "create" | "enrich"; findingId: string }>(null);
  const [promotionSliceId, setPromotionSliceId] = useState("");

  const providerOptions = availability.supportedProviders ?? DEFAULT_PROVIDERS;
  const selectedSearchProvider = effectiveSettings.searchProvider;
  const isProviderEnabled = (provider: ResearchProviderOption) => {
    if (provider === "web-search") {
      return true;
    }
    return effectiveSettings.enabledSources[PROVIDER_TO_SOURCE_KEY[provider]];
  };

  useEffect(() => {
    const enabledProviders = providerOptions.filter((provider) => isProviderEnabled(provider));
    setSelectedProviders((current) => {
      const currentEnabled = current.filter((provider) => enabledProviders.includes(provider));
      if (currentEnabled.length > 0) {
        return currentEnabled;
      }
      return enabledProviders;
    });
  }, [effectiveSettings.enabledSources, providerOptions]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchSettings(projectId) as Promise<Partial<Settings>>,
      fetchAuthStatus().catch(() => ({ providers: [] })),
    ])
      .then(([settings, authStatus]) => {
        if (cancelled) return;
        setEffectiveSettings(resolveResearchSettings(settings));
        setAuthProviders(
          authStatus.providers
            .filter((provider) => provider.type === "api_key")
            .map((provider) => ({ id: provider.id, authenticated: provider.authenticated })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setEffectiveSettings(resolveResearchSettings(undefined));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, readinessVersion]);

  const statusLabel = useMemo(() => {
    if (!selectedRun) return t("research.noRunSelected", "No run selected");
    return selectedRun.status;
  }, [selectedRun, t]);

  const statusDotClass = useMemo(() => {
    if (!selectedRun) return "status-dot";
    if (selectedRun.status === "queued" || selectedRun.status === "retry_waiting") return "status-dot status-dot--pending";
    if (selectedRun.status === "running") return "status-dot status-dot--connecting";
    if (selectedRun.status === "completed") return "status-dot status-dot--online";
    if (selectedRun.status === "failed" || selectedRun.status === "cancelled") return "status-dot status-dot--error";
    return "status-dot";
  }, [selectedRun]);

  const supportedExportFormats = availability.supportedExportFormats ?? ["markdown", "json", "html"];

  const apiKeyProviderAuth = useMemo(() => new Map(authProviders.map((provider) => [provider.id, provider.authenticated])), [authProviders]);
  const requiredCredentialProviders = useMemo(() => {
    const required = new Set<string>();
    if (effectiveSettings.enabledSources.webSearch && selectedSearchProvider) {
      required.add(selectedSearchProvider);
    }
    if (effectiveSettings.enabledSources.llmSynthesis && effectiveSettings.synthesisProvider) {
      required.add(effectiveSettings.synthesisProvider);
    }
    return [...required].filter((providerId) => apiKeyProviderAuth.has(providerId));
  }, [effectiveSettings.enabledSources.llmSynthesis, effectiveSettings.enabledSources.webSearch, effectiveSettings.synthesisProvider, selectedSearchProvider, apiKeyProviderAuth]);
  const missingCredentialProvider = requiredCredentialProviders.find((providerId) => apiKeyProviderAuth.get(providerId) !== true);

  const setupState = useMemo(() => {
    if (!availability.available) {
      return {
        reason: availability.reason ?? t("research.unavailable", "Research is unavailable for this project."),
        details: availability.setupInstructions,
        settingsSection: "research-project" as SectionId,
      };
    }
    if (!effectiveSettings.enabled) {
      return {
        reason: t("research.disabled", "Research is disabled for this project."),
        details: t("research.enableResearchHint", "Enable project research settings to create runs."),
        settingsSection: "research-project" as SectionId,
      };
    }
    if (missingCredentialProvider) {
      return {
        reason: t("research.missingApiKey", "Missing API key for {{provider}}.", { provider: missingCredentialProvider }),
        details: t("research.addCredentialsHint", "Add provider credentials in Authentication settings."),
        settingsSection: "authentication" as SectionId,
      };
    }
    return null;
  }, [availability.available, availability.reason, availability.setupInstructions, effectiveSettings.enabled, missingCredentialProvider, t]);

  const runAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setActionLoading(key);
    try {
      await action();
      addToast?.(successMessage, "success");
      await refresh();
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : t("research.actionFailed", "Action failed"), "error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleExport = async (format: "markdown" | "json" | "html") => {
    if (!selectedRun) return;
    setActionLoading(`export-${format}`);
    try {
      const payload = await exportRun(selectedRun.id, format);
      const blob = new Blob([payload.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = payload.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      addToast?.(t("research.exportedFile", "Exported {{filename}}", { filename: payload.filename }), "success");
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : t("research.exportFailed", "Export failed"), "error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateRun = async () => {
    if (!query.trim()) return;
    setSubmitting(true);
    try {
      const providers = selectedProviders.filter((provider) => isProviderEnabled(provider));
      if (providers.length === 0) {
        setSubmitting(false);
        addToast?.(t("research.noSourcesAvailable", "No enabled research sources are available for this project."), "error");
        return;
      }
      const response = await createRun({ query: query.trim(), providers });
      setSelectedRunId(response.run.id);
      setQuery("");
      addToast?.(t("research.runCreated", "Research run created"), "success");
      await refresh();
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : t("research.createRunFailed", "Failed to create run"), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="research-view" aria-label={t("research.viewLabel", "Research view")}>
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Research adopts the shared ViewHeader (CC-modeled) for a consistent main-content title row; the Refresh action moves into the header actions cluster and the prior subtitle renders just below the header so the descriptive copy is preserved.
      */}
      <ViewHeader
        icon={Search}
        title={t("research.title", "Research")}
        actions={(
          <button className="btn" type="button" onClick={() => void refresh()}>
            {t("actions.refresh", "Refresh")}
          </button>
        )}
      />
      <p className="research-view__subtitle">{t("research.subtitle", "Cited search and synthesis runs: gather sources, fetch content, and synthesize findings.")}</p>

      {setupState ? (
        <div className="research-view__state research-view__state--error card" data-testid="research-state-unavailable">
          <p>{setupState.reason}</p>
          {setupState.details && <p>{setupState.details}</p>}
          <p>
            {t("research.currentDefaults", "Current defaults: provider {{provider}}, max sources {{maxSources}}", { provider: effectiveSettings.searchProvider ?? t("research.notSet", "(not set)"), maxSources: effectiveSettings.limits.maxSourcesPerRun })}
          </p>
          <div className="research-view__actions">
            <button className="btn" type="button" onClick={() => void refresh()}>
              {t("actions.refresh", "Refresh")}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => onOpenSettings?.(setupState.settingsSection)}>
              {t("actions.openSettings", "Open Settings")}
            </button>
          </div>
        </div>
      ) : (
      <>
      <div className="research-view__layout">
        <aside className="research-view__sidebar card">
          <div className="research-view__sidebar-content">
            <div className="research-view__form">
              <div className="form-group">
                <label htmlFor="research-query">{t("research.queryLabel", "Query")}</label>
                <textarea id="research-query" className="input research-view__textarea" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <div className="form-group">
                <label>{t("research.providersLabel", "Providers")}</label>
                <div className="research-view__providers">
                  {providerOptions.map((provider) => {
                    const providerEnabled = isProviderEnabled(provider);
                    const providerLocked = provider === "web-search";
                    return (
                      <label key={provider} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={providerLocked || selectedProviders.includes(provider)}
                          disabled={providerLocked || !providerEnabled}
                          onChange={() => {
                            if (providerLocked || !providerEnabled) {
                              return;
                            }
                            setSelectedProviders((current) =>
                              current.includes(provider) ? current.filter((entry) => entry !== provider) : [...current, provider],
                            );
                          }}
                        />
                        <span>
                          {providerLabels[provider] ?? provider}
                          {providerLocked ? <span className="research-view__provider-lock">{t("research.alwaysOn", "Always on")}</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <button className="btn btn-primary" type="button" disabled={!query.trim() || submitting} onClick={() => void handleCreateRun()}>
                {submitting ? <Loader2 className="animate-spin" size={14} /> : null}
                {t("research.createRun", "Create Run")}
              </button>
            </div>

            <div className="research-view__history-header form-group">
              <label htmlFor="research-run-search">{t("actions.search", "Search")}</label>
              <div className="research-view__history-search-row">
                <Search size={14} />
                <input
                  id="research-run-search"
                  className="input"
                  placeholder={t("research.searchRunsPlaceholder", "Search runs")}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
            </div>
            <div className="research-view__history" data-testid="research-state-running">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={`research-view__history-item card${selectedRunId === run.id ? " research-view__history-item--active" : ""}`}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span className="card-id">{run.id}</span>
                  <span>{run.title}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="research-view__reader card">
          {loading && <p data-testid="research-state-loading"><LoadingSpinner label={t("research.loadingRuns", "Loading research runs…")} /></p>}
          {!loading && error && <p data-testid="research-state-error">{error}</p>}
          {!loading && !error && runs.length === 0 && <p data-testid="research-state-empty">{t("research.noRunsYet", "No research runs yet")}</p>}
          <div className="research-view__reader-content">
            {selectedRun && (
              <div className="research-view__run-detail">
                <div className="research-view__status-row">
                  <span className={statusDotClass} />
                  <strong>{statusLabel}</strong>
                </div>
                <h3 className="research-view__run-title">{selectedRun.title}</h3>
                <p className="research-view__run-query">{selectedRun.query}</p>
                <p className="research-view__run-summary" data-testid="research-state-results">{selectedRun.results?.summary ?? t("research.noSummaryYet", "No summary yet.")}</p>
                <div className="research-view__actions">
                  <button
                    className="btn"
                    type="button"
                    title={!runActionState.cancelable ? runActionState.blockingReason : undefined}
                    disabled={actionLoading === "cancel" || actionLoading === "retry" || !runActionState.cancelable}
                    onClick={() => void runAction("cancel", () => cancelRun(selectedRun.id), t("research.runCancelled", "Run cancelled"))}
                  >
                    {t("actions.cancel", "Cancel")}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    title={!runActionState.retryable ? runActionState.blockingReason : undefined}
                    disabled={actionLoading === "cancel" || actionLoading === "retry" || !runActionState.retryable}
                    onClick={() => void runAction("retry", () => retryRun(selectedRun.id), t("research.runRetried", "Run retried"))}
                  >
                    {t("actions.retry", "Retry")}
                  </button>
                  {supportedExportFormats.includes("markdown") && <button className="btn" type="button" disabled={actionLoading === "export-markdown"} onClick={() => void handleExport("markdown")}>{t("research.exportMd", "Export MD")}</button>}
                  {supportedExportFormats.includes("json") && <button className="btn" type="button" disabled={actionLoading === "export-json"} onClick={() => void handleExport("json")}>{t("research.exportJson", "Export JSON")}</button>}
                  {supportedExportFormats.includes("html") && <button className="btn" type="button" disabled={actionLoading === "export-html"} onClick={() => void handleExport("html")}>{t("research.exportHtml", "Export HTML")}</button>}
                </div>
                {selectedRun.error && <p className="research-view__error">{selectedRun.error}</p>}
                {uiError && (
                  <div className="form-error" role="alert">
                    <p>{uiError.message}</p>
                    {uiError.setupHint && <p>{uiError.setupHint}</p>}
                    {uiError.code === "MISSING_CREDENTIALS" && (
                      <button className="btn btn-sm" type="button" onClick={() => onOpenSettings?.("authentication")}>
                        {t("research.openAuthSettings", "Open Authentication Settings")}
                      </button>
                    )}
                    {uiError.code === "FEATURE_DISABLED" && (
                      <button className="btn btn-sm" type="button" onClick={() => onOpenSettings?.("research-project")}>
                        {t("research.openResearchSettings", "Open Research Settings")}
                      </button>
                    )}
                  </div>
                )}
                {runActionState.blockingReason && (
                  <p className="research-view__run-query">{runActionState.blockingReason}</p>
                )}
                {Array.isArray(selectedRun.results?.findings) && selectedRun.results.findings.length > 0 && (
                  <div className="research-view__findings">
                    {selectedRun.results.findings.map((finding) => {
                      const findingId = resolveResearchFindingId(finding);
                      return (
                        <article key={findingId} className="research-view__finding card">
                          <h4>{finding.heading}</h4>
                          <p>{finding.content}</p>
                          <div className="research-view__actions research-view__finding-actions">
                            <button
                              className="btn btn-primary btn-sm"
                              type="button"
                              onClick={() => setModalState({ mode: "create", findingId })}
                            >
                              {t("research.createTask", "Create Task")}
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => setModalState({ mode: "enrich", findingId })}
                            >
                              {t("research.enrichTask", "Enrich Task")}
                            </button>
                            <input className="input" aria-label={t("research.destinationSlice", "Destination slice ID")} value={promotionSliceId} onChange={(event) => setPromotionSliceId(event.target.value)} placeholder={t("research.destinationSlice", "Destination slice ID")} />
                            <button className="btn btn-sm" type="button" disabled={selectedRun.status !== "completed" || !promotionSliceId.trim() || actionLoading === `promote-${findingId}`} onClick={() => void runAction(`promote-${findingId}`, () => promoteFinding(selectedRun.id, { findingId, sliceId: promotionSliceId.trim() }), t("research.findingPromoted", "Finding promoted to roadmap"))}>
                              {t("research.promoteFinding", "Promote to roadmap")}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
                {Array.isArray(selectedRun.results?.citations) && selectedRun.results!.citations!.length > 0 && (
                  <ul className="research-view__citations">
                    {selectedRun.results!.citations!.map((citation) => (
                      <li key={citation}><a href={citation} target="_blank" rel="noreferrer">{citation}</a></li>
                    ))}
                  </ul>
                )}
                {selectedRun.events.length > 0 && (
                  <details>
                    <summary>{t("research.runHistory", "Run history")}</summary>
                    <ul className="research-view__events">
                      {selectedRun.events.map((event) => (
                        <li key={event.id}>{event.message}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {!selectedRun && runs.length > 0 && <p>{t("research.selectRunToViewDetails", "Select a run to view details.")}</p>}

            <div className="research-view__stats">
              <div className="research-view__stat-card"><div className="research-view__stat-label">{t("research.statRunning", "Running")}</div><div className="research-view__stat-value">{statusCounts.running}</div></div>
              <div className="research-view__stat-card"><div className="research-view__stat-label">{t("research.statCompleted", "Completed")}</div><div className="research-view__stat-value">{statusCounts.completed}</div></div>
              <div className="research-view__stat-card"><div className="research-view__stat-label">{t("research.statFailed", "Failed")}</div><div className="research-view__stat-value">{statusCounts.failed}</div></div>
            </div>
          </div>
        </div>
      </div>
      </>
      )}
      {selectedRun && modalState && (() => {
        const findingIndex = selectedRun.results?.findings?.findIndex((entry) => {
          return resolveResearchFindingId(entry) === modalState.findingId;
        }) ?? -1;
        const finding = findingIndex >= 0 ? selectedRun.results!.findings[findingIndex] : null;
        if (!finding) return null;

        return (
          <ResearchTaskActionModal
            open
            mode={modalState.mode}
            run={selectedRun}
            finding={{ id: modalState.findingId, heading: finding.heading, content: finding.content }}
            projectId={projectId}
            onClose={() => setModalState(null)}
            onConfirm={async ({ taskId, title, description, priority, attachExport }) => {
              if (modalState.mode === "create") {
                await runAction(
                  "create-task",
                  () => createTaskFromRun(selectedRun.id, title, modalState.findingId, description, priority, attachExport),
                  t("research.taskCreatedFromResearch", "Task created from research"),
                );
              } else if (taskId) {
                await runAction(
                  "attach-task",
                  () => attachRunToTask(selectedRun.id, taskId, modalState.findingId, attachExport),
                  t("research.taskEnrichedFromResearch", "Task enriched from research"),
                );
              }
              setModalState(null);
            }}
          />
        );
      })()}
    </section>
  );
}
