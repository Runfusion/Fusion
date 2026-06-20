import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SectionBaseProps } from "./context";
export interface NodeSyncSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
}
export function NodeSyncSection({ scopeBanner, form, setForm }: NodeSyncSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.nodeSync.nodeSync", "Node Sync")}</h4>
      <div className="form-group">
        <label htmlFor="settingsSyncEnabled" className="checkbox-label">
          <input id="settingsSyncEnabled" type="checkbox" checked={form.settingsSyncEnabled || false} onChange={(e) => setForm((f) => ({ ...f, settingsSyncEnabled: e.target.checked }))}/>{t("settings.nodeSync.enableAutomaticSettingsSync", " Enable automatic settings sync ")}</label>
        <small>{t("settings.nodeSync.automaticallySynchronizeSettingsBetweenThisNodeAndConnected", "Automatically synchronize settings between this node and connected remote nodes")}</small>
      </div>
      {form.settingsSyncEnabled && (<>
          <div className="form-group">
            <label htmlFor="settingsSyncAuth" className="checkbox-label">
              <input id="settingsSyncAuth" type="checkbox" checked={form.settingsSyncAuth || false} onChange={(e) => setForm((f) => ({ ...f, settingsSyncAuth: e.target.checked }))}/>{t("settings.nodeSync.syncModelAuthCredentials", " Sync model auth credentials ")}</label>
            <small>{t("settings.nodeSync.includeAPIKeysAndOAuthTokensInSync", "Include API keys and OAuth tokens in sync operations")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="settingsSyncInterval">{t("settings.nodeSync.syncInterval", "Sync interval")}</label>
            <select id="settingsSyncInterval" className="select" value={form.settingsSyncInterval || 900000} onChange={(e) => setForm((f) => ({ ...f, settingsSyncInterval: parseInt(e.target.value, 10) }))}>
              <option value={300000}>{t("settings.nodeSync.every5Minutes", "Every 5 minutes")}</option>
              <option value={900000}>{t("settings.nodeSync.every15Minutes", "Every 15 minutes")}</option>
              <option value={1800000}>{t("settings.nodeSync.every30Minutes", "Every 30 minutes")}</option>
              <option value={3600000}>{t("settings.nodeSync.every1Hour", "Every 1 hour")}</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="settingsSyncConflictResolution">{t("settings.nodeSync.conflictResolution", "Conflict resolution")}</label>
            <select id="settingsSyncConflictResolution" className="select" value={form.settingsSyncConflictResolution || "last-write-wins"} onChange={(e) => setForm((f) => ({
                ...f,
                settingsSyncConflictResolution: e.target.value as "last-write-wins" | "always-ask" | "keep-local" | "keep-remote",
            }))}>
              <option value="last-write-wins">{t("settings.nodeSync.lastWriteWins", "Last write wins")}</option>
              <option value="always-ask">{t("settings.nodeSync.alwaysAsk", "Always ask")}</option>
              <option value="keep-local">{t("settings.nodeSync.keepLocal", "Keep local")}</option>
              <option value="keep-remote">{t("settings.nodeSync.keepRemote", "Keep remote")}</option>
            </select>
          </div>
        </>)}
      {/* KTD-8: workflow settings are not yet part of the cross-node sync
            channel. Non-dismissible, informational only, no action affordance. */}
      <p className="settings-sync-workflow-note text-muted" role="note">
        {t("settings.nodeSync.workflowSettingsNotSynced", "Workflow settings are not synced across nodes yet.")}
      </p>
    </>);
}
export default NodeSyncSection;
