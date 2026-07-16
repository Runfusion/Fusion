import { resolvePersistAgentThinkingLog } from "@fusion/core";
import { CliBinaryPanel } from "../../CliBinaryPanel";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export type GlobalGeneralSectionProps = SectionBaseProps;
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Plain settings rows render through the shared primitives rather than hand-rolled `form-group` + `checkbox-label` markup, so labels, help copy, and padding come from one type scale. `.form-group` stays global and untouched — 35 non-settings files style forms with it.
The migrated keys are all global-tier (DEFAULT_GLOBAL_SETTINGS), so each carries a "global" badge stating that it travels between projects.
Rows that stay bespoke are the ones whose copy a single-string descriptor cannot carry without rewording it: the `fn` binary check, the update-check toggle, and the thinking-log group all build label or help from `t()` fragments interleaved with `<code>` tags. The thinking-log pair additionally shares ONE help string across two checkboxes, which no per-row descriptor models. CliBinaryPanel is a custom widget.
*/
export function GlobalGeneralSection({ form, setForm }: GlobalGeneralSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.globalGeneral.general", "General")}</h4>
      {/*
        FNXC:SourceControl 2026-07-15-20:30:
        The global GitLab disclosure and the global default tracking repo moved to "Source Control · Global" (SourceControlGlobalSection.tsx), paired with the project source-control section under the Integrations nav group. They are forge integration settings, not general app preferences.
      */}
      <CliBinaryPanel />
      <SettingsToggleRow
        descriptor={{
          key: "dismissModalsOnOutsideClick",
          label: t("settings.globalGeneral.dismissModalsByClickingOutside", " Dismiss modals by clicking outside "),
          help: t("settings.globalGeneral.dismissModalsByClickingOutsideHint", " When enabled, clicking or tapping a modal backdrop closes the modal. Default: disabled, to prevent accidental dismissal. "),
          scope: "global",
        }}
        value={form.dismissModalsOnOutsideClick === true}
        onChange={(v) => setForm((f) => ({ ...f, dismissModalsOnOutsideClick: v === true }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "persistAgentToolOutput",
          label: t("settings.globalGeneral.saveToolOutputInAgentLogs", " Save tool output in agent logs "),
          help: t("settings.globalGeneral.whenDisabledToolRowsAreStillLoggedBut", " When disabled, tool rows are still logged but detailed tool payloads are omitted. Very large tool payloads may still be clipped even when this stays enabled. Default: disabled. "),
          scope: "global",
        }}
        value={form.persistAgentToolOutput === true}
        onChange={(v) => setForm((f) => ({ ...f, persistAgentToolOutput: v === true }))}
      />
      <div className="form-group">
        <h5 className="settings-section-heading">{t("settings.globalGeneral.saveAIThinkingLogs", "Save AI thinking logs")}</h5>
        <label htmlFor="persistAgentThinkingLogPermanent" className="checkbox-label">
          <input id="persistAgentThinkingLogPermanent" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: false })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogPermanent: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForPermanentAgents", " Save AI thinking for permanent agents ")}</label>
        <label htmlFor="persistAgentThinkingLogEphemeral" className="checkbox-label">
          <input id="persistAgentThinkingLogEphemeral" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: true })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogEphemeral: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForEphemeralTaskWorkerAgents", " Save AI thinking for ephemeral / task-worker agents ")}</label>
        <small>{t("settings.globalGeneral.leaveBothThinkingTogglesOffToKeepThe", " Leave both thinking toggles off to keep the original default behavior. This only controls persisted ")}<code>thinking</code>{t("settings.globalGeneral.rowsAndDoesNotAffectAssistantTextOr", " rows and does not affect assistant text or tool rows. Default: disabled for both permanent and ephemeral agents. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="fnBinaryCheckEnabled" className="checkbox-label">
          <input id="fnBinaryCheckEnabled" type="checkbox" checked={form.fnBinaryCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, fnBinaryCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForThe", " Check for the ")}<code>fn</code>{t("settings.globalGeneral.cLIBinaryOnPATH", " CLI binary on PATH ")}</label>
        <small>{t("settings.globalGeneral.whenEnabledTheDashboardProbesForAGlobally", " When enabled, the dashboard probes for a globally-installed")}{" "}
          <code>fn</code> / <code>fusion</code>{t("settings.globalGeneral.cLIBySpawning", " CLI by spawning")}{" "}
          <code>&lt;bin&gt; --version</code>{t("settings.globalGeneral.disableThisIfYourLocalDevProcessIs", ". Disable this if your local dev process is the source of truth and you don't want any outdated globally-installed binary executed during the probe. Default: enabled. ")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalGeneral.updates", "Updates")}</h4>
      <div className="form-group">
        <label htmlFor="updateCheckEnabled" className="checkbox-label">
          <input id="updateCheckEnabled" type="checkbox" checked={form.updateCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, updateCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForUpdatesAutomatically", " Check for updates automatically ")}</label>
        <small>{t("settings.globalGeneral.whenEnabledFusionChecksNpmForNewVersions", " When enabled, Fusion checks npm for new versions of")}{" "}
          <code>@runfusion/fusion</code>{t("settings.globalGeneral.andShowsUpdateNoticesInTheCLIAnd", " and shows update notices in the CLI and dashboard. Cadence is governed by the frequency below. Default: enabled. ")}</small>
      </div>
      {/*
        FNXC:SettingsGlobalGeneral 2026-07-15-17:35:
        Frequency is disabled rather than hidden while auto-check is off: it describes a cadence that is
        not running, and an operator turning checks back on needs to see which cadence will take effect.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "updateCheckFrequency",
          label: t("settings.globalGeneral.frequency", "Frequency"),
          help: t("settings.globalGeneral.controlsHowOftenTheDashboardReFetchesThe", " Controls how often the dashboard re-fetches the npm registry. Use the version + refresh control in the header to trigger an immediate check at any time. Default: daily. "),
          scope: "global",
          disabled: form.updateCheckEnabled === false,
          options: [
            { value: "manual", label: t("settings.globalGeneral.manualOnlyNeverAutoCheck", "Manual only \u2014 never auto-check") },
            { value: "on-startup", label: t("settings.globalGeneral.onStartupOncePerServerLaunch", "On startup \u2014 once per server launch") },
            { value: "daily", label: t("settings.globalGeneral.dailyRecommended", "Daily (recommended)") },
            { value: "weekly", label: t("settings.globalGeneral.weekly", "Weekly") },
          ],
        }}
        value={form.updateCheckFrequency ?? "daily"}
        onChange={(v) => setForm((f) => ({
            ...f,
            updateCheckFrequency: v as "manual" | "on-startup" | "daily" | "weekly",
        }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "autoReloadOnVersionChange",
          label: t("settings.globalGeneral.autoReloadDashboardOnVersionChange", " Auto-reload dashboard on version change "),
          help: t("settings.globalGeneral.whenEnabledDefaultTheDashboardAutomaticallyReloadsWhen", " When enabled (default), the dashboard automatically reloads when it detects a new build version \u2014 either from server rebuilds or service worker updates. Disable this to stay on the current version until you manually refresh. Default: enabled. "),
          scope: "global",
        }}
        value={form.autoReloadOnVersionChange !== false}
        onChange={(v) => setForm((f) => ({ ...f, autoReloadOnVersionChange: v === true }))}
      />
    </>);
}
export default GlobalGeneralSection;
