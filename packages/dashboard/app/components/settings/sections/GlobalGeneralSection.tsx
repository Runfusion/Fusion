import type { ReactNode } from "react";
import type { GlobalSettings } from "@fusion/core";
import { resolvePersistAgentThinkingLog } from "@fusion/core";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { CliBinaryPanel } from "../../CliBinaryPanel";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
import {
    DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS,
    describeShortcutValidation,
    normalizeKeyboardShortcut,
    resolveDashboardKeyboardShortcuts,
} from "../../../utils/keyboardShortcuts";
export interface GlobalGeneralSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    globalSettings: Pick<GlobalSettings, "gitlabEnabled" | "gitlabInstanceUrl" | "gitlabApiBaseUrl" | "gitlabAuthToken" | "gitlabAuthTokenType"> | null;
    onGlobalGitlabSettingsChange: (patch: Partial<Pick<GlobalSettings, "gitlabEnabled" | "gitlabInstanceUrl" | "gitlabApiBaseUrl" | "gitlabAuthToken" | "gitlabAuthTokenType">>) => void;
    globalTrackingRepoOptions: TrackingRepoOption[];
    globalTrackingRepoLoading: boolean;
    globalTrackingRepoError: string | null;
}
export function GlobalGeneralSection({ scopeBanner, form, setForm, globalSettings, onGlobalGitlabSettingsChange, globalTrackingRepoOptions, globalTrackingRepoLoading, globalTrackingRepoError, }: GlobalGeneralSectionProps) {
    const { t } = useTranslation("app");
    const globalGitlab = globalSettings ?? form;
    const shortcutValues = resolveDashboardKeyboardShortcuts(form.dashboardKeyboardShortcuts);
    const shortcutValidationMessage = describeShortcutValidation(shortcutValues);
    const quickChatShortcut = normalizeKeyboardShortcut(shortcutValues.quickChat);
    const terminalShortcut = normalizeKeyboardShortcut(shortcutValues.terminal);
    const updateShortcut = (action: "quickChat" | "terminal", value: string) => setForm((f) => ({
        ...f,
        dashboardKeyboardShortcuts: {
            ...resolveDashboardKeyboardShortcuts(f.dashboardKeyboardShortcuts),
            [action]: value,
        },
    }));
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.globalGeneral.general", "General")}</h4>
      <div className="form-group">
        <label htmlFor="globalGithubTrackingDefaultRepo">{t("settings.globalGeneral.globalDefaultTrackingRepo", "Global default tracking repo")}</label>
        <TrackingRepoSelect id="globalGithubTrackingDefaultRepo" ariaLabel="Global default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={globalTrackingRepoOptions} loading={globalTrackingRepoLoading} error={globalTrackingRepoError ?? undefined} placeholder={t("settings.globalGeneral.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
        <small>{t("settings.globalGeneral.projectsInheritThisValueWhenTheyDoNot", "Projects inherit this value when they do not set a project default tracking repo.")}</small>
      </div>
      {/*
        FNXC:GitLabEnablement 2026-07-02-00:00:
        FN-7453 adds a global GitLab enable fallback that can disable outbound GitLab HTTP API operations without deleting saved self-managed URL or token settings. Projects can override the enabled state when they need GitLab active while the global fallback is off.
      */}
      <details className="settings-gitlab-disclosure" data-testid="global-gitlab-configuration-disclosure">
        <summary>
          <span className="settings-gitlab-disclosure__title">{t("settings.globalGeneral.gitLabConfiguration", "GitLab Configuration")}</span>
          <label className="checkbox-label settings-gitlab-disclosure__toggle" htmlFor="globalGitlabEnabled" onClick={(event) => event.stopPropagation()}>
            <input id="globalGitlabEnabled" type="checkbox" checked={globalGitlab.gitlabEnabled !== false} onChange={(e) => onGlobalGitlabSettingsChange({ gitlabEnabled: e.target.checked })}/>
            {t("settings.globalGeneral.enableGitLabIntegration", "Enable GitLab integration")}
          </label>
        </summary>
        <small className="settings-description">{globalGitlab.gitlabEnabled === false ? t("settings.globalGeneral.gitLabDisabledHint", "GitLab API operations are disabled by global default. Saved URL and token fallbacks remain stored for re-enable.") : t("settings.globalGeneral.gitLabEnabledHint", "Global GitLab URL and token fallbacks apply to projects that do not set their own values.")}</small>
        <div className="settings-gitlab-disclosure__body" aria-disabled={globalGitlab.gitlabEnabled === false}>
          <div className="form-group">
            <label htmlFor="globalGitlabInstanceUrl">{t("settings.globalGeneral.gitLabInstanceUrl", "Global GitLab instance URL")}</label>
            <input id="globalGitlabInstanceUrl" className="input" type="url" placeholder="https://gitlab.com" value={globalGitlab.gitlabInstanceUrl ?? ""} disabled={globalGitlab.gitlabEnabled === false} onChange={(e) => onGlobalGitlabSettingsChange({ gitlabInstanceUrl: e.target.value || undefined })}/>
            <small>{t("settings.globalGeneral.gitLabInstanceUrlHint", "Blank defaults to GitLab.com. Projects inherit this self-managed GitLab URL unless they set their own project value.")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="globalGitlabApiBaseUrl">{t("settings.globalGeneral.gitLabApiBaseUrlOptional", "Global GitLab API base URL (optional / advanced)")}</label>
            <input id="globalGitlabApiBaseUrl" className="input" type="url" placeholder="https://gitlab.com/api/v4" value={globalGitlab.gitlabApiBaseUrl ?? ""} disabled={globalGitlab.gitlabEnabled === false} onChange={(e) => onGlobalGitlabSettingsChange({ gitlabApiBaseUrl: e.target.value || undefined })}/>
            <small>{t("settings.globalGeneral.gitLabApiBaseUrlHint", "Blank derives <instance>/api/v4. Override only for self-managed GitLab API gateways that use a different absolute http:// or https:// URL.")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="globalGitlabAuthTokenType">{t("settings.globalGeneral.gitLabTokenType", "Global GitLab token type")}</label>
            <select id="globalGitlabAuthTokenType" className="select" value={globalGitlab.gitlabAuthTokenType ?? "personal"} disabled={globalGitlab.gitlabEnabled === false} onChange={(e) => onGlobalGitlabSettingsChange({ gitlabAuthTokenType: e.target.value as "personal" | "project" | "group" })}>
              <option value="personal">{t("settings.globalGeneral.gitLabPersonalAccessToken", "Personal access token")}</option>
              <option value="project">{t("settings.globalGeneral.gitLabProjectAccessToken", "Project access token")}</option>
              <option value="group">{t("settings.globalGeneral.gitLabGroupAccessToken", "Group access token")}</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="globalGitlabAuthToken">{t("settings.globalGeneral.gitLabAccessToken", "Global GitLab access token")}</label>
            <input id="globalGitlabAuthToken" className="input" type="password" autoComplete="off" value={globalGitlab.gitlabAuthToken ?? ""} disabled={globalGitlab.gitlabEnabled === false} onChange={(e) => onGlobalGitlabSettingsChange({ gitlabAuthToken: e.target.value || undefined })}/>
            <small className="settings-description">{t("settings.globalGeneral.gitLabAuthTokenHint", "Projects inherit this fallback only when they do not set a project GitLab token. Read-only operations need read_api or api; write actions need api; project/group tokens remain limited by resource membership.")}</small>
          </div>
        </div>
      </details>
      <CliBinaryPanel />
      {/*
        FNXC:DashboardShortcuts 2026-07-04-00:00:
        Keyboard shortcut controls live in Global General because shortcuts open user-interface surfaces for the current browser/operator, not project execution behavior. Blank inputs intentionally disable the action; duplicate or invalid populated shortcuts are blocked before save.
      */}
      <div className="form-group settings-keyboard-shortcuts" data-testid="keyboard-shortcuts-settings">
        <h5 className="settings-section-heading">{t("settings.globalGeneral.keyboardShortcuts", "Keyboard shortcuts")}</h5>
        <p className="settings-description">{t("settings.globalGeneral.keyboardShortcutsHint", "Configure global dashboard shortcuts. Shortcuts are ignored while typing in inputs, editors, chat composers, and terminal fields.")}</p>
        <div className="settings-keyboard-shortcuts__grid">
          <div className="form-group">
            <label htmlFor="dashboardShortcutQuickChat">{t("settings.globalGeneral.quickChatShortcut", "Quick Chat shortcut")}</label>
            <input id="dashboardShortcutQuickChat" className="input" value={shortcutValues.quickChat} placeholder={DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS.quickChat} aria-invalid={!quickChatShortcut.valid || undefined} aria-describedby="dashboardShortcutQuickChatHint" onChange={(e) => updateShortcut("quickChat", e.target.value)}/>
            <small id="dashboardShortcutQuickChatHint">{quickChatShortcut.valid ? t("settings.globalGeneral.quickChatShortcutHint", "Default: Space. Leave blank to disable Quick Chat keyboard opening.") : quickChatShortcut.error}</small>
          </div>
          <div className="form-group">
            <label htmlFor="dashboardShortcutTerminal">{t("settings.globalGeneral.terminalShortcut", "Terminal shortcut")}</label>
            <input id="dashboardShortcutTerminal" className="input" value={shortcutValues.terminal} placeholder={DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS.terminal} aria-invalid={!terminalShortcut.valid || undefined} aria-describedby="dashboardShortcutTerminalHint" onChange={(e) => updateShortcut("terminal", e.target.value)}/>
            <small id="dashboardShortcutTerminalHint">{terminalShortcut.valid ? t("settings.globalGeneral.terminalShortcutHint", "Default: Ctrl+`. Leave blank to disable Terminal keyboard opening.") : terminalShortcut.error}</small>
          </div>
        </div>
        {shortcutValidationMessage && <small className="settings-description error-text" role="alert">{shortcutValidationMessage}</small>}
      </div>
      <div className="form-group">
        <label htmlFor="dismissModalsOnOutsideClick" className="checkbox-label">
          <input id="dismissModalsOnOutsideClick" type="checkbox" checked={form.dismissModalsOnOutsideClick === true} onChange={(e) => setForm((f) => ({ ...f, dismissModalsOnOutsideClick: e.target.checked }))}/>{t("settings.globalGeneral.dismissModalsByClickingOutside", " Dismiss modals by clicking outside ")}</label>
        <small>{t("settings.globalGeneral.dismissModalsByClickingOutsideHint", " When enabled, clicking or tapping a modal backdrop closes the modal. Off by default to prevent accidental dismissal. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="persistAgentToolOutput" className="checkbox-label">
          <input id="persistAgentToolOutput" type="checkbox" checked={form.persistAgentToolOutput === true} onChange={(e) => setForm((f) => ({ ...f, persistAgentToolOutput: e.target.checked }))}/>{t("settings.globalGeneral.saveToolOutputInAgentLogs", " Save tool output in agent logs ")}</label>
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
          <code>&lt;bin&gt; --version</code>{t("settings.globalGeneral.disableThisIfYourLocalDevProcessIs", ". Disable this if your local dev process is the source of truth and you don't want any outdated globally-installed binary executed during the probe. ")}</small>
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
