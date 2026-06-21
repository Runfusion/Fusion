import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useConfirm } from "../hooks/useConfirm";
import { LoadingSpinner } from "./LoadingSpinner";
import "./StashRecoveryView.css";

type RecordItem = {
  sha: string;
  sourceTaskId: string | null;
  createdAt: string | null;
  classification: "subsumed" | "live" | "unknown";
  changedPaths: string[];
};

type DiffResponse = {
  diff: string;
  truncated: boolean;
};

export function StashRecoveryView() {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<Record<string, string>>({});
  const [diffState, setDiffState] = useState<{ sha: string; diff: string; truncated: boolean; loading: boolean; error: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api<{ records: RecordItem[] }>("/stash-recovery/orphans");
      setRecords(data.records ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stashRecovery.failedToLoadOrphans", "Failed to load orphans"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, RecordItem[]>();
    for (const record of records) {
      const key = record.sourceTaskId ?? t("stashRecovery.unknownSource", "Unknown source");
      const existing = map.get(key) ?? [];
      existing.push(record);
      map.set(key, existing);
    }
    return Array.from(map.entries());
  }, [records, t]);

  const handleApply = useCallback(async (sha: string) => {
    const result = await api<{ ok: boolean; reason?: string; stderr?: string }>(`/stash-recovery/orphans/${sha}/apply`, { method: "POST" });
    setApplyState((prev) => ({ ...prev, [sha]: result.ok ? t("stashRecovery.applied", "Applied") : result.stderr ?? result.reason ?? t("stashRecovery.applyFailed", "Apply failed") }));
  }, [t]);

  const handleDrop = useCallback(async (sha: string) => {
    const shouldDrop = await confirm({
      title: t("stashRecovery.dropTitle", "Drop orphaned stash?"),
      message: t("stashRecovery.dropMessage", "This removes the stash entry permanently."),
      confirmLabel: t("stashRecovery.dropConfirm", "Drop"),
      danger: true,
    });
    if (!shouldDrop) return;
    await api(`/stash-recovery/orphans/${sha}/drop`, { method: "POST", body: JSON.stringify({ confirm: true }) });
    await load();
  }, [confirm, load, t]);

  const handleInspectDiff = useCallback(async (sha: string) => {
    setDiffState({ sha, diff: "", truncated: false, loading: true, error: null });
    try {
      const data = await api<DiffResponse>(`/stash-recovery/orphans/${sha}/diff`);
      setDiffState({ sha, diff: data.diff ?? "", truncated: Boolean(data.truncated), loading: false, error: null });
    } catch (err) {
      setDiffState({ sha, diff: "", truncated: false, loading: false, error: err instanceof Error ? err.message : t("stashRecovery.failedToLoadDiff", "Failed to load diff") });
    }
  }, [t]);

  if (records.length === 0 && !error) {
    return <div className="card stash-recovery-view"><p>{t("stashRecovery.noOrphans", "No orphaned merger autostashes found.")}</p><button className="btn btn-sm" onClick={() => void load()}>{t("actions.refresh", "Refresh")}</button></div>;
  }

  return (
    <div className="card stash-recovery-view">
      <div className="stash-recovery-header">
        <h2>{t("stashRecovery.title", "Stash Recovery")}</h2>
        <span>{t("stashRecovery.orphanCount", "{{count}} orphans", { count: records.length })}</span>
        <button className="btn btn-sm" onClick={() => void load()}>{t("actions.refresh", "Refresh")}</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {groups.map(([group, items]) => (
        <section key={group}>
          <h3>{group}</h3>
          {items.map((item) => (
            <div key={item.sha} className="stash-row">
              <div className="stash-field">
                <span className="stash-field-label">{t("stashRecovery.shaLabel", "SHA")}</span>
                <span>{item.sha.slice(0, 7)}</span>
              </div>
              <div className="stash-field">
                <span className="stash-field-label">{t("stashRecovery.classificationLabel", "Classification")}</span>
                <span>{item.classification}</span>
              </div>
              <div className="stash-field">
                <span className="stash-field-label">{t("stashRecovery.changedPathsLabel", "Changed paths")}</span>
                <span>{t("stashRecovery.fileCount", "{{count}} files", { count: item.changedPaths.length })}</span>
              </div>
              <div className="stash-row-actions">
                <button className="btn btn-sm stash-action-btn" onClick={() => void handleInspectDiff(item.sha)}>{t("stashRecovery.inspectDiff", "Inspect diff")}</button>
                <button className="btn btn-sm stash-action-btn" onClick={() => void handleApply(item.sha)}>{t("stashRecovery.apply", "Apply")}</button>
              </div>
              <div className="stash-row-actions-danger">
                <button className="btn btn-sm btn-danger stash-action-btn" onClick={() => void handleDrop(item.sha)}>{t("stashRecovery.drop", "Drop")}</button>
              </div>
              {applyState[item.sha] && <div className="stash-status">{applyState[item.sha]}</div>}
            </div>
          ))}
        </section>
      ))}
      {diffState && (
        <div className="modal-overlay open" onClick={() => setDiffState(null)}>
          <div className="modal stash-recovery-diff-modal" role="dialog" aria-modal="true" aria-label={t("stashRecovery.diffDialogLabel", "Diff for {{sha}}", { sha: diffState.sha })} onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("stashRecovery.diffHeader", "Diff for {{sha}}", { sha: diffState.sha.slice(0, 7) })}</h3>
              <button className="modal-close" onClick={() => setDiffState(null)} aria-label={t("stashRecovery.closeDiffDialog", "Close diff dialog")}>
                &times;
              </button>
            </div>
            {diffState.loading && <p><LoadingSpinner label={t("stashRecovery.loadingDiff", "Loading diff…")} /></p>}
            {diffState.error && <div className="form-error">{diffState.error}</div>}
            {!diffState.loading && !diffState.error && (
              <>
                <pre className="stash-recovery-diff-pre">{diffState.diff || t("stashRecovery.noDiffOutput", "No diff output available.")}</pre>
                {diffState.truncated && <p className="stash-status">{t("stashRecovery.diffTruncated", "Diff output truncated.")}</p>}
              </>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setDiffState(null)}>{t("actions.close", "Close")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
