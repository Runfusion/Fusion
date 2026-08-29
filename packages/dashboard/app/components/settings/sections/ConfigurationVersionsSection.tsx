import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, withProjectId } from "../../../api/legacy";
import { useConfirm } from "../../../hooks/useConfirm";
import "./ConfigurationVersionsSection.css";

interface ConfigurationRevision {
  id: string;
  configKind: string;
  createdAt: string;
  source: "mutation" | "rollback";
  changedBy?: { kind?: string; id?: string };
}

interface ConfigurationVersionsSectionProps {
  projectId?: string;
  onSettingsRefresh: () => Promise<unknown>;
}

/*
FNXC:SettingsNavigation 2026-07-18-12:30:
FN-8350 moves recorded configuration versions and their confirmed rollback action
out of Command Center into Settings. This preserves the project-scoped revision
API and refreshes the Settings form after a restore so displayed controls match
the newly recorded forward revision.
*/
export function ConfigurationVersionsSection({ projectId, onSettingsRefresh }: ConfigurationVersionsSectionProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const [revisions, setRevisions] = useState<ConfigurationRevision[] | null>(null);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [rollbackId, setRollbackId] = useState<string | null>(null);

  const loadRevisions = async () => {
    try {
      setRevisionsError(null);
      const response = await api<{ revisions?: ConfigurationRevision[] }>(withProjectId("/config/revisions", projectId));
      setRevisions(Array.isArray(response.revisions) ? response.revisions : []);
    } catch (error) {
      setRevisions(null);
      setRevisionsError(error instanceof Error ? error.message : t("settings.configVersions.loadError", "Unable to load configuration versions"));
    }
  };

  useEffect(() => { void loadRevisions(); }, [projectId]);

  const rollback = async (revision: ConfigurationRevision) => {
    const approved = await confirm({
      title: t("settings.configVersions.confirmTitle", "Roll back configuration?"),
      message: t("settings.configVersions.confirmMessage", "Restore this version? The rollback is recorded as a new version."),
      confirmLabel: t("settings.configVersions.confirmRollback", "Roll back"),
      cancelLabel: t("actions.cancel", "Cancel"),
    });
    if (!approved) return;
    setRollbackId(revision.id);
    try {
      await api(withProjectId(`/config/revisions/${encodeURIComponent(revision.id)}/rollback`, projectId), { method: "POST" });
      await onSettingsRefresh();
      await loadRevisions();
    } catch (error) {
      setRevisionsError(error instanceof Error ? error.message : t("settings.configVersions.rollbackError", "Unable to roll back configuration"));
    } finally {
      setRollbackId(null);
    }
  };

  return <section className="configuration-versions-section" data-testid="settings-config-versions">
    <h4 className="settings-section-heading">{t("settings.configVersions.title", "Configuration versions")}</h4>
    <p className="settings-section-description">{t("settings.configVersions.description", "Restore any recorded project configuration version.")}</p>
    {revisionsError ? <p className="configuration-versions-section__error" role="alert">{revisionsError}</p> : revisions === null ? <p className="settings-muted">{t("settings.configVersions.loading", "Loading versions…")}</p> : revisions.length === 0 ? <p className="settings-muted" data-testid="settings-config-versions-empty">{t("settings.configVersions.empty", "No configuration versions yet.")}</p> : <ul className="configuration-versions-section__list" data-testid="settings-config-versions-list">{revisions.map((revision) => <li key={revision.id} className="configuration-versions-section__item"><span><strong>{revision.configKind}</strong><small>{new Date(revision.createdAt).toLocaleString()}</small></span><button type="button" className="btn btn-secondary" onClick={() => void rollback(revision)} disabled={rollbackId !== null}>{rollbackId === revision.id ? t("settings.configVersions.rollingBack", "Rolling back…") : <><RotateCcw size={16} aria-hidden="true" />{t("settings.configVersions.rollback", "Roll back")}</>}</button></li>)}</ul>}
  </section>;
}

export default ConfigurationVersionsSection;
