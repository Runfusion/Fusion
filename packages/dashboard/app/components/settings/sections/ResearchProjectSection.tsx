/**
 * Project Research Settings section (U9 / KTD-10).
 *
 * Per-project research enable toggle, enabled-source grid (web search always
 * on), and run-limit fields. The limit-validation error is computed in the shell
 * (shared with the save gate) and passed down. Keys, nested researchSettings
 * shape, and conditional rendering preserved verbatim from the original inline
 * JSX.
 */
import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";

export interface ResearchProjectSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  researchLimitError: string | null;
}

export function ResearchProjectSection({ scopeBanner, form, setForm, researchLimitError }: ResearchProjectSectionProps) {
  const limits = form.researchSettings?.limits;
  const sources = form.researchSettings?.enabledSources;
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Project Research Settings</h4>
      <div className="form-group">
        <label htmlFor="research-project-enabled" className="checkbox-label">
          <input
            id="research-project-enabled"
            type="checkbox"
            checked={form.researchSettings?.enabled ?? true}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                researchSettings: {
                  ...(current.researchSettings ?? {}),
                  enabled: event.target.checked,
                },
              }))
            }
          />
          Enable research in this project
        </label>
      </div>
      <div className="form-group">
        <label>Enabled Sources</label>
        <label
          htmlFor="research-project-source-webSearch"
          className="checkbox-label settings-research-source-locked"
        >
          <input id="research-project-source-webSearch" type="checkbox" checked disabled readOnly />
          Web Search <span className="settings-muted">Always on</span>
        </label>
        <small className="settings-muted">
          Web search is always enabled. Configure the search provider under Research Defaults.
        </small>
        <div className="settings-research-source-grid">
          {[
            ["pageFetch", "Page Fetch"],
            ["github", "GitHub"],
            ["localDocs", "Local Docs"],
            ["llmSynthesis", "LLM Synthesis"],
          ].map(([key, label]) => (
            <label key={key} htmlFor={`research-project-source-${key}`} className="checkbox-label">
              <input
                id={`research-project-source-${key}`}
                type="checkbox"
                checked={sources?.[key as keyof NonNullable<typeof sources>] ?? false}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    researchSettings: {
                      ...(current.researchSettings ?? {}),
                      enabledSources: {
                        ...(current.researchSettings?.enabledSources ?? {}),
                        [key]: event.target.checked,
                      },
                    },
                  }))
                }
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="form-group">
        <div className="settings-research-limits-grid">
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-concurrent">Max Concurrent Runs</label>
            <input
              id="research-project-max-concurrent"
              className="input"
              type="number"
              min={1}
              value={limits?.maxConcurrentRuns ?? 3}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  researchSettings: {
                    ...(current.researchSettings ?? {}),
                    limits: {
                      ...(current.researchSettings?.limits ?? {}),
                      maxConcurrentRuns: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  },
                }))
              }
            />
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-sources">Max Sources Per Run</label>
            <input
              id="research-project-max-sources"
              className="input"
              type="number"
              min={1}
              value={limits?.maxSourcesPerRun ?? 20}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  researchSettings: {
                    ...(current.researchSettings ?? {}),
                    limits: {
                      ...(current.researchSettings?.limits ?? {}),
                      maxSourcesPerRun: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  },
                }))
              }
            />
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-max-duration">Max Duration (ms)</label>
            <input
              id="research-project-max-duration"
              className="input"
              type="number"
              min={1000}
              value={limits?.maxDurationMs ?? 300000}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  researchSettings: {
                    ...(current.researchSettings ?? {}),
                    limits: {
                      ...(current.researchSettings?.limits ?? {}),
                      maxDurationMs: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  },
                }))
              }
            />
          </div>
          <div className="settings-research-limit-field">
            <label htmlFor="research-project-request-timeout">Request Timeout (ms)</label>
            <input
              id="research-project-request-timeout"
              className="input"
              type="number"
              min={1000}
              value={limits?.requestTimeoutMs ?? 30000}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  researchSettings: {
                    ...(current.researchSettings ?? {}),
                    limits: {
                      ...(current.researchSettings?.limits ?? {}),
                      requestTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value),
                    },
                  },
                }))
              }
            />
          </div>
          {researchLimitError && <small className="field-error settings-research-limits-error">{researchLimitError}</small>}
        </div>
      </div>
    </>
  );
}

export default ResearchProjectSection;
