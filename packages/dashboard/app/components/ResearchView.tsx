import { useEffect, useMemo, useState } from "react";
import { resolveResearchSettings, type Settings } from "@fusion/core";
import { Loader2, Search } from "lucide-react";
import { fetchAuthStatus, fetchSettings } from "../api";
import { useResearch } from "../hooks/useResearch";
import type { ResearchProviderOption } from "../research-types";
import { ResearchTaskActionModal } from "./ResearchTaskActionModal";
import type { SectionId } from "./SettingsModal";
import "./ResearchView.css";

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

const PROVIDER_LABELS: Record<ResearchProviderOption, string> = {
  "web-search": "Web Search",
  "page-fetch": "Page Fetch",
  github: "GitHub",
  "local-docs": "Local Docs",
  "llm-synthesis": "LLM Synthesis",
};

export function ResearchView({ projectId, addToast, onOpenSettings, readinessVersion = 0 }: ResearchViewProps) {
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

  const providerOptions = availability.supportedProviders ?? DEFAULT_PROVIDERS;
  const isProviderEnabled = (provider: ResearchProviderOption) => effectiveSettings.enabledSources[PROVIDER_TO_SOURCE_KEY[provider]];

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
    if (!selectedRun) return "No run selected";
    return selectedRun.status;
  }, [selectedRun]);

  const statusDotClass = useMemo(() => {
    if (!selectedRun) return "status-dot";
    if (selectedRun.status === "queued" || selectedRun.status === "retry_waiting") return "status-dot status-dot--pending";
    if (selectedRun.status === "running") return "status-dot status-dot--connecting";
    if (selectedRun.status === "completed") return "status-dot status-dot--online";
    if (selectedRun.status === "failed" || selectedRun.status === "cancelled") return "status-dot status-dot--error";
    return "status-dot";
  }, [selectedRun]);

  const supportedExportFormats = availability.supportedExportFormats ?? ["markdown", "json", "html"];

  const selectedSearchProvider = effectiveSettings.searchProvider;
  const needsSearchProvider = effectiveSettings.enabledSources.webSearch && !selectedSearchProvider;
  const needsSynthesisModel =
    effectiveSettings.enabledSources.llmSynthesis &&
    (!effectiveSettings.synthesisProvider || !effectiveSettings.synthesisModelId);
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
        reason: availability.reason ?? "Research is unavailable for this project.",
        details: availability.setupInstructions,
        settingsSection: "research-project" as SectionId,
      };
    }
    if (!effectiveSettings.enabled) {
      return {
        reason: "Research is disabled for this project.",
        details: "Enable project research settings to create runs.",
        settingsSection: "research-project" as SectionId,
      };
    }
    if (needsSearchProvider || needsSynthesisModel) {
      return {
        reason: "Research defaults are incomplete.",
        details: "Select the required provider/model defaults in Research settings.",
        settingsSection: "research-global" as SectionId,
      };
    }
    if (missingCredentialProvider) {
      return {
        reason: `Missing API key for ${missingCredentialProvider}.`,
        details: "Add provider credentials in Authentication settings.",
        settingsSection: "authentication" as SectionId,
      };
    }
    return null;
  }, [availability.available, availability.reason, availability.setupInstructions, effectiveSettings.enabled, missingCredentialProvider, needsSearchProvider, needsSynthesisModel]);

  const runAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setActionLoading(key);
    try {
      await action();
      addToast?.(successMessage, "success");
      await refresh();
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : "Action failed", "error");
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
      addToast?.(`Exported ${payload.filename}`, "success");
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : "Export failed", "error");
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
        addToast?.("No enabled research sources are available for this project.", "error");
        return;
      }
      const response = await createRun({ query: query.trim(), providers });
      setSelectedRunId(response.run.id);
      setQuery("");
      addToast?.("Research run created", "success");
      await refresh();
    } catch (err) {
      addToast?.(err instanceof Error ? err.message : "Failed to create run", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="research-view" aria-label="Research view">
      <header className="research-view__header">
        <div>
          <h2 className="research-view__title">Research</h2>
          <p className="research-view__subtitle">Create and track research runs with cited findings.</p>
        </div>
        <button className="btn" type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      {setupState ? (
        <div className="research-view__state research-view__state--error card" data-testid="research-state-unavailable">
          <p>{setupState.reason}</p>
          {setupState.details && <p>{setupState.details}</p>}
          <p>
            Current defaults: provider {effectiveSettings.searchProvider ?? "(not set)"}, max sources {effectiveSettings.limits.maxSourcesPerRun}
          </p>
          <div className="research-view__actions">
            <button className="btn" type="button" onClick={() => void refresh()}>
              Refresh
            </button>
            <button className="btn btn-primary" type="button" onClick={() => onOpenSettings?.(setupState.settingsSection)}>
              Open Settings
            </button>
          </div>
        </div>
      ) : (
      <div className="research-view__layout">
        <aside className="research-view__sidebar card">
          <div className="research-view__form">
            <div className="form-group">
              <label htmlFor="research-query">Query</label>
              <textarea id="research-query" className="input research-view__textarea" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="form-group">
              <label>Providers</label>
              <div className="research-view__providers">
                {providerOptions.map((provider) => (
                  <label key={provider} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedProviders.includes(provider)}
                      disabled={!isProviderEnabled(provider)}
                      onChange={() => {
                        if (!isProviderEnabled(provider)) {
                          return;
                        }
                        setSelectedProviders((current) =>
                          current.includes(provider) ? current.filter((entry) => entry !== provider) : [...current, provider],
                        );
                      }}
                    />
                    <span>{PROVIDER_LABELS[provider] ?? provider}</span>
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-primary" type="button" disabled={!query.trim() || submitting} onClick={() => void handleCreateRun()}>
              {submitting ? <Loader2 className="animate-spin" size={14} /> : null}
              Create Run
            </button>
          </div>

          <div className="research-view__history-header form-group">
            <label htmlFor="research-run-search">Search</label>
            <div className="research-view__history-search-row">
              <Search size={14} />
              <input
                id="research-run-search"
                className="input"
                placeholder="Search runs"
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
        </aside>

        <div className="research-view__reader card">
          {loading && <p data-testid="research-state-loading">Loading research runs…</p>}
          {!loading && error && <p data-testid="research-state-error">{error}</p>}
          {!loading && !error && runs.length === 0 && <p data-testid="research-state-empty">No research runs yet</p>}
          {selectedRun && (
            <div>
              <div className="research-view__status-row">
                <span className={statusDotClass} />
                <strong>{statusLabel}</strong>
              </div>
              <h3 className="research-view__run-title">{selectedRun.title}</h3>
              <p className="research-view__run-query">{selectedRun.query}</p>
              <p className="research-view__run-summary" data-testid="research-state-results">{selectedRun.results?.summary ?? "No summary yet."}</p>
              <div className="research-view__actions">
                <button
                  className="btn"
                  type="button"
                  title={!runActionState.cancelable ? runActionState.blockingReason : undefined}
                  disabled={actionLoading === "cancel" || actionLoading === "retry" || !runActionState.cancelable}
                  onClick={() => void runAction("cancel", () => cancelRun(selectedRun.id), "Run cancelled")}
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  type="button"
                  title={!runActionState.retryable ? runActionState.blockingReason : undefined}
                  disabled={actionLoading === "cancel" || actionLoading === "retry" || !runActionState.retryable}
                  onClick={() => void runAction("retry", () => retryRun(selectedRun.id), "Run retried")}
                >
                  Retry
                </button>
                {supportedExportFormats.includes("markdown") && <button className="btn" type="button" disabled={actionLoading === "export-markdown"} onClick={() => void handleExport("markdown")}>Export MD</button>}
                {supportedExportFormats.includes("json") && <button className="btn" type="button" disabled={actionLoading === "export-json"} onClick={() => void handleExport("json")}>Export JSON</button>}
                {supportedExportFormats.includes("html") && <button className="btn" type="button" disabled={actionLoading === "export-html"} onClick={() => void handleExport("html")}>Export HTML</button>}
              </div>
              {selectedRun.error && <p className="research-view__error">{selectedRun.error}</p>}
              {uiError && (
                <div className="form-error" role="alert">
                  <p>{uiError.message}</p>
                  {uiError.setupHint && <p>{uiError.setupHint}</p>}
                  {uiError.code === "MISSING_CREDENTIALS" && (
                    <button className="btn btn-sm" type="button" onClick={() => onOpenSettings?.("authentication")}>
                      Open Authentication Settings
                    </button>
                  )}
                  {uiError.code === "FEATURE_DISABLED" && (
                    <button className="btn btn-sm" type="button" onClick={() => onOpenSettings?.("research-project")}>
                      Open Research Settings
                    </button>
                  )}
                </div>
              )}
              {runActionState.blockingReason && (
                <p className="research-view__run-query">{runActionState.blockingReason}</p>
              )}
              {Array.isArray(selectedRun.results?.findings) && selectedRun.results.findings.length > 0 && (
                <div className="research-view__findings">
                  {selectedRun.results.findings.map((finding, index) => {
                    const findingRecord = finding as { id?: string };
                    const findingId = findingRecord.id?.trim() || `finding-${index + 1}`;
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
                            Create Task
                          </button>
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => setModalState({ mode: "enrich", findingId })}
                          >
                            Enrich Task
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
                  <summary>Run history</summary>
                  <ul className="research-view__events">
                    {selectedRun.events.map((event) => (
                      <li key={event.id}>{event.message}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {!selectedRun && runs.length > 0 && <p>Select a run to view details.</p>}

          <div className="research-view__stats">
            <div className="research-view__stat-card"><div className="research-view__stat-label">Running</div><div className="research-view__stat-value">{statusCounts.running}</div></div>
            <div className="research-view__stat-card"><div className="research-view__stat-label">Completed</div><div className="research-view__stat-value">{statusCounts.completed}</div></div>
            <div className="research-view__stat-card"><div className="research-view__stat-label">Failed</div><div className="research-view__stat-value">{statusCounts.failed}</div></div>
          </div>
        </div>
      </div>
      )}
      {selectedRun && modalState && (() => {
        const findingIndex = selectedRun.results?.findings?.findIndex((entry, idx) => {
          const findingRecord = entry as { id?: string };
          const id = findingRecord.id?.trim() || `finding-${idx + 1}`;
          return id === modalState.findingId;
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
                  "Task created from research",
                );
              } else if (taskId) {
                await runAction(
                  "attach-task",
                  () => attachRunToTask(selectedRun.id, taskId, modalState.findingId, attachExport),
                  "Task enriched from research",
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
