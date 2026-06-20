import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface ScheduledEvalsSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
}
export function ScheduledEvalsSection({ scopeBanner, form, setForm }: ScheduledEvalsSectionProps) {
    const { t } = useTranslation("app");
    const evalSettings = form.evalSettings ?? {};
    const isScheduledEvalEnabled = evalSettings.enabled ?? false;
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.scheduledEvals.scheduledEvals", "Scheduled Evals")}</h4>
      <div className="form-group">
        <label htmlFor="scheduled-evals-enabled" className="checkbox-label">
          <input id="scheduled-evals-enabled" type="checkbox" checked={isScheduledEvalEnabled} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                enabled: event.target.checked,
            },
        }))}/>{t("settings.scheduledEvals.enableScheduledEvalRunsForThisProject", " Enable scheduled eval runs for this project ")}</label>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-interval">{t("settings.scheduledEvals.intervalMs", "Interval (ms)")}</label>
        <input id="scheduled-evals-interval" className="input" type="number" min={60000} max={604800000} step={1000} disabled={!isScheduledEvalEnabled} value={evalSettings.intervalMs ?? 86400000} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                intervalMs: event.target.value === "" ? undefined : Number(event.target.value),
            },
        }))}/>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-provider">{t("settings.scheduledEvals.evaluatorProvider", "Evaluator Provider")}</label>
        <input id="scheduled-evals-provider" className="input" value={evalSettings.evaluatorProvider ?? ""} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorProvider: event.target.value.trim() === "" ? undefined : event.target.value,
            },
        }))} placeholder={t("settings.scheduledEvals.openai", "openai")}/>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-model">{t("settings.scheduledEvals.evaluatorModel", "Evaluator Model")}</label>
        <input id="scheduled-evals-model" className="input" value={evalSettings.evaluatorModelId ?? ""} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorModelId: event.target.value.trim() === "" ? undefined : event.target.value,
            },
        }))} placeholder={t("settings.scheduledEvals.gpt5", "gpt-5")}/>
        <small className="form-text text-muted">{t("settings.scheduledEvals.leaveProviderAndModelBlankToInheritThe", " Leave provider and model blank to inherit the project validator lane model settings. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-follow-up-policy">{t("settings.scheduledEvals.followUpPolicy", "Follow-up Policy")}</label>
        <select id="scheduled-evals-follow-up-policy" className="select" disabled={!isScheduledEvalEnabled} value={evalSettings.followUpPolicy ?? "suggest-only"} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                followUpPolicy: event.target.value as "disabled" | "suggest-only" | "auto-create",
            },
        }))}>
          <option value="disabled">{t("settings.scheduledEvals.disabled", "Disabled")}</option>
          <option value="suggest-only">{t("settings.scheduledEvals.suggestOnly", "Suggest only")}</option>
          <option value="auto-create">{t("settings.scheduledEvals.autoCreateTasks", "Auto-create tasks")}</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="scheduled-evals-retention-days">{t("settings.scheduledEvals.retentionDays", "Retention (days)")}</label>
        <input id="scheduled-evals-retention-days" className="input" type="number" min={1} max={365} step={1} disabled={!isScheduledEvalEnabled} value={evalSettings.retentionDays ?? 30} onChange={(event) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                retentionDays: event.target.value === "" ? undefined : Number(event.target.value),
            },
        }))}/>
      </div>
    </>);
}
export default ScheduledEvalsSection;
