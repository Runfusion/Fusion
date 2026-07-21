import { resolvePersistAgentThinkingLog } from "@fusion/core";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export type GlobalGeneralSectionProps = SectionBaseProps;
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Plain settings rows render through the shared primitives rather than hand-rolled `form-group` + `checkbox-label` markup, so labels, help copy, and padding come from one type scale. `.form-group` stays global and untouched — 35 non-settings files style forms with it.
The migrated keys are all global-tier (DEFAULT_GLOBAL_SETTINGS), so each carries a "global" badge stating that it travels between projects.
Rows that stay bespoke are the ones whose copy a single-string descriptor cannot carry without rewording it: the `fn` binary check, the update-check toggle, and the thinking-log group all build label or help from `t()` fragments interleaved with `<code>` tags. The thinking-log pair additionally shares ONE help string across two checkboxes, which no per-row descriptor models. The CLI binary panel has moved to its own advanced-only section.

FNXC:SettingsHelp 2026-07-16-12:45:
Bespoke rows no longer render their help as inline `<small>` paragraphs. The copy moved VERBATIM (same `t()` keys, same `<code>` fragments) behind the shared "?" affordance (`SettingsHelpTip`) — operator requirement: no inline description paragraphs in Settings. The thinking-log pair's shared help hangs off ONE tip beside the group heading.
*/
export function GlobalGeneralSection({ form, setForm }: GlobalGeneralSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.globalGeneral.general", "General")}</h4>
      {/*
        FNXC:SourceControl 2026-07-15-20:30:
        The global GitLab disclosure and the global default tracking repo moved to "Source Control · Global" (SourceControlGlobalSection.tsx), paired with the project source-control section under the Integrations nav group. They are forge integration settings, not general app preferences.
      */}
      {/*
      FNXC:SettingsNavigation 2026-07-16-01:00:
      The `fn` CLI binary panel moved OUT of this section to its own advanced-only "CLI Binary" section at the bottom of the nav. It used to render first here, so a binary install/version/path panel was the first thing an operator saw on opening Settings — machine plumbing above the preferences they came for. Do not move it back.
      */}
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
          key: "skipConfirmationDialogs",
          label: t("settings.globalGeneral.skipConfirmationDialogs", " Skip confirmation dialogs for critical actions "),
          help: t("settings.globalGeneral.skipConfirmationDialogsHint", " When enabled, destructive actions such as deleting a task or resetting progress run immediately without a prompt. Default: disabled"),
          scope: "global",
        }}
        value={form.skipConfirmationDialogs === true}
        onChange={(v) => setForm((f) => ({ ...f, skipConfirmationDialogs: v === true }))}
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
      <SettingsToggleRow
        descriptor={{
          key: "proactiveTaskChatEnabled",
          label: t("settings.globalGeneral.enableProactiveTaskChat", " Enable proactive task-chat updates "),
          help: t("settings.globalGeneral.enableProactiveTaskChatHint", " When enabled, Task chat reports step progress, failures, reviews, and rollbacks in real time. Default: disabled. "),
          scope: "global",
        }}
        value={form.proactiveTaskChatEnabled === true}
        onChange={(v) => setForm((f) => ({ ...f, proactiveTaskChatEnabled: v === true }))}
      />
      <div className="form-group">
        {/* FNXC:SettingsHelp 2026-07-16-12:45: The pair's ONE shared help paragraph moved behind a single "?" beside the group heading — operator requirement: no inline description paragraphs in Settings. */}
        <div className="settings-field-label-row">
          <h5 className="settings-section-heading">{t("settings.globalGeneral.saveAIThinkingLogs", "Save AI thinking logs")}</h5>
          <SettingsHelpTip settingKey="persistAgentThinkingLog">{t("settings.globalGeneral.leaveBothThinkingTogglesOffToKeepThe", " Leave both thinking toggles off to keep the original default behavior. This only controls persisted ")}<code>thinking</code>{t("settings.globalGeneral.rowsAndDoesNotAffectAssistantTextOr", " rows and does not affect assistant text or tool rows. Default: disabled for both permanent and ephemeral agents. ")}</SettingsHelpTip>
        </div>
        <label htmlFor="persistAgentThinkingLogPermanent" className="checkbox-label">
          <input id="persistAgentThinkingLogPermanent" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: false })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogPermanent: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForPermanentAgents", " Save AI thinking for permanent agents ")}</label>
        <label htmlFor="persistAgentThinkingLogEphemeral" className="checkbox-label">
          <input id="persistAgentThinkingLogEphemeral" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: true })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogEphemeral: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForEphemeralTaskWorkerAgents", " Save AI thinking for ephemeral / task-worker agents ")}</label>
      </div>
      <div className="form-group">
        {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. The tip is a SIBLING of the checkbox label (a button inside a label breaks click-to-toggle). */}
        <div className="settings-field-label-row">
          <label htmlFor="fnBinaryCheckEnabled" className="checkbox-label">
            <input id="fnBinaryCheckEnabled" type="checkbox" checked={form.fnBinaryCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, fnBinaryCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForThe", " Check for the ")}<code>fn</code>{t("settings.globalGeneral.cLIBinaryOnPATH", " CLI binary on PATH ")}</label>
          <SettingsHelpTip settingKey="fnBinaryCheckEnabled">{t("settings.globalGeneral.whenEnabledTheDashboardProbesForAGlobally", " When enabled, the dashboard probes for a globally-installed")}{" "}
            <code>fn</code> / <code>fusion</code>{t("settings.globalGeneral.cLIBySpawning", " CLI by spawning")}{" "}
            <code>&lt;bin&gt; --version</code>{t("settings.globalGeneral.disableThisIfYourLocalDevProcessIs", ". Disable this if your local dev process is the source of truth and you don't want any outdated globally-installed binary executed during the probe. Default: enabled. ")}</SettingsHelpTip>
        </div>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalGeneral.updates", "Updates")}</h4>
      <div className="form-group">
        {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. The tip is a SIBLING of the checkbox label (a button inside a label breaks click-to-toggle). */}
        <div className="settings-field-label-row">
          <label htmlFor="updateCheckEnabled" className="checkbox-label">
            <input id="updateCheckEnabled" type="checkbox" checked={form.updateCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, updateCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForUpdatesAutomatically", " Check for updates automatically ")}</label>
          <SettingsHelpTip settingKey="updateCheckEnabled">{t("settings.globalGeneral.whenEnabledFusionChecksNpmForNewVersions", " When enabled, Fusion checks npm for new versions of")}{" "}
            <code>@runfusion/fusion</code>{t("settings.globalGeneral.andShowsUpdateNoticesInTheCLIAnd", " and shows update notices in the CLI and dashboard. Cadence is governed by the frequency below. Default: enabled. ")}</SettingsHelpTip>
        </div>
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
      {/*
        FNXC:UpdateChannels 2026-07-19-12:50:
        Release track selector. `stable` follows the npm `latest` dist-tag; `beta` follows
        the semver-max of `latest` and `beta` so beta users also receive promoted stables.
        Deliberately NOT disabled with auto-check off: the channel also governs manual
        "Check now" and `fn update`. Switching beta → stable never downgrades — the install
        stays on its beta until the next stable overtakes it.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "updateChannel",
          label: t("settings.globalGeneral.releaseChannel", "Release channel"),
          help: t("settings.globalGeneral.releaseChannelHelp", " Stable follows official releases. Beta follows pre-releases cut from main (versions like 0.73.0-beta.2) and also picks up each stable release once it overtakes the beta. Switching back to Stable never downgrades; you stay on the installed beta until the next stable release passes it. Default: stable. "),
          scope: "global",
          options: [
            { value: "stable", label: t("settings.globalGeneral.channelStable", "Stable (recommended)") },
            { value: "beta", label: t("settings.globalGeneral.channelBeta", "Beta — early builds from main") },
          ],
        }}
        value={form.updateChannel ?? "stable"}
        onChange={(v) => setForm((f) => ({
            ...f,
            updateChannel: v as "stable" | "beta",
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
