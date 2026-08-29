import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { List, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EditDraftModal } from "./manage/EditDraftModal.js";
import { useDrafts } from "./manage/useDrafts.js";
import { CliPrintingPressTestRunner } from "./run/TestRunnerPanel.js";
import type { ServiceDraft } from "./wizard/types.js";
import "./manage-view.css";

// FN-3763 symbol drift note: plugin id/registry route uses "fusion-plugin-cli-printing-press"
// and bundled registration lives in registerBundledPluginViews.ts (not pluginViewRegistry.tsx).
export function CliPrintingPressManageView({ context: _context }: { context?: PluginDashboardViewContext }) {
  const { drafts, loading, error, refresh, getDraft, updateDraft, regenerateDraft, deleteDraft } = useDrafts();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<ServiceDraft | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);

  useEffect(() => {
    if (!drafts.length) {
      setSelectedId(null);
      setSelectedDraft(null);
      return;
    }
    const activeId = selectedId && drafts.some((item) => item.id === selectedId) ? selectedId : drafts[0]?.id ?? null;
    setSelectedId(activeId);
  }, [drafts, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    void (async () => {
      try {
        setDetailError(null);
        setSelectedDraft(await getDraft(selectedId));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load draft details");
      }
    })();
  }, [getDraft, selectedId]);

  const selectedListItem = useMemo(() => drafts.find((item) => item.id === selectedId) ?? null, [drafts, selectedId]);

  async function onRegenerate() {
    if (!selectedId) return;
    try {
      const response = await regenerateDraft(selectedId);
      setSelectedDraft(response.draft);
      setStatusMessage(`Regenerated at ${new Date(response.artifact.generatedAt).toLocaleString()}`);
      await refresh();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to regenerate draft");
    }
  }

  async function onDelete() {
    if (!selectedId) return;
    if (!globalThis.confirm("Delete this draft?")) return;
    try {
      await deleteDraft(selectedId);
      setStatusMessage("Draft removed");
      await refresh();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to delete draft");
    }
  }

  async function onSaveEditedDraft(nextDraft: ServiceDraft) {
    if (!selectedId) return;
    const saved = await updateDraft(selectedId, nextDraft);
    setSelectedDraft(saved);
    setIsEditOpen(false);
    setStatusMessage("Draft updated");
    await refresh();
  }

  if (loading) return <section className="card cli-press-manage-state"><p>Loading drafts…</p></section>;
  if (error) return <section className="card cli-press-manage-state"><p className="form-error">{error}</p></section>;

  return (
    <section className="cli-press-manage">
      <header className="cli-press-manage-header">
        <h2><List /> Manage Service CLIs</h2>
      </header>
      {statusMessage ? <p className="cli-press-manage-status">{statusMessage}</p> : null}
      {!drafts.length ? <div className="card"><p>No saved drafts yet. Use the Create Service CLI view to add one.</p></div> : (
        <div className="cli-press-manage-layout">
          <div className="cli-press-manage-list">
            {drafts.map((draft) => (
              <button key={draft.id} className={`card cli-press-manage-row${draft.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(draft.id)}>
                <div className="cli-press-manage-row-title">{draft.name || draft.slug}</div>
                <div className="cli-press-manage-row-meta">{draft.slug} • {new Date(draft.updatedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
          <div className="card cli-press-manage-detail">
            {detailError ? <p className="form-error">{detailError}</p> : null}
            {selectedDraft ? (
              <>
                <h3>{selectedDraft.name}</h3>
                <p><strong>Slug:</strong> {selectedListItem?.slug}</p>
                <p><strong>Base URL:</strong> {selectedDraft.baseUrl}</p>
                <p><strong>Endpoints:</strong> {selectedDraft.endpoints.length}</p>
                <p><strong>Credentials:</strong> {selectedDraft.credential.kind}</p>
                <p><strong>Updated:</strong> {new Date(selectedDraft.updatedAt).toLocaleString()}</p>
                <div className="cli-press-manage-actions">
                  <button className="btn" onClick={() => setIsEditOpen(true)}><Pencil /> Edit</button>
                  <button className="btn" onClick={() => void onRegenerate()}><RefreshCw /> Regenerate</button>
                  <button className="btn btn-danger" onClick={() => void onDelete()}><Trash2 /> Delete</button>
                </div>
                <CliPrintingPressTestRunner draftId={selectedDraft.id} draft={selectedDraft} />
              </>
            ) : <p>Select a draft to inspect details.</p>}
          </div>
        </div>
      )}
      {isEditOpen && selectedDraft ? <EditDraftModal initialDraft={selectedDraft} onClose={() => setIsEditOpen(false)} onSave={onSaveEditedDraft} /> : null}
    </section>
  );
}

export default CliPrintingPressManageView;
