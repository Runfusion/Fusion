import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export type ScheduledEvalsSectionProps = SectionBaseProps;
/*
FNXC:SettingsScope 2026-07-15-17:35:
Eval scheduling is project-scoped (`evalSettings` in DEFAULT_PROJECT_SETTINGS): each project schedules its own runs against its own validator lane, so nothing here travels between projects.

FNXC:SettingsSearch 2026-07-15-17:35:
Descriptor keys are dotted paths (`evalSettings.enabled`) because the six controls share one stored blob. The key must stay unique per row — it is both the control's element id and the row's search anchor — and the dotted path is the honest name of what each row writes, so an operator searching the config field name still lands on the right control.

FNXC:ScheduledEvals 2026-07-15-17:35:
Interval, follow-up policy, and retention are disabled while scheduling is off, but provider and model deliberately are not: they are inherited-lane overrides an operator can stage before ever enabling runs.
*/
export function ScheduledEvalsSection({ form, setForm }: ScheduledEvalsSectionProps) {
    const { t } = useTranslation("app");
    const evalSettings = form.evalSettings ?? {};
    const isScheduledEvalEnabled = evalSettings.enabled ?? false;
    return (<>
      <h4 className="settings-section-heading">{t("settings.scheduledEvals.scheduledEvals", "Scheduled Evals")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "evalSettings.enabled",
          label: t("settings.scheduledEvals.enableScheduledEvalRunsForThisProject", " Enable scheduled eval runs for this project "),
          help: t("settings.scheduledEvals.enabledHint", "Default: disabled."),
          scope: "project",
        }}
        value={isScheduledEvalEnabled}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                enabled: v === true,
            },
        }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "evalSettings.intervalMs",
          label: t("settings.scheduledEvals.intervalMs", "Interval (ms)"),
          help: t("settings.scheduledEvals.intervalMsHint", "Default: 86400000 (24 hours)."),
          scope: "project",
          disabled: !isScheduledEvalEnabled,
          min: 60000,
          max: 604800000,
          step: 1000,
        }}
        value={evalSettings.intervalMs ?? 86400000}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                intervalMs: v === null ? undefined : v,
            },
        }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "evalSettings.evaluatorProvider",
          label: t("settings.scheduledEvals.evaluatorProvider", "Evaluator Provider"),
          help: t("settings.scheduledEvals.evaluatorProviderHint", "No default — unset (inherits the project validator lane provider)."),
          scope: "project",
          placeholder: t("settings.scheduledEvals.openai", "openai"),
        }}
        value={evalSettings.evaluatorProvider ?? ""}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorProvider: (v ?? "").trim() === "" ? undefined : (v ?? undefined),
            },
        }))}
      />
      <SettingsTextRow
        descriptor={{
          key: "evalSettings.evaluatorModelId",
          label: t("settings.scheduledEvals.evaluatorModel", "Evaluator Model"),
          help: t("settings.scheduledEvals.leaveProviderAndModelBlankToInheritThe", " Leave provider and model blank to inherit the project validator lane model settings. No default — unset. "),
          scope: "project",
          placeholder: t("settings.scheduledEvals.gpt5", "gpt-5"),
        }}
        value={evalSettings.evaluatorModelId ?? ""}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                evaluatorModelId: (v ?? "").trim() === "" ? undefined : (v ?? undefined),
            },
        }))}
      />
      <SettingsSelectRow
        descriptor={{
          key: "evalSettings.followUpPolicy",
          label: t("settings.scheduledEvals.followUpPolicy", "Follow-up Policy"),
          help: t("settings.scheduledEvals.followUpPolicyHint", "Default: suggest only."),
          scope: "project",
          disabled: !isScheduledEvalEnabled,
          options: [
            { value: "disabled", label: t("settings.scheduledEvals.disabled", "Disabled") },
            { value: "suggest-only", label: t("settings.scheduledEvals.suggestOnly", "Suggest only") },
            { value: "auto-create", label: t("settings.scheduledEvals.autoCreateTasks", "Auto-create tasks") },
          ],
        }}
        value={evalSettings.followUpPolicy ?? "suggest-only"}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                followUpPolicy: v as "disabled" | "suggest-only" | "auto-create",
            },
        }))}
      />
      <SettingsNumberRow
        descriptor={{
          key: "evalSettings.retentionDays",
          label: t("settings.scheduledEvals.retentionDays", "Retention (days)"),
          help: t("settings.scheduledEvals.retentionDaysHint", "Default: 30."),
          scope: "project",
          disabled: !isScheduledEvalEnabled,
          min: 1,
          max: 365,
          step: 1,
        }}
        value={evalSettings.retentionDays ?? 30}
        onChange={(v) => setForm((current) => ({
            ...current,
            evalSettings: {
                ...(current.evalSettings ?? {}),
                retentionDays: v === null ? undefined : v,
            },
        }))}
      />
    </>);
}
export default ScheduledEvalsSection;
