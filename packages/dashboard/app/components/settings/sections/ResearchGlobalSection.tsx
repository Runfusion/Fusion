import type { Settings } from "@fusion/core";
import type { AuthProvider } from "../../../api";
import type { SectionId } from "../../SettingsModal";
import type { SectionBaseProps } from "./context";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsTextRow } from "../SettingsTextRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import { useTranslation } from "react-i18next";
export interface ResearchGlobalSectionProps extends SectionBaseProps {
    authProviders: AuthProvider[];
    onNavigateToSection: (section: SectionId) => void;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The plain label+control+help rows inside the advanced disclosure render through the shared settings primitives instead of hand-rolled `form-group` markup, so their labels, help copy, and padding come from the one settings type scale. `.form-group` itself stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-17:35:
Every migrated key here is global (`DEFAULT_GLOBAL_SETTINGS`): a search provider and its endpoint/engine ids are machine-wide research credentials-adjacent config, not per-repository policy. The badges restate that per row because settings search can land an operator on a single control with no section chrome in view.

FNXC:SettingsStyling 2026-07-15-17:35:
Four groups deliberately keep their bespoke markup because they are not plain label+control+help rows: the built-in/external provider radio and its `<details>` disclosure, the limits grid (`settings-research-limit-field`), the Enabled Sources grid pairing an always-on locked Web Search row with per-source inline hints, and the two credential empty-state notes that carry navigation buttons.

FNXC:SettingsHelp 2026-07-15-21:40:
The bespoke rows that are still one control + one help string — the built-in provider radio and each limits field — hang that help off the same "?" as the migrated rows above (`.settings-field-label-row` + `SettingsHelpTip`), so a limits grid of five "Default: N." paragraphs no longer sits beside rows whose help is behind an icon.
Two kinds of copy stay inline here: the Enabled Sources hints, which annotate a checkbox grid rather than describe one control, and the credential empty-state/alert notes, which are live credential status plus a navigation button the operator must actually see.
*/
export function ResearchGlobalSection({ form, setForm, authProviders, onNavigateToSection, }: ResearchGlobalSectionProps) {
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
      <h4 className="settings-section-heading">{t("settings.researchGlobal.researchDefaults", "Research Defaults")}</h4>
      <div className="form-group settings-research-provider-group">
        <div className="settings-field-label-row">
          <label htmlFor="research-global-provider-builtin" className="checkbox-label">
            <input id="research-global-provider-builtin" type="radio" name="research-global-search-provider" checked={!externalProvider} onChange={() => setSearchProvider("builtin")}/>{t("settings.researchGlobal.builtInUsesAgentWebTools", " Built-in (uses agent web tools) (default) ")}</label>
          <SettingsHelpTip settingKey="research-global-provider-builtin">{t("settings.researchGlobal.searchesAndFetchesUseTheAgentsNativeWebSearch", " Searches and fetches use the agent's native WebSearch/WebFetch tools. No API key required. Default: builtin. ")}</SettingsHelpTip>
        </div>
        <details className="settings-option-details settings-research-provider-advanced-details">
          <summary>{t("settings.researchGlobal.advancedExternalSearchProviders", "Advanced \u2014 external search providers")}</summary>
          <div className="settings-research-provider-advanced-body">
            {/*
            FNXC:ResearchProviders 2026-07-15-17:35:
            The select shows `searxng` while the built-in radio is chosen so the disclosure always presents a concrete external option to switch to; picking any option here is what flips the radio off, since both controls write the same `researchGlobalWebSearchProvider` key.
            */}
            <SettingsSelectRow
              descriptor={{
                key: "researchGlobalWebSearchProvider",
                label: t("settings.researchGlobal.searchProvider", "Search Provider"),
                scope: "global",
                options: [
                  { value: "searxng", label: t("settings.researchGlobal.searXNG", "SearXNG") },
                  { value: "brave", label: t("settings.researchGlobal.brave", "Brave") },
                  { value: "google", label: t("settings.researchGlobal.googleCustomSearch", "Google Custom Search") },
                  { value: "tavily", label: t("settings.researchGlobal.tavily", "Tavily") },
                ],
              }}
              value={externalProvider ? resolvedProvider : "searxng"}
              onChange={(v) => setSearchProvider(v as Settings["researchGlobalWebSearchProvider"])}
            />
            {/* FNXC:ResearchProviders 2026-07-15-17:35: An emptied endpoint/engine id stores `undefined`, not "", so the key is absent from the settings blob and the provider falls back to unset rather than being configured with a blank URL. */}
            <SettingsTextRow
              descriptor={{
                key: "researchGlobalSearxngUrl",
                label: t("settings.researchGlobal.searXNGURL", "SearXNG URL"),
                help: t("settings.researchGlobal.searXNGURLHint", "No default \u2014 unset."),
                scope: "global",
                placeholder: t("settings.researchGlobal.httpsSearxExampleCom", "https://searx.example.com"),
              }}
              value={form.researchGlobalSearxngUrl ?? null}
              onChange={(v) => setForm((current) => ({
            ...current,
            researchGlobalSearxngUrl: v || undefined,
        }))}
            />
            <SettingsTextRow
              descriptor={{
                key: "researchGlobalGoogleSearchCx",
                label: t("settings.researchGlobal.googleSearchCX", "Google Search CX"),
                help: t("settings.researchGlobal.googleSearchCXHint", "No default \u2014 unset."),
                scope: "global",
                placeholder: t("settings.researchGlobal.customSearchEngineId", "custom-search-engine-id"),
              }}
              value={form.researchGlobalGoogleSearchCx ?? null}
              onChange={(v) => setForm((current) => ({
            ...current,
            researchGlobalGoogleSearchCx: v || undefined,
        }))}
            />
            <div className="settings-empty-state settings-research-empty-state" role="note">{t("settings.researchGlobal.configureBraveTavilyAndGoogleAPIKeysIn", " Configure Brave, Tavily, and Google API keys in Authentication. ")}<button type="button" className="btn btn-sm" onClick={() => onNavigateToSection("authentication")}>{t("settings.researchGlobal.openAuthenticationSettings", " Open Authentication Settings ")}</button>
            </div>
          </div>
        </details>
      </div>
      <div className="form-group">
        <div className="settings-research-limits-grid">
          <div className="settings-research-limit-field">
            <div className="settings-field-label-row">
              <label htmlFor="research-global-max-concurrent">{t("settings.researchGlobal.defaultMaxConcurrentRuns", "Default Max Concurrent Runs")}</label>
              <SettingsHelpTip settingKey="research-global-max-concurrent">{t("settings.researchGlobal.maxConcurrentRunsHint", "Default: 3.")}</SettingsHelpTip>
            </div>
            <input id="research-global-max-concurrent" className="input" type="number" min={1} value={form.researchGlobalMaxConcurrentRuns ?? 3} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalMaxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <div className="settings-field-label-row">
              <label htmlFor="research-global-max-sources">{t("settings.researchGlobal.defaultMaxSourcesPerRun", "Default Max Sources Per Run")}</label>
              <SettingsHelpTip settingKey="research-global-max-sources">{t("settings.researchGlobal.maxSourcesPerRunHint", "Default: 20.")}</SettingsHelpTip>
            </div>
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
            <div className="settings-field-label-row">
              <label htmlFor="research-global-default-timeout">{t("settings.researchGlobal.defaultMaxDurationMs", "Default Max Duration (ms)")}</label>
              <SettingsHelpTip settingKey="research-global-default-timeout">{t("settings.researchGlobal.defaultMaxDurationMsHint", "Default: 300000 (5 minutes).")}</SettingsHelpTip>
            </div>
            <input id="research-global-default-timeout" className="input" type="number" min={1000} value={form.researchGlobalDefaultTimeout ?? 300000} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalDefaultTimeout: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <div className="settings-field-label-row">
              <label htmlFor="research-global-fetch-timeout">{t("settings.researchGlobal.requestTimeoutMs", "Request Timeout (ms)")}</label>
              <SettingsHelpTip settingKey="research-global-fetch-timeout">{t("settings.researchGlobal.requestTimeoutMsHint", "Default: 30000 (30 seconds).")}</SettingsHelpTip>
            </div>
            <input id="research-global-fetch-timeout" className="input" type="number" min={1000} value={form.researchGlobalFetchTimeoutMs ?? 30000} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalFetchTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
        }))}/>
          </div>
          <div className="settings-research-limit-field">
            <div className="settings-field-label-row">
              <label htmlFor="research-global-max-synthesis-rounds">{t("settings.researchGlobal.maxSynthesisRounds", "Max Synthesis Rounds")}</label>
              <SettingsHelpTip settingKey="research-global-max-synthesis-rounds">{t("settings.researchGlobal.maxSynthesisRoundsHint", "Default: 2.")}</SettingsHelpTip>
            </div>
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
        }))}/>{t("settings.researchGlobal.gitHub", " GitHub ")}<small>{t("settings.researchGlobal.gitHubSourceHint", " Default: disabled. ")}</small></label>
          <label htmlFor="research-global-source-local-docs" className="checkbox-label">
            <input id="research-global-source-local-docs" type="checkbox" checked={form.researchGlobalLocalDocsEnabled ?? true} onChange={(event) => setForm((current) => ({
            ...current,
            researchGlobalLocalDocsEnabled: event.target.checked,
        }))}/>{t("settings.researchGlobal.localDocs", " Local Docs ")}<small>{t("settings.researchGlobal.localDocsSourceHint", " Default: enabled. ")}</small></label>
        </div>
      </div>
      {hasMissingResearchCredential && (<div className="settings-empty-state" role="alert">{t("settings.researchGlobal.missingCredentialsForTheSelectedResearchProvider", " Missing credentials for the selected research provider. ")}<button type="button" className="btn btn-sm" onClick={() => onNavigateToSection("authentication")}>{t("settings.researchGlobal.openAuthentication", " Open Authentication ")}</button>
        </div>)}
    </>);
}
export default ResearchGlobalSection;
