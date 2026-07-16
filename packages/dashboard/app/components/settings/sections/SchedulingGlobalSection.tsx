import { useTranslation } from "react-i18next";
import { SettingsNumberRow } from "../SettingsNumberRow";

export interface SchedulingGlobalSectionProps {
    globalMaxConcurrent: number | undefined;
    concurrencyLoading?: boolean;
    onGlobalMaxConcurrentChange: (value: number | undefined) => void;
}

/*
FNXC:SettingsScope 2026-07-15-18:52:
The machine-wide concurrency cap gets its own section instead of sitting on top of the project scheduling settings behind an in-section "Global — applies to all projects" subheading.
One section held two authority levels, so the answer to "does this affect other projects?" depended on which subheading an operator had scrolled past — and a search result landing mid-section shows no subheading at all. Sections are now single-scope, and the Global/Project pair sits adjacent under Automation, matching how Models/MCP/Research/General already read.
This split is also what lets the sibling project section drop its ScopeGroupHeader chrome entirely.

FNXC:SettingsScope 2026-07-15-18:52:
The row deliberately carries NO scope badge. `globalMaxConcurrent` is the one place the schema and the UI genuinely disagree: it is declared in `DEFAULT_PROJECT_SETTINGS` (settings-schema.ts:359) yet is read and written through the dedicated global-concurrency endpoint (hence the prop rather than `form`) and applies to every project on the machine.
Stamping "project" would contradict the section it lives in; stamping "global" would contradict the schema. The section is the honest source of scope until the schema is fixed — a badge here would assert a fact the data model does not support.
*/
export function SchedulingGlobalSection({ globalMaxConcurrent, concurrencyLoading = false, onGlobalMaxConcurrentChange, }: SchedulingGlobalSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.scheduling.scopeGlobalTitle", "Global — applies to all projects")}</h4>
      <p className="settings-section-description">{t("settings.scheduling.scopeGlobalCaption", "Shared by every project on this machine.")}</p>
      {/*
      FNXC:SettingsConcurrency 2026-06-22-20:18:
      Concurrency inputs represent live project/global limits. Keep them disabled while their actual values are still loading so users cannot edit a blank fallback and accidentally overwrite the resolved limits.
      */}
      <SettingsNumberRow
        descriptor={{
          key: "globalMaxConcurrent",
          label: t("settings.scheduling.globalMaxConcurrent", "Global Max Concurrent"),
          help: t("settings.scheduling.maximumConcurrentAgentsAcrossAllProjects", "Maximum concurrent agents across all projects. Default: 4."),
          min: 0,
          max: 10000,
          disabled: concurrencyLoading,
        }}
        value={globalMaxConcurrent ?? null}
        onChange={(v) => onGlobalMaxConcurrentChange(v ?? undefined)}
      />
    </>);
}
export default SchedulingGlobalSection;
