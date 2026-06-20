import type { ReactNode } from "react";
import type { Settings } from "@fusion/core";
import type { AuthProvider } from "../../../api";
import type { SectionId } from "../../SettingsModal";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface ResearchGlobalSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    authProviders: AuthProvider[];
    onNavigateToSection: (section: SectionId) => void;
}
export function ResearchGlobalSection({ scopeBanner, form, setForm, authProviders, onNavigateToSection, }: ResearchGlobalSectionProps) {
    const { t } = useTranslation("app");
    const resolvedProvider = form.researchGlobalWebSearchProvider ??
        form.researchGlobalDefaults?.searchProvider ??
        "builtin";
    const externalProvider = resolvedProvider === "searxng" ||
        resolvedProvider === "brave" ||
        resolvedProvider === "google" ||
        resolvedProvider === "tavily";
    const selectedCredentialProvider = resolvedProvider === "brave" || resolvedProvider === "tavily" ? resolvedProvider : null;
    const hasMissingResearchCredential = selectedCredentialProvider
        ? authProviders.some((provider) => provider.id === selectedCredentialProvider && !provider.authenticated)
        : false;
    const setSearchProvider = (provider: Settings["researchGlobalWebSearchProvider"]) => {
        setForm((current) => ({
            ...current,
            researchGlobalWebSearchProvider: provider,
            researchGlobalDefaults: {
                ...(current.researchGlobalDefaults ?? {}),
                searchProvider: provider,
            },
        }));
    };
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.researchGlobal.researchDefaults", "Research Defaults")}</h4>
      <div className="form-group settings-research-provider-group">
        <label htmlFor="research-global-provider-builtin" className="checkbox-label">
          <input id="research-global-provider-builtin" type="radio" name="research-global-search-provider" checked={!externalProvider} onChange={() => setSearchProvider("builtin")}/>{t("settings.researchGlobal.builtInUsesAgentWebTools", " Built-in (uses agent web tools) ")}</label>
        <small>{t("settings.researchGlobal.searchesAndFetchesUseTheAgentsNativeWebSearch", " Searches and fetches use the agent's native WebSearch/WebFetch tools. No API key required. ")}</small>
        <details className="settings-option-details settings-research-provider-advanced-details">
          <summary>{t("settings.researchGlobal.advancedExternalSearchProviders", "Advanced \u2014 external search providers")}</summary>
          <div className="settings-research-provider-advanced-body">
            <div className="form-group">
              <label htmlFor="research-global-search-provider-advanced">{t("settings.researchGlobal.searchProvider", "Search Provider")}</label>
              <select id="research-global-search-provider-advanced" className="input" value={externalProvider ? resolvedProvider : "searxng"} onChange={(event) => setSearchProvider(event.target.value as Settings["researchGlobalWebSearchProvider"])}>
                <option value="searxng">{t("settings.researchGlobal.searXNG", "SearXNG")}</option>
                <option value="brave">{t("settings.researchGlobal.brave", "Brave")}</option>
                <option value="google">{t("settings.researchGlobal.googleCustomSearch", "Google Custom Search")}</option>
                <option value="tavily">{t("settings.researchGlobal.tavily", "Tavily")}</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="research-global-searxng-url">{t("settings.researchGlobal.searXNGURL", "SearXNG URL")}</label>
              <input id="research-global-searxng-url" className="input" value={form.researchGlobalSearxngUrl ?? ""} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalSearxngUrl: event.target.value || undefined,
        }))} placeholder={t("settings.researchGlobal.httpsSearxExampleCom", "https://searx.example.com")}/>
            </div>
            <div className="form-group">
              <label htmlFor="research-global-google-cx">{t("settings.researchGlobal.googleSearchCX", "Google Search CX")}</label>
              <input id="research-global-google-cx" className="input" value={form.researchGlobalGoogleSearchCx ?? ""} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalGoogleSearchCx: event.target.value || undefined,
        }))} placeholder={t("settings.researchGlobal.customSearchEngineId", "custom-search-engine-id")}/>
            </div>
            <div className="settings-empty-state settings-research-empty-state" role="note">{t("settings.researchGlobal.configureBraveTavilyAndGoogleAPIKeysIn", " Configure Brave, Tavily, and Google API keys in Authentication. ")}<button type="button" className="btn btn-sm" onClick={() => onNavigateToSection("authentication")}>{t("settings.researchGlobal.openAuthenticationSettings", " Open Authentication Settings ")}</button>
            </div>
          </div>
        </details>
      </div>
      <div className="form-group">
        <div className="settings-research-limits-grid">
          <div className="settings-research-limit-field">
            <label htmlFor="research-global-max-concurrent">{t("settings.researchGlobal.defaultMaxConcurrentRuns", "Default Max Concurrent Runs")}</label>
            <input id="research-global-max-concurrent" className="input" type="number" min={1} value={form.researchGlobalMaxConcurrentRuns ?? 3} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalMaxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-global-max-sources">{t("settings.researchGlobal.defaultMaxSourcesPerRun", "Default Max Sources Per Run")}</label>
            <input id="research-global-max-sources" className="input" type="number" min={1} value={form.researchGlobalMaxSourcesPerRun ?? 20} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalMaxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
            researchGlobalDefaults: {
                ...(current.researchGlobalDefaults ?? {}),
                maxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
            },
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-global-default-timeout">{t("settings.researchGlobal.defaultMaxDurationMs", "Default Max Duration (ms)")}</label>
            <input id="research-global-default-timeout" className="input" type="number" min={1000} value={form.researchGlobalDefaultTimeout ?? 300000} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalDefaultTimeout: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-global-fetch-timeout">{t("settings.researchGlobal.requestTimeoutMs", "Request Timeout (ms)")}</label>
            <input id="research-global-fetch-timeout" className="input" type="number" min={1000} value={form.researchGlobalFetchTimeoutMs ?? 30000} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalFetchTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-global-max-synthesis-rounds">{t("settings.researchGlobal.maxSynthesisRounds", "Max Synthesis Rounds")}</label>
            <input id="research-global-max-synthesis-rounds" className="input" type="number" min={1} value={form.researchGlobalMaxSynthesisRounds ?? 2} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalMaxSynthesisRounds: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
        </div>
      </div>
      <div className="form-group">
        <label>{t("settings.researchGlobal.enabledSources", "Enabled Sources")}</label>
        <label htmlFor="research-global-source-webSearch" className="checkbox-label settings-research-source-locked">
          <input id="research-global-source-webSearch" type="checkbox" checked disabled readOnly/>{t("settings.researchGlobal.webSearch", " Web Search ")}<span className="settings-muted">{t("settings.researchGlobal.alwaysOn", "Always on")}</span>
        </label>
        <div className="settings-research-source-grid">
          <label htmlFor="research-global-source-github" className="checkbox-label">
            <input id="research-global-source-github" type="checkbox" checked={form.researchGlobalGitHubEnabled ?? false} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalGitHubEnabled: event.target.checked,
        }))}/>{t("settings.researchGlobal.gitHub", " GitHub ")}</label>
          <label htmlFor="research-global-source-local-docs" className="checkbox-label">
            <input id="research-global-source-local-docs" type="checkbox" checked={form.researchGlobalLocalDocsEnabled ?? true} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalLocalDocsEnabled: event.target.checked,
        }))}/>{t("settings.researchGlobal.localDocs", " Local Docs ")}</label>
        </div>
      </div>
      {hasMissingResearchCredential && (<div className="settings-empty-state" role="alert">{t("settings.researchGlobal.missingCredentialsForTheSelectedResearchProvider", " Missing credentials for the selected research provider. ")}<button type="button" className="btn btn-sm" onClick={() => onNavigateToSection("authentication")}>{t("settings.researchGlobal.openAuthentication", " Open Authentication ")}</button>
        </div>)}
    </>);
}
export default ResearchGlobalSection;
