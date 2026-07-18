import { useEffect, useRef, useState } from "react";
import { Download, RotateCcw, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, withProjectId } from "../../api/legacy";
import { useConfirm } from "../../hooks/useConfirm";
import "./OrgPortabilityControls.css";

interface ConfigurationRevision {
  id: string;
  configKind: string;
  createdAt: string;
  source: "mutation" | "rollback";
  changedBy?: { kind?: string; id?: string };
}

interface OrgPortabilityControlsProps {
  projectId?: string;
  onSettingsRefresh: () => Promise<unknown>;
}

function downloadBundle(bundle: unknown) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = "fusion-org-bundle.json";
  link.click();
  URL.revokeObjectURL(href);
}

/*
FNXC:CommandCenterConfig 2026-07-18-12:00:
FR-05 puts portable org handoff and safe configuration undo beside operator
controls. Import accepts the core's secret-scrubbed bundle only, and rollback is
a single confirmed restore action rather than a manual reconstruction workflow.
*/
export function OrgPortabilityControls({ projectId, onSettingsRefresh }: OrgPortabilityControlsProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const [exportState, setExportState] = useState<"idle" | "working" | "success" | "error">("idle");
  const [importState, setImportState] = useState<"idle" | "previewing" | "previewed" | "importing" | "success" | "error">("idle");
  const [bundleText, setBundleText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [preview, setPreview] = useState<unknown>(null);
  const [previewedBundle, setPreviewedBundle] = useState<Record<string, unknown> | null>(null);
  const bundleVersion = useRef(0);
  const [revisions, setRevisions] = useState<ConfigurationRevision[] | null>(null);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [rollbackId, setRollbackId] = useState<string | null>(null);

  const revisionPath = withProjectId("/config/revisions", projectId);
  const loadRevisions = async () => {
    try {
      setRevisionsError(null);
      const response = await api<{ revisions?: ConfigurationRevision[] }>(revisionPath);
      setRevisions(Array.isArray(response.revisions) ? response.revisions : []);
    } catch (error) {
      setRevisions(null);
      setRevisionsError(error instanceof Error ? error.message : t("commandCenter.portability.versions.loadError", "Unable to load configuration versions"));
    }
  };

  useEffect(() => { void loadRevisions(); }, [projectId]);

  const exportOrg = async () => {
    setExportState("working");
    try {
      const response = await api<{ bundle: unknown }>(withProjectId("/org/export", projectId), { method: "POST" });
      downloadBundle(response.bundle);
      setExportState("success");
    } catch {
      setExportState("error");
    }
  };

  const parseBundle = (): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(bundleText) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
      return value as Record<string, unknown>;
    } catch {
      setImportError(t("commandCenter.portability.import.invalid", "Paste a valid org bundle JSON document"));
      setImportState("error");
      return null;
    }
  };

  const previewImport = async () => {
    const bundle = parseBundle();
    if (!bundle) return;
    const previewVersion = bundleVersion.current;
    setImportState("previewing");
    setImportError(null);
    try {
      const response = await api<{ result: unknown }>(withProjectId("/org/import", projectId), { method: "POST", body: JSON.stringify({ bundle, dryRun: true }) });
      if (bundleVersion.current !== previewVersion) return;
      setPreview(response.result);
      setPreviewedBundle(bundle);
      setImportState("previewed");
    } catch (error) {
      if (bundleVersion.current !== previewVersion) return;
      setImportError(error instanceof Error ? error.message : t("commandCenter.portability.import.error", "Unable to preview import"));
      setImportState("error");
    }
  };

  const applyImport = async () => {
    if (!previewedBundle) return;
    const approved = await confirm({
      title: t("commandCenter.portability.import.confirmTitle", "Import organization bundle?"),
      message: t("commandCenter.portability.import.confirmMessage", "This applies the previewed configuration to this project."),
      confirmLabel: t("commandCenter.portability.import.confirmApply", "Import bundle"),
      cancelLabel: t("actions.cancel", "Cancel"),
    });
    if (!approved) return;
    setImportState("importing");
    try {
      await api(withProjectId("/org/import", projectId), { method: "POST", body: JSON.stringify({ bundle: previewedBundle, dryRun: false }) });
      await onSettingsRefresh();
      await loadRevisions();
      setImportState("success");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t("commandCenter.portability.import.error", "Unable to import bundle"));
      setImportState("error");
    }
  };

  const rollback = async (revision: ConfigurationRevision) => {
    const approved = await confirm({
      title: t("commandCenter.portability.versions.confirmTitle", "Roll back configuration?"),
      message: t("commandCenter.portability.versions.confirmMessage", "Restore this version? The rollback is recorded as a new version."),
      confirmLabel: t("commandCenter.portability.versions.confirmRollback", "Roll back"),
      cancelLabel: t("actions.cancel", "Cancel"),
    });
    if (!approved) return;
    setRollbackId(revision.id);
    try {
      await api(withProjectId(`/config/revisions/${encodeURIComponent(revision.id)}/rollback`, projectId), { method: "POST" });
      await onSettingsRefresh();
      await loadRevisions();
    } catch (error) {
      setRevisionsError(error instanceof Error ? error.message : t("commandCenter.portability.versions.rollbackError", "Unable to roll back configuration"));
    } finally {
      setRollbackId(null);
    }
  };

  const exportLabel = exportState === "working" ? t("commandCenter.portability.export.working", "Exporting…") : t("commandCenter.portability.export.action", "Export org bundle");

  return <>
    <section className="card cc-controls-card cc-portability-card" data-testid="cc-controls-org-portability">
      <div className="cc-controls-card-header">
        <div><h3>{t("commandCenter.portability.title", "Org export / import")}</h3><p>{t("commandCenter.portability.description", "Download or preview a secret-scrubbed organization bundle.")}</p></div>
        <span className={`cc-controls-save-state cc-controls-save-state--${exportState}`} aria-live="polite">{exportState === "success" ? t("commandCenter.portability.export.success", "Export ready") : exportState === "error" ? t("commandCenter.portability.export.error", "Export failed") : t("commandCenter.controls.status.ready", "Ready")}</span>
      </div>
      <div className="cc-portability-actions">
        <button type="button" className="btn btn-secondary cc-controls-action" onClick={() => void exportOrg()} disabled={exportState === "working"}><Download size={16} aria-hidden="true" />{exportLabel}</button>
        <label className="cc-portability-import-label" htmlFor="cc-org-bundle">{t("commandCenter.portability.import.label", "Org bundle JSON")}</label>
        <textarea id="cc-org-bundle" className="input cc-portability-import-input" value={bundleText} onChange={(event) => {
          /*
          FNXC:CommandCenterConfig 2026-07-18-12:02:
          Editing a bundle invalidates any dry-run in flight and its approval. Apply must use the exact previewed payload, never newer unpreviewed text.
          */
          bundleVersion.current += 1;
          setBundleText(event.target.value);
          setPreview(null);
          setPreviewedBundle(null);
          setImportError(null);
          setImportState("idle");
        }} placeholder={t("commandCenter.portability.import.placeholder", "Paste a secret-scrubbed org bundle")}/>
        <div className="cc-portability-actions">
          <button type="button" className="btn btn-secondary cc-controls-action" onClick={() => void previewImport()} disabled={!bundleText || importState === "previewing"}><Upload size={16} aria-hidden="true" />{importState === "previewing" ? t("commandCenter.portability.import.previewing", "Previewing…") : t("commandCenter.portability.import.preview", "Preview import")}</button>
          <button type="button" className="btn cc-controls-action" onClick={() => void applyImport()} disabled={importState !== "previewed" && importState !== "success"}>{importState === "importing" ? t("commandCenter.portability.import.importing", "Importing…") : t("commandCenter.portability.import.apply", "Apply import")}</button>
        </div>
      </div>
      {preview ? <p className="cc-controls-muted" data-testid="cc-org-import-preview">{t("commandCenter.portability.import.previewReady", "Preview ready. Confirm to apply this bundle.")}</p> : null}
      {importError ? <p className="cc-controls-error" role="alert">{importError}</p> : null}
    </section>

    <section className="card cc-controls-card cc-portability-card cc-portability-card--versions" data-testid="cc-controls-config-versions">
      <div className="cc-controls-card-header"><div><h3>{t("commandCenter.portability.versions.title", "Configuration versions")}</h3><p>{t("commandCenter.portability.versions.description", "Restore any recorded project configuration version.")}</p></div></div>
      {revisionsError ? <p className="cc-controls-error" role="alert">{revisionsError}</p> : revisions === null ? <p className="cc-controls-muted">{t("commandCenter.portability.versions.loading", "Loading versions…")}</p> : revisions.length === 0 ? <p className="cc-controls-muted" data-testid="cc-config-versions-empty">{t("commandCenter.portability.versions.empty", "No configuration versions yet.")}</p> : <ul className="cc-portability-version-list" data-testid="cc-config-versions-list">{revisions.map((revision) => <li key={revision.id} className="cc-portability-version"><span><strong>{revision.configKind}</strong><small>{new Date(revision.createdAt).toLocaleString()}</small></span><button type="button" className="btn btn-secondary cc-controls-action" onClick={() => void rollback(revision)} disabled={rollbackId !== null}>{rollbackId === revision.id ? t("commandCenter.portability.versions.rollingBack", "Rolling back…") : <><RotateCcw size={16} aria-hidden="true" />{t("commandCenter.portability.versions.rollback", "Roll back")}</>}</button></li>)}</ul>}
    </section>
  </>;
}
