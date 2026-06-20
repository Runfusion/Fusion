import type { ReactNode } from "react";
import { resolvePersistAgentThinkingLog } from "@fusion/core";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { CliBinaryPanel } from "../../CliBinaryPanel";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
export interface GlobalGeneralSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    globalTrackingRepoOptions: TrackingRepoOption[];
    globalTrackingRepoLoading: boolean;
    globalTrackingRepoError: string | null;
}
export function GlobalGeneralSection({ scopeBanner, form, setForm, globalTrackingRepoOptions, globalTrackingRepoLoading, globalTrackingRepoError, }: GlobalGeneralSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.globalGeneral.general", "General")}</h4>
      <div className="form-group">
        <label htmlFor="globalGithubTrackingDefaultRepo">{t("settings.globalGeneral.globalDefaultTrackingRepo", "Global default tracking repo")}</label>
        <TrackingRepoSelect id="globalGithubTrackingDefaultRepo" ariaLabel="Global default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={globalTrackingRepoOptions} loading={globalTrackingRepoLoading} error={globalTrackingRepoError ?? undefined} placeholder={t("settings.globalGeneral.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
        <small>{t("settings.globalGeneral.projectsInheritThisValueWhenTheyDoNot", "Projects inherit this value when they do not set a project default tracking repo.")}</small>
      </div>
      <CliBinaryPanel />
      <div className="form-group">
        <label htmlFor="persistAgentToolOutput" className="checkbox-label">
          <input id="persistAgentToolOutput" type="checkbox" checked={form.persistAgentToolOutput !== false} onChange={(e) => setForm((f) => ({ ...f, persistAgentToolOutput: e.target.checked }))}/>{t("settings.globalGeneral.saveToolOutputInAgentLogs", " Save tool output in agent logs ")}</label>
        <small>{t("settings.globalGeneral.whenDisabledToolRowsAreStillLoggedBut", " When disabled, tool rows are still logged but detailed tool payloads are omitted. Very large tool payloads may still be clipped even when this stays enabled. ")}</small>
      </div>
      <div className="form-group">
        <h5 className="settings-section-heading">{t("settings.globalGeneral.saveAIThinkingLogs", "Save AI thinking logs")}</h5>
        <label htmlFor="persistAgentThinkingLogPermanent" className="checkbox-label">
          <input id="persistAgentThinkingLogPermanent" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: false })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogPermanent: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForPermanentAgents", " Save AI thinking for permanent agents ")}</label>
        <label htmlFor="persistAgentThinkingLogEphemeral" className="checkbox-label">
          <input id="persistAgentThinkingLogEphemeral" type="checkbox" checked={resolvePersistAgentThinkingLog(form, { ephemeral: true })} onChange={(e) => setForm((f) => ({ ...f, persistAgentThinkingLogEphemeral: e.target.checked }))}/>{t("settings.globalGeneral.saveAIThinkingForEphemeralTaskWorkerAgents", " Save AI thinking for ephemeral / task-worker agents ")}</label>
        <small>{t("settings.globalGeneral.leaveBothThinkingTogglesOffToKeepThe", " Leave both thinking toggles off to keep the original default behavior. This only controls persisted ")}<code>thinking</code>{t("settings.globalGeneral.rowsAndDoesNotAffectAssistantTextOr", " rows and does not affect assistant text or tool rows. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="fnBinaryCheckEnabled" className="checkbox-label">
          <input id="fnBinaryCheckEnabled" type="checkbox" checked={form.fnBinaryCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, fnBinaryCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForThe", " Check for the ")}<code>fn</code>{t("settings.globalGeneral.cLIBinaryOnPATH", " CLI binary on PATH ")}</label>
        <small>{t("settings.globalGeneral.whenEnabledTheDashboardProbesForAGlobally", " When enabled, the dashboard probes for a globally-installed")}{" "}
          <code>fn</code> / <code>fusion</code>{t("settings.globalGeneral.cLIBySpawning", " CLI by spawning")}{" "}
          <code>&lt;bin&gt; --version</code>{t("settings.globalGeneral.disableThisIfYourLocalDevProcessIs", ". Disable this if your local dev process is the source of truth and you don&apos;t want any outdated globally-installed binary executed during the probe. ")}</small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalGeneral.updates", "Updates")}</h4>
      <div className="form-group">
        <label htmlFor="updateCheckEnabled" className="checkbox-label">
          <input id="updateCheckEnabled" type="checkbox" checked={form.updateCheckEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, updateCheckEnabled: e.target.checked }))}/>{t("settings.globalGeneral.checkForUpdatesAutomatically", " Check for updates automatically ")}</label>
        <small>{t("settings.globalGeneral.whenEnabledFusionChecksNpmForNewVersions", " When enabled, Fusion checks npm for new versions of")}{" "}
          <code>@runfusion/fusion</code>{t("settings.globalGeneral.andShowsUpdateNoticesInTheCLIAnd", " and shows update notices in the CLI and dashboard. Cadence is governed by the frequency below. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="updateCheckFrequency">{t("settings.globalGeneral.frequency", "Frequency")}</label>
        <select id="updateCheckFrequency" value={form.updateCheckFrequency ?? "daily"} onChange={(e) => setForm((f) => ({
            ...f,
            updateCheckFrequency: e.target.value as "manual" | "on-startup" | "daily" | "weekly",
        }))} disabled={form.updateCheckEnabled === false}>
          <option value="manual">{t("settings.globalGeneral.manualOnlyNeverAutoCheck", "Manual only \u2014 never auto-check")}</option>
          <option value="on-startup">{t("settings.globalGeneral.onStartupOncePerServerLaunch", "On startup \u2014 once per server launch")}</option>
          <option value="daily">{t("settings.globalGeneral.dailyRecommended", "Daily (recommended)")}</option>
          <option value="weekly">{t("settings.globalGeneral.weekly", "Weekly")}</option>
        </select>
        <small>{t("settings.globalGeneral.controlsHowOftenTheDashboardReFetchesThe", " Controls how often the dashboard re-fetches the npm registry. Use the version + refresh control in the header to trigger an immediate check at any time. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="autoReloadOnVersionChange" className="checkbox-label">
          <input id="autoReloadOnVersionChange" type="checkbox" checked={form.autoReloadOnVersionChange !== false} onChange={(e) => setForm((f) => ({ ...f, autoReloadOnVersionChange: e.target.checked }))}/>{t("settings.globalGeneral.autoReloadDashboardOnVersionChange", " Auto-reload dashboard on version change ")}</label>
        <small>{t("settings.globalGeneral.whenEnabledDefaultTheDashboardAutomaticallyReloadsWhen", " When enabled (default), the dashboard automatically reloads when it detects a new build version \u2014 either from server rebuilds or service worker updates. Disable this to stay on the current version until you manually refresh. ")}</small>
      </div>
    </>);
}
export default GlobalGeneralSection;
