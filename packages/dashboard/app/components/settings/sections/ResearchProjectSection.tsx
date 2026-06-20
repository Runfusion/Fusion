import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface ResearchProjectSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    researchLimitError: string | null;
}
export function ResearchProjectSection({ scopeBanner, form, setForm, researchLimitError }: ResearchProjectSectionProps) {
    const { t } = useTranslation("app");
    const limits = form.researchSettings?.limits;
    const sources = form.researchSettings?.enabledSources;
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.researchProject.projectResearchSettings", "Project Research Settings")}</h4>
      <div className="form-group">
        <label htmlFor="research-project-enabled" className="checkbox-label">
          <input id="research-project-enabled" type="checkbox" checked={form.researchSettings?.enabled ?? true} onChange={(event) => setForm((current) => ({
            ...current,
            researchSettings: {
                ...(current.researchSettings ?? {}),
                enabled: event.target.checked,
            },
        }))}/>{t("settings.researchProject.enableResearchInThisProject", " Enable research in this project ")}</label>
      </div>
      <div className="form-group">
        <label>{t("settings.researchProject.enabledSources", "Enabled Sources")}</label>
        <label htmlFor="research-project-source-webSearch" className="checkbox-label settings-research-source-locked">
          <input id="research-project-source-webSearch" type="checkbox" checked disabled readOnly/>{t("settings.researchProject.webSearch", " Web Search ")}<span className="settings-muted">{t("settings.researchProject.alwaysOn", "Always on")}</span>
        </label>
        <small className="settings-muted">{t("settings.researchProject.webSearchIsAlwaysEnabledConfigureTheSearch", " Web search is always enabled. Configure the search provider under Research Defaults. ")}</small>
        <div className="settings-research-source-grid">
          {[
            ["pageFetch", t("settings.researchProject.pageFetch", "Page Fetch")],
            ["github", t("settings.researchProject.github", "GitHub")],
            ["localDocs", t("settings.researchProject.localDocs", "Local Docs")],
            ["llmSynthesis", t("settings.researchProject.llmSynthesis", "LLM Synthesis")],
        ].map(([key, label]) => (<label key={key} htmlFor={`research-project-source-${key}`} className="checkbox-label">
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
          </div>
          {researchLimitError && <small className="field-error settings-research-limits-error">{researchLimitError}</small>}
        </div>
      </div>
    </>);
}
export default ResearchProjectSection;
