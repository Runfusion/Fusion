import type { SectionBaseProps } from "./context";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { useTranslation } from "react-i18next";
export interface ResearchProjectSectionProps extends SectionBaseProps {
    researchLimitError: string | null;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The section's one plain label+control+help row renders through the shared settings primitives instead of hand-rolled `form-group` + `checkbox-label` markup, so its label, help copy, and padding come from the one settings type scale. `.form-group` itself stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-17:35:
`researchSettings` lives in `DEFAULT_PROJECT_SETTINGS`, so the master toggle carries a project badge: research enablement describes one repository's research policy and must not follow the operator to another project.

FNXC:SettingsSearch 2026-07-15-17:35:
The descriptor key is the dotted path `researchSettings.enabled`, not the bare `researchSettings` blob key, because the toggle owns exactly one leaf of that nested object. The sources and limits below own their own leaves of the same blob, so a bare key would collide the moment either migrates, and search would anchor several controls to one row.

FNXC:SettingsStyling 2026-07-15-17:35:
Two groups deliberately keep their bespoke markup because they are not plain label+control+help rows: the Enabled Sources grid pairs an always-on locked Web Search row with a checkbox grid carrying inline per-source default hints, and the limits grid lays four numeric fields plus a shared validation error out side by side (`settings-research-limit-field`).
*/
export function ResearchProjectSection({ form, setForm, researchLimitError }: ResearchProjectSectionProps) {
    const { t } = useTranslation("app");
    const limits = form.researchSettings?.limits;
    const sources = form.researchSettings?.enabledSources;
    return (<>
      <h4 className="settings-section-heading">{t("settings.researchProject.projectResearchSettings", "Project Research Settings")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "researchSettings.enabled",
          label: t("settings.researchProject.enableResearchInThisProject", " Enable research in this project "),
          help: t("settings.researchProject.enableResearchInThisProjectHint", "Default: enabled."),
          scope: "project",
        }}
        value={form.researchSettings?.enabled ?? true}
        onChange={(v) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                enabled: v === true,
            },
        }))}
      />
      <div className="form-group">
        <label>{t("settings.researchProject.enabledSources", "Enabled Sources")}</label>
        <label htmlFor="research-project-source-webSearch" className="checkbox-label settings-research-source-locked">
          <input id="research-project-source-webSearch" type="checkbox" checked disabled readOnly/>{t("settings.researchProject.webSearch", " Web Search ")}<span className="settings-muted">{t("settings.researchProject.alwaysOn", "Always on")}</span>
        </label>
        <small className="settings-muted">{t("settings.researchProject.webSearchIsAlwaysEnabledConfigureTheSearch", " Web search is always enabled. Configure the search provider under Research Defaults. ")}</small>
        <div className="settings-research-source-grid">
          {[
            ["pageFetch", t("settings.researchProject.pageFetch", "Page Fetch"), "Default: enabled."],
            ["github", t("settings.researchProject.github", "GitHub"), "Default: disabled."],
            ["localDocs", t("settings.researchProject.localDocs", "Local Docs"), "Default: enabled."],
            ["llmSynthesis", t("settings.researchProject.llmSynthesis", "LLM Synthesis"), "Default: enabled."],
        ].map(([key, label, defaultHint]) => (<label key={key} htmlFor={`research-project-source-${key}`} className="checkbox-label">
              <input id={`research-project-source-${key}`} type="checkbox" checked={sources?.[key as keyof NonNullable<typeof sources>] ?? false} onChange={(event) => setForm((current) => ({
                ...current,
                researchSettings: {
                    ...(current.researchSettings ?? {}),
                    enabledSources: {
                        ...(current.researchSettings?.enabledSources ?? {}),
                        [key]: event.target.checked,
                    },
                },
            }))}/>
              {label}
              <small>{defaultHint}</small>
            </label>))}
        </div>
      </div>
      <div className="form-group">
        <div className="settings-research-limits-grid">
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-concurrent">{t("settings.researchProject.maxConcurrentRuns", "Max Concurrent Runs")}</label>
            <input id="research-project-max-concurrent" className="input" type="number" min={1} value={limits?.maxConcurrentRuns ?? 3} onChange={(event) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                limits: {
                    ...(current.researchSettings?.limits ?? {}),
                    maxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
                },
            },
        }))}/>
            <small>{t("settings.researchProject.maxConcurrentRunsHint", "Default: 3.")}</small>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-sources">{t("settings.researchProject.maxSourcesPerRun", "Max Sources Per Run")}</label>
            <input id="research-project-max-sources" className="input" type="number" min={1} value={limits?.maxSourcesPerRun ?? 20} onChange={(event) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                limits: {
                    ...(current.researchSettings?.limits ?? {}),
                    maxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
                },
            },
        }))}/>
            <small>{t("settings.researchProject.maxSourcesPerRunHint", "Default: 20.")}</small>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-duration">{t("settings.researchProject.maxDurationMs", "Max Duration (ms)")}</label>
            <input id="research-project-max-duration" className="input" type="number" min={1000} value={limits?.maxDurationMs ?? 300000} onChange={(event) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                limits: {
                    ...(current.researchSettings?.limits ?? {}),
                    maxDurationMs: event.target.value === "" ? undefined : Number(event.target.value),
                },
            },
        }))}/>
            <small>{t("settings.researchProject.maxDurationMsHint", "Default: 300000 (5 minutes).")}</small>
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-request-timeout">{t("settings.researchProject.requestTimeoutMs", "Request Timeout (ms)")}</label>
            <input id="research-project-request-timeout" className="input" type="number" min={1000} value={limits?.requestTimeoutMs ?? 30000} onChange={(event) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                limits: {
                    ...(current.researchSettings?.limits ?? {}),
                    requestTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
                },
            },
        }))}/>
            <small>{t("settings.researchProject.requestTimeoutMsHint", "Default: 30000 (30 seconds).")}</small>
          </div>
          {researchLimitError && <small className="field-error settings-research-limits-error">{researchLimitError}</small>}
        </div>
      </div>
    </>);
}
export default ResearchProjectSection;
