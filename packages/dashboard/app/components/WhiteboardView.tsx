import "./WhiteboardView.css";
import { useEffect, useRef } from "react";
import { Copy, Download, FileJson, History, PanelsTopLeft, Save, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../hooks/useConfirm";
import { useWhiteboards } from "../hooks/useWhiteboards";
import { ViewActionButton } from "./ViewActionButton";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { ViewSidebar } from "./ViewSidebar";
import { WhiteboardCanvas } from "./whiteboard/WhiteboardCanvas";
import { exportWhiteboardJson, exportWhiteboardPng } from "./whiteboard/whiteboard-export";
export interface WhiteboardViewProps { projectId?: string; addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void }
/* FNXC:WhiteboardWorkspace 2026-09-10-05:42: Desktop/tablet keep list, canvas, and inspector usable together; mobile drills list-to-editor. Dirty or conflicted drafts remain interactive/exportable and every abandoning navigation asks before replacing them. */
export function WhiteboardView({ projectId, addToast }: WhiteboardViewProps) {
  const { t } = useTranslation("app"); const confirm = useConfirm(); const boards = useWhiteboards(projectId); const canvasRef = useRef<HTMLDivElement>(null);
  const canAbandon = async () => !boards.dirty || confirm.confirm({ title: t("whiteboard.discardTitle", "Discard changes?"), message: t("whiteboard.discardMessage", "Your unsaved Whiteboard draft will be lost."), confirmLabel: t("whiteboard.discard", "Discard"), danger: true });
  const choose = async (id: string) => { if (id !== boards.selected?.id && await canAbandon()) await boards.select(id); };
  const back = async () => { if (await canAbandon()) boards.clearSelection(); };
  const remove = async () => { if (boards.selected && await confirm.confirm({ title: t("whiteboard.deleteTitle", "Delete whiteboard?"), message: t("whiteboard.deleteMessage", "This action cannot be undone."), confirmLabel: t("common.delete", "Delete"), danger: true }) && await boards.remove()) addToast?.(t("whiteboard.deleted", "Whiteboard deleted"), "success"); };
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (boards.dirty) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler); }, [boards.dirty]);
  /* FNXC:WhiteboardCollectionLayout 2026-09-13-16:29: Whiteboard keeps its guarded draft controller mounted while the shared shell presents a resizable desktop collection rail and a canonical mobile list-to-canvas back action. */
  const sidebar = <ViewSidebar ariaLabel={t("whiteboard.list", "Whiteboards")}><div className="whiteboard-list">
        <div className="whiteboard-search"><label className="search-field"><Search className="search-field-icon" size={14} aria-hidden="true" /><input className="search-field-input" type="search" value={boards.search} onChange={(e)=>boards.setSearch(e.target.value)} aria-label={t("whiteboard.search", "Search whiteboards")} placeholder={t("whiteboard.search", "Search whiteboards")} /></label></div>
        {!projectId ? <p className="whiteboard-state">{t("whiteboard.noProject", "Select a project to use Whiteboard")}</p> : null}
        {boards.loading && !boards.whiteboards.length ? <p className="whiteboard-state">{t("common.loading", "Loading…")}</p> : null}
        {!boards.loading && projectId && !boards.whiteboards.length ? <p className="whiteboard-state">{boards.search ? t("whiteboard.noResults", "No whiteboards found") : t("whiteboard.empty", "No whiteboards yet")}</p> : null}
        {boards.whiteboards.map((board)=><button key={board.id} type="button" className={`whiteboard-list-item${board.id === (boards.pendingSelectedId ?? boards.selected?.id) ? " whiteboard-list-item--selected" : ""}`} onClick={()=>void choose(board.id)} aria-current={board.id === boards.selected?.id ? "page" : undefined}><strong>{board.title}</strong><span>{board.id.slice(0,8)}</span><time dateTime={board.updatedAt}>{new Date(board.updatedAt).toLocaleString()}</time></button>)}
      </div></ViewSidebar>;
  const detail = <main className="whiteboard-editor">
        {boards.selected && boards.draftDocument ? <>
          <div className="whiteboard-editor-toolbar">
            <input className="input whiteboard-title" aria-label={t("whiteboard.title", "Whiteboard title")} maxLength={200} value={boards.draftTitle} onChange={(e)=>boards.setDraftTitle(e.target.value)} />
            <span>{boards.saving ? t("whiteboard.saving", "Saving…") : boards.dirty ? t("whiteboard.unsaved", "Unsaved") : t("whiteboard.saved", "Saved")}</span>
            <button className="btn" type="button" onClick={()=>void boards.rename()}>{t("whiteboard.rename", "Rename")}</button>
            <button className="btn btn-primary" type="button" disabled={!boards.dirty || boards.saving} onClick={()=>void boards.save()}><Save />{t("common.save", "Save")}</button>
            <button className="btn" type="button" onClick={()=>exportWhiteboardJson(boards.draftTitle, boards.selected!.revision, boards.draftDocument!)}><FileJson />{t("whiteboard.exportJson", "Export JSON")}</button>
            <button className="btn" type="button" onClick={()=>canvasRef.current && void exportWhiteboardPng(canvasRef.current, boards.draftTitle)}><Download />{t("whiteboard.exportPng", "Export PNG")}</button>
            <button className="btn" type="button" onClick={()=>void boards.loadRevisions()}><History />{t("whiteboard.history", "History")}</button>
            <button className="btn" type="button" onClick={()=>void remove()}><Trash2 />{t("common.delete", "Delete")}</button>
          </div>
          {boards.conflict ? <div className="whiteboard-conflict" role="alert"><p>{t("whiteboard.conflict", "This whiteboard changed elsewhere. Your draft is preserved.")}</p><button className="btn" type="button" onClick={()=>void canAbandon().then(async (ok)=>{ if (ok) await boards.reloadRemote(); })}>{t("whiteboard.reload", "Reload remote")}</button><button className="btn btn-primary" type="button" onClick={()=>void boards.createConflictCopy()}><Copy />{t("whiteboard.copyDraft", "Create copy from draft")}</button></div> : null}
          {boards.error && !boards.conflict ? <div className="whiteboard-error" role="alert">{boards.error}</div> : null}
          {boards.revisions.length ? <div className="whiteboard-revisions">{boards.revisions.map((revision)=><button className="btn" type="button" key={revision.revision} onClick={()=>void boards.restore(revision.revision)}>v{revision.revision} · {new Date(revision.createdAt).toLocaleString()}</button>)}</div> : null}
          <div className="whiteboard-canvas-host" ref={canvasRef}><WhiteboardCanvas document={boards.draftDocument} onChange={boards.setDraftDocument} /></div>
        </> : <div className="whiteboard-state whiteboard-editor-empty"><PanelsTopLeft /><p>{t("whiteboard.select", "Select or create a whiteboard")}</p></div>}
      </main>;
  return <section className={`whiteboard-view${boards.selected ? " whiteboard-view--editor" : ""}`} aria-label={t("nav.whiteboard", "Whiteboard")}>
    <ViewLayout
      header={<ViewHeader icon={PanelsTopLeft} title={t("nav.whiteboard", "Whiteboard")} backAction={boards.selected ? { label: t("common.back", "Back"), onClick: () => void back() } : undefined} actions={<><span className="btn-badge">{t("common.alpha", "Alpha")}</span><ViewActionButton kind="create" label={t("whiteboard.new", "New whiteboard")} disabled={!projectId || boards.saving} onClick={() => void boards.create()} /></>} />}
      sidebar={sidebar}
      mobilePane={boards.selected ? "detail" : "list"}
      contentOwnsScroll
    >{detail}</ViewLayout>
  </section>;
}
