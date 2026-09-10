import "./NotesView.css";
import { useEffect } from "react";
import { ArrowLeft, Plus, RefreshCw, Save, Search, StickyNote, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../hooks/useConfirm";
import { useNotes } from "../hooks/useNotes";
import { FileEditor } from "./FileEditor";
import { ViewHeader } from "./ViewHeader";

export interface NotesViewProps { projectId?: string; addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void; }

export function NotesView({ projectId, addToast }: NotesViewProps) {
  const { t } = useTranslation("app");
  const confirm = useConfirm();
  const notes = useNotes(projectId);
  const abandon = async () => !notes.dirty || confirm.confirm({ title: t("notes.discardTitle", "Discard changes?"), message: t("notes.discardMessage", "Your unsaved draft will be lost."), confirmLabel: t("notes.discard", "Discard"), danger: true });
  const handleCreate = async () => { if (await abandon()) await notes.create(); };
  const activeNoteId = notes.pendingSelectedId ?? notes.selected?.id;
  const handleSelect = async (id: string) => {
    if (id === activeNoteId) return;
    if (notes.dirty && !await abandon()) return;
    await notes.select(id);
  };
  const handleDelete = async () => {
    if (!notes.selected) return;
    if (await confirm.confirm({ title: t("notes.deleteTitle", "Delete note?"), message: t("notes.deleteMessage", "This action cannot be undone."), confirmLabel: t("common.delete", "Delete"), danger: true })) {
      if (await notes.remove()) addToast?.(t("notes.deleted", "Note deleted"), "success");
    }
  };
  const handleSave = async () => { const saved = await notes.save(); if (saved) addToast?.(t("notes.saved", "Note saved"), "success"); };
  /*
  FNXC:ProjectNotes 2026-09-10-00:01:
  Retrying a failed note read must use the same unsaved-draft guard as a fresh list click. A retry may replace the currently displayed note, so bypassing confirmation would silently discard edits made after the failure.
  */
  const handleRetry = async () => {
    if (notes.failedSelectionId) {
      await handleSelect(notes.failedSelectionId);
    } else if (notes.errorOperation === "save") {
      await notes.save();
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && notes.selected) { event.preventDefault(); void handleSave(); } };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  });

  return <section className={`notes-view${notes.selected ? " notes-view--detail" : ""}`} aria-label={t("nav.notes", "Notes")}>
    <ViewHeader icon={StickyNote} title={t("nav.notes", "Notes")} actions={<button className="btn btn-primary" type="button" onClick={() => void handleCreate()} disabled={!projectId || notes.saving}><Plus aria-hidden="true" />{t("notes.new", "New note")}</button>} />
    <div className="notes-layout">
      <aside className="notes-list" aria-label={t("notes.list", "Notes list")}>
        <label className="notes-search"><Search aria-hidden="true" /><span className="sr-only">{t("notes.search", "Search notes")}</span><input className="input" type="search" value={notes.search} placeholder={t("notes.search", "Search notes")} onChange={(event) => notes.setSearch(event.target.value)} /></label>
        {notes.loading && !notes.notes.length ? <p className="notes-state">{t("common.loading", "Loading…")}</p> : null}
        {notes.error && !notes.selected ? <div className="notes-state" role="alert"><p>{notes.error}</p><button className="btn" type="button" onClick={() => void notes.loadList(notes.search)}>{t("common.retry", "Retry")}</button></div> : null}
        {!notes.loading && !notes.error && !notes.notes.length ? <div className="notes-state"><p>{notes.search ? t("notes.noResults", "No notes found") : t("notes.empty", "No notes yet")}</p>{!notes.search ? <button className="btn" type="button" onClick={() => void handleCreate()}>{t("notes.createFirst", "Create your first note")}</button> : null}</div> : null}
        <div className="notes-list-items">{notes.notes.map((note) => {
          const isSelected = note.id === activeNoteId;
          return <button key={note.id} type="button" className={`notes-list-item${isSelected ? " notes-list-item--selected" : ""}`} aria-current={isSelected ? "page" : undefined} onClick={() => void handleSelect(note.id)}><strong>{note.title}</strong><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString()}</time></button>;
        })}</div>
      </aside>
      <main className="notes-detail">
        {notes.selected ? <>
          <div className="notes-detail-toolbar">
            <button className="btn btn-icon notes-back" type="button" aria-label={t("common.back", "Back")} onClick={() => { void abandon().then((ok) => { if (ok) notes.clearSelection(); }); }}><ArrowLeft aria-hidden="true" /></button>
            <input className="input notes-title" aria-label={t("notes.title", "Note title")} maxLength={200} value={notes.draftTitle} onChange={(event) => notes.setDraftTitle(event.target.value)} />
            <span className="notes-save-state">{notes.dirty ? t("notes.unsaved", "Unsaved changes") : t("notes.savedState", "Saved")}</span>
            <button className="btn" type="button" onClick={() => void handleDelete()}><Trash2 aria-hidden="true" />{t("common.delete", "Delete")}</button>
            <button className="btn btn-primary" type="button" disabled={notes.saving || !notes.dirty || !notes.draftTitle.trim()} onClick={() => void handleSave()}><Save aria-hidden="true" />{notes.saving ? t("notes.saving", "Saving…") : t("common.save", "Save")}</button>
          </div>
          {notes.conflict ? <div className="notes-conflict" role="alert"><p>{t("notes.conflict", "This note changed elsewhere. Your draft is preserved.")}</p><button className="btn" type="button" onClick={() => void notes.reload()}><RefreshCw aria-hidden="true" />{t("notes.reload", "Reload server version")}</button><button className="btn btn-primary" type="button" onClick={() => void notes.overwrite()}>{t("notes.overwrite", "Overwrite with my draft")}</button></div> : null}
          {notes.error && !notes.conflict ? <div className="notes-error" role="alert">{notes.error}{notes.failedSelectionId || notes.errorOperation === "save" ? <button className="btn" type="button" onClick={() => void handleRetry()}>{t("common.retry", "Retry")}</button> : null}</div> : null}
          <div className="notes-editor"><FileEditor content={notes.draftContent} onChange={notes.setDraftContent} filePath={`${notes.selected.id}.md`} forceToolbarActionsVisible /></div>
        </> : <div className="notes-state notes-detail-empty"><StickyNote aria-hidden="true" /><p>{t("notes.select", "Select a note or create a new one")}</p></div>}
      </main>
    </div>
  </section>;
}
