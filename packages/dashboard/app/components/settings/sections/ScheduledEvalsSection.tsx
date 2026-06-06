/**
 * Scheduled Evals section (U9 / KTD-10).
 *
 * Per-project scheduled evaluation run configuration (enable, interval,
 * evaluator provider/model, follow-up policy, retention). Section visibility is
 * gated by the shell (evalsViewEnabled). All keys and conditional disabling are
 * preserved verbatim from the original inline JSX.
 */
import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";

export interface ScheduledEvalsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
}

export function ScheduledEvalsSection({ scopeBanner, form, setForm }: ScheduledEvalsSectionProps) {
  const evalSettings = form.evalSettings ?? {};
  const isScheduledEvalEnabled = evalSettings.enabled ?? false;

  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Scheduled Evals</h4>
      <div className="form-group">
        <label htmlFor="scheduled-evals-enabled" className="checkbox-label">
          <input
            id="scheduled-evals-enabled"
            type="checkbox"
            checked={isScheduledEvalEnabled}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                evalSettings: {
                  ...(current.evalSettings ?? {}),
                  enabled: event.target.checked,
                },
              }))
            }
          />
          Enable scheduled eval runs for this project
        </label>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-interval">Interval (ms)</label>
        <input
          id="scheduled-evals-interval"
          className="input"
          type="number"
          min={60000}
          max={604800000}
          step={1000}
          disabled={!isScheduledEvalEnabled}
          value={evalSettings.intervalMs ?? 86_400_000}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              evalSettings: {
                ...(current.evalSettings ?? {}),
                intervalMs: event.target.value === "" ? undefined : Number(event.target.value),
              },
            }))
          }
        />
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-provider">Evaluator Provider</label>
        <input
          id="scheduled-evals-provider"
          className="input"
          value={evalSettings.evaluatorProvider ?? ""}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorProvider: event.target.value.trim() === "" ? undefined : event.target.value,
              },
            }))
          }
          placeholder="openai"
        />
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-model">Evaluator Model</label>
        <input
          id="scheduled-evals-model"
          className="input"
          value={evalSettings.evaluatorModelId ?? ""}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorModelId: event.target.value.trim() === "" ? undefined : event.target.value,
              },
            }))
          }
          placeholder="gpt-5"
        />
        <small className="form-text text-muted">
          Leave provider and model blank to inherit the project validator lane model settings.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-follow-up-policy">Follow-up Policy</label>
        <select
          id="scheduled-evals-follow-up-policy"
          className="select"
          disabled={!isScheduledEvalEnabled}
          value={evalSettings.followUpPolicy ?? "suggest-only"}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              evalSettings: {
                ...(current.evalSettings ?? {}),
                followUpPolicy: event.target.value as "disabled" | "suggest-only" | "auto-create",
              },
            }))
          }
        >
          <option value="disabled">Disabled</option>
          <option value="suggest-only">Suggest only</option>
          <option value="auto-create">Auto-create tasks</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-retention-days">Retention (days)</label>
        <input
          id="scheduled-evals-retention-days"
          className="input"
          type="number"
          min={1}
          max={365}
          step={1}
          disabled={!isScheduledEvalEnabled}
          value={evalSettings.retentionDays ?? 30}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              evalSettings: {
                ...(current.evalSettings ?? {}),
                retentionDays: event.target.value === "" ? undefined : Number(event.target.value),
              },
            }))
          }
        />
      </div>
    </>
  );
}

export default ScheduledEvalsSection;
