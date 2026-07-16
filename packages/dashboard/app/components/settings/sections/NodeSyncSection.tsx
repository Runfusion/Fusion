import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import type { SectionBaseProps } from "./context";
export interface NodeSyncSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
}
/*
FNXC:SettingsScope 2026-07-15-17:35:
Every sync setting here is global (DEFAULT_GLOBAL_SETTINGS): sync is a property of this node's relationship to its peers, not of any one project, so the badges read "global" even though the operator reached them from a project.

FNXC:NodeSync 2026-07-15-17:35:
The auth/interval/conflict rows stay gated behind settingsSyncEnabled. Credential sync in particular must not be reachable — even to read — while sync is off, so the gate is conditional rendering rather than a disabled row.
*/
export function NodeSyncSection({ scopeBanner, form, setForm }: NodeSyncSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.nodeSync.nodeSync", "Node Sync")}</h4>
      <SettingsToggleRow
        descriptor={{
          key: "settingsSyncEnabled",
          label: t("settings.nodeSync.enableAutomaticSettingsSync", " Enable automatic settings sync "),
          help: t("settings.nodeSync.automaticallySynchronizeSettingsBetweenThisNodeAndConnected", "Automatically synchronize settings between this node and connected remote nodes. Default: disabled."),
          scope: "global",
        }}
        value={form.settingsSyncEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, settingsSyncEnabled: v === true }))}
      />
      {form.settingsSyncEnabled && (<>
          <SettingsToggleRow
            descriptor={{
              key: "settingsSyncAuth",
              label: t("settings.nodeSync.syncModelAuthCredentials", " Sync model auth credentials "),
              help: t("settings.nodeSync.includeAPIKeysAndOAuthTokensInSync", "Include API keys and OAuth tokens in sync operations. Default: disabled."),
              scope: "global",
            }}
            value={form.settingsSyncAuth || false}
            onChange={(v) => setForm((f) => ({ ...f, settingsSyncAuth: v === true }))}
          />
          {/*
          FNXC:NodeSync 2026-07-15-17:35:
          The interval is stored in milliseconds but offered as a fixed set of periods, so the select carries stringified ms values and parses back on change — operators pick "Every 15 minutes", the engine reads 900000.
          */}
          <SettingsSelectRow
            descriptor={{
              key: "settingsSyncInterval",
              label: t("settings.nodeSync.syncInterval", "Sync interval"),
              help: t("settings.nodeSync.syncIntervalHint", "Default: every 15 minutes."),
              scope: "global",
              options: [
                { value: "300000", label: t("settings.nodeSync.every5Minutes", "Every 5 minutes") },
                { value: "900000", label: t("settings.nodeSync.every15Minutes", "Every 15 minutes") },
                { value: "1800000", label: t("settings.nodeSync.every30Minutes", "Every 30 minutes") },
                { value: "3600000", label: t("settings.nodeSync.every1Hour", "Every 1 hour") },
              ],
            }}
            value={String(form.settingsSyncInterval || 900000)}
            onChange={(v) => setForm((f) => ({ ...f, settingsSyncInterval: parseInt(v ?? "", 10) }))}
          />
          <SettingsSelectRow
            descriptor={{
              key: "settingsSyncConflictResolution",
              label: t("settings.nodeSync.conflictResolution", "Conflict resolution"),
              help: t("settings.nodeSync.conflictResolutionHint", "Default: last write wins."),
              scope: "global",
              options: [
                { value: "last-write-wins", label: t("settings.nodeSync.lastWriteWins", "Last write wins") },
                { value: "always-ask", label: t("settings.nodeSync.alwaysAsk", "Always ask") },
                { value: "keep-local", label: t("settings.nodeSync.keepLocal", "Keep local") },
                { value: "keep-remote", label: t("settings.nodeSync.keepRemote", "Keep remote") },
              ],
            }}
            value={form.settingsSyncConflictResolution || "last-write-wins"}
            onChange={(v) => setForm((f) => ({
                ...f,
                settingsSyncConflictResolution: v as "last-write-wins" | "always-ask" | "keep-local" | "keep-remote",
            }))}
          />
        </>)}
      {/* KTD-8: workflow settings are not yet part of the cross-node sync
            channel. Non-dismissible, informational only, no action affordance. */}
      <p className="settings-sync-workflow-note text-muted" role="note">
        {t("settings.nodeSync.workflowSettingsNotSynced", "Workflow settings are not synced across nodes yet.")}
      </p>
    </>);
}
export default NodeSyncSection;
