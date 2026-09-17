import "./NotesView.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectNoteSummary } from "@fusion/core";
import { RefreshCw, Search, StickyNote } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../hooks/useConfirm";
import { useNotes, type UseNotesController } from "../hooks/useNotes";
import { useViewportMode } from "../hooks/useViewportMode";
import { FileEditor } from "./FileEditor";
import { ViewActionButton } from "./ViewActionButton";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { ViewSidebar } from "./ViewSidebar";
import { FloatingWindow } from "./FloatingWindow";
import { useListItemContextMenu } from "../hooks/useListItemContextMenu";
import { ListItemContextMenu, type ListItemMenuAction } from "./ListItemContextMenu";

export interface NotesViewProps {
  projectId?: string;
  addToast?: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  controller?: UseNotesController;
  compact?: boolean;
  listOnly?: boolean;
  dedicatedNoteId?: string;
  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : instantané VIVANT de la note imposée, tenu à jour par le propriétaire des fenêtres détachées. Seule la
  fenêtre dédiée le reçoit ; la page standard et la liste `listOnly` du dock ne le passent jamais et restent inchangées.
  */
  dedicatedNote?: ProjectNoteSummary;
  onOpenNote?: (note: ProjectNoteSummary) => void;
  onChanged?: () => void;
  registerGuard?: (guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => () => void;
  floating?: { onClose: () => void; onActivate?: () => void; raiseToFrontSignal?: number; registerGuard?: (guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => () => void };
}

/*
FNXC:NotesEditing 2026-09-15-21:23:
FN-435 : contrepartie EXACTE du bouton Enregistrer supprimé. Toute frappe planifie une écriture après cette période
d'inactivité, et chaque navigation (changement de note, retour à la liste, fermeture de l'hôte, démontage) vide
l'anti-rebond avant de poursuivre. La CAS de révision de `useNotes` reste l'UNIQUE protection contre l'écrasement
concurrent : l'anti-rebond ne fait que choisir le moment de l'écriture, jamais sa sécurité.
*/
const NOTES_AUTOSAVE_DEBOUNCE_MS = 800;

/*
FNXC:ProjectNotes 2026-09-12-04:06:
NotesView conserve un seul formulaire partagé avec trois frontières explicites : la page standard garde liste + détail, le dock de droite monte uniquement la liste, et une fenêtre dédiée monte uniquement l’éditeur de la note imposée. Chaque fenêtre dédiée possède son propre useNotes afin que brouillon, conflit, sauvegarde et confirmation de fermeture restent indépendants.

FNXC:NotesEditing 2026-09-15-21:23:
FN-435 : la surface d'ÉDITION ne contient plus que le contenu. Champ titre, Enregistrer, Supprimer et la barre
d'outils de `FileEditor` (Modifier, Aperçu, Annuler, Rétablir, Retour à la ligne) sont retirés ; le renommage et la
suppression vivent dans le menu par ligne de la liste, comme pour une conversation. Les contrôles de RÉCUPÉRATION
(Recharger, Écraser, Réessayer) sont délibérément conservés : sans eux un conflit de révision 409 rendrait la note
irrécupérable et la perte de données serait silencieuse.
*/
export function NotesView({ projectId, addToast, controller, compact = false, listOnly = false, dedicatedNoteId, dedicatedNote, onOpenNote, onChanged, registerGuard, floating }: NotesViewProps) {
  const { t } = useTranslation("app");
  const confirm = useConfirm();
  const ownedNotes = useNotes(controller ? undefined : projectId);
  const notes = controller ?? ownedNotes;
  const viewportMode = useViewportMode();
  const dedicated = Boolean(dedicatedNoteId);
  const dedicatedSelectionRef = useRef<string | null>(null);
  const adoptedRevisionRef = useRef<number | null>(null);
  /*
  FNXC:NotesRowActions 2026-09-17-03:18:
  FN-486 : la ligne de note n'expose plus de bouton « … ». Renommer et Supprimer s'ouvrent au clic droit, à la
  touche Menu ou par appui long, par le menu contextuel PARTAGÉ. Ouvrir ce menu ne sélectionne pas la note :
  aucune lecture, aucun brouillon écrasé, aucune vidange d'autosave déclenchée par le simple geste.
  */
  const rowMenu = useListItemContextMenu({ contextId: `${projectId ?? ""}:notes` });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 : même règle que `ChatView` — aucune affordance « Retour » n'est rendue tant que la liste et l'éditeur sont
  visibles CÔTE À CÔTE, parce qu'un retour vers un rail déjà visible ne navigue nulle part. Sur téléphone (drawer, page
  en pane unique) l'éditeur serait une impasse sans retour, donc l'en-tête partagé conserve alors cette seule
  affordance ; jamais un bouton « Retour » dans la barre d'édition, qui n'existe plus.
  */
  const listRailVisible = !dedicated && !listOnly && viewportMode !== "mobile";

  useEffect(() => {
    const identity = dedicatedNoteId ? `${projectId ?? ""}:${dedicatedNoteId}` : null;
    if (!identity || dedicatedSelectionRef.current === identity) return;
    dedicatedSelectionRef.current = identity;
    void notes.select(dedicatedNoteId!);
  }, [dedicatedNoteId, notes.select, projectId]);

  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : un renommage effectué ailleurs atteint la fenêtre en place. Cet effet est délibérément distinct du garde de
  première sélection ci-dessus : il n’adopte la révision externe que si elle est STRICTEMENT plus récente que la
  révision chargée et que la fenêtre n’a pas de brouillon sale, car un brouillon en cours ne doit jamais être écrasé
  par une version venue d’ailleurs. L’adoption passe par `notes.select` afin que `selected.revision` reste aligné avec
  la CAS d’enregistrement, et la dernière révision tentée est mémorisée pour qu’une lecture qui ne la publie pas (note
  supprimée, erreur réseau) ne déclenche pas de boucle de re-sélection.
  */
  useEffect(() => {
    if (!dedicated || !dedicatedNote || dedicatedNote.id !== dedicatedNoteId) return;
    const selected = notes.selected;
    if (!selected || selected.id !== dedicatedNote.id) return;
    if (notes.dirty || dedicatedNote.revision <= selected.revision) return;
    if (adoptedRevisionRef.current === dedicatedNote.revision) return;
    adoptedRevisionRef.current = dedicatedNote.revision;
    void notes.select(dedicatedNote.id);
  }, [dedicated, dedicatedNote, dedicatedNoteId, notes.dirty, notes.select, notes.selected]);

  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 : l'anti-rebond est piloté par une référence vers `saveIfDirty`, car la fonction change d'identité à chaque
  rendu alors que la minuterie planifiée, elle, doit survivre aux rendus intermédiaires.
  */
  const saveIfDirtyRef = useRef(notes.saveIfDirty);
  saveIfDirtyRef.current = notes.saveIfDirty;
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelScheduledSave = useCallback(() => {
    if (autosaveTimerRef.current === null) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);
  /** Vidange obligatoire avant toute navigation : la frappe en attente est écrite avant que la note change ou disparaisse. */
  const flushAutosave = useCallback(async () => {
    cancelScheduledSave();
    await saveIfDirtyRef.current();
  }, [cancelScheduledSave]);
  const handleContentChange = useCallback((value: string) => {
    notes.setDraftContent(value);
    cancelScheduledSave();
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveIfDirtyRef.current();
    }, NOTES_AUTOSAVE_DEBOUNCE_MS);
  }, [cancelScheduledSave, notes.setDraftContent]);
  useEffect(() => () => {
    if (autosaveTimerRef.current === null) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    void saveIfDirtyRef.current();
  }, []);

  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 : la garde de fermeture ne demande plus « Abandonner les modifications ? » pour un brouillon simplement non
  encore écrit — il est désormais enregistré tout seul. Elle ne confirme QUE les deux états qu'aucune automatisation ne
  peut résoudre : un conflit de révision et un échec d'enregistrement. Dans ces deux cas seuls le brouillon local
  serait réellement perdu.
  */
  const abandon = useCallback(async () => {
    const unrecoverable = notes.dirty && (notes.conflict || notes.errorOperation === "save");
    if (!unrecoverable) return true;
    return confirm.confirm({ title: t("notes.discardTitle", "Discard changes?"), message: t("notes.discardMessage", "Your unsaved draft will be lost."), confirmLabel: t("notes.discard", "Discard"), danger: true });
  }, [confirm, notes.conflict, notes.dirty, notes.errorOperation, t]);
  const commitFloatingClose = useCallback(() => { if (notes.dirty) notes.clearSelection(); }, [notes]);
  useEffect(() => (registerGuard ?? floating?.registerGuard)?.(abandon, commitFloatingClose), [abandon, commitFloatingClose, floating, registerGuard]);
  const requestFloatingClose = useCallback(async () => {
    await flushAutosave();
    if (!await abandon()) return;
    commitFloatingClose();
    floating?.onClose();
  }, [abandon, commitFloatingClose, flushAutosave, floating]);

  const handleCreate = async () => {
    await flushAutosave();
    if (!await abandon()) return;
    const created = await notes.create();
    if (created && listOnly) onOpenNote?.(created);
  };
  const activeNoteId = notes.pendingSelectedId ?? notes.selected?.id;
  /*
  FNXC:ProjectNotes 2026-09-16-05:02:
  FN-454 : l'identité AFFICHÉE vient exclusivement de la note `selected` confirmée. Tant qu'une lecture est en cours pour
  une AUTRE note, l'ancienne sélection ne doit être présentée ni comme la cible ni comme son contenu : l'opérateur
  croirait autrement éditer la note demandée alors que toute frappe irait dans la précédente. Le détail affiche donc un
  état de chargement, jamais l'éditeur périmé. La ligne de liste garde `notes-list-item--selected` et
  `aria-current="page"` sur la cible en attente, seul retour de sélection immédiat exigé par FN-404.
  */
  const pendingSelection = Boolean(notes.pendingSelectedId && notes.pendingSelectedId !== notes.selected?.id);
  const confirmedNote = pendingSelection ? null : notes.selected;
  const confirmedNoteTitle = confirmedNote?.title?.trim() ? confirmedNote.title : null;
  const detailPaneActive = dedicated || pendingSelection || Boolean(notes.selected);
  const handleSelect = async (id: string) => {
    if (listOnly) {
      const note = notes.notes.find((candidate) => candidate.id === id);
      if (note) onOpenNote?.(note);
      return;
    }
    if (id === activeNoteId) return;
    /*
    FNXC:NotesEditing 2026-09-15-21:23:
    FN-435 : la vidange n'est attendue QUE lorsqu'il y a réellement un brouillon à écrire. Attendre inconditionnellement
    diffèrerait `select` d'une micro-tâche et retarderait la publication immédiate de `pendingSelectedId`, qui est le
    retour de sélection instantané exigé par FN-404.
    */
    cancelScheduledSave();
    if (notes.dirty) {
      await flushAutosave();
      if (!await abandon()) return;
    }
    await notes.select(id);
  };
  const handleBackToList = async () => {
    cancelScheduledSave();
    if (notes.dirty) {
      await flushAutosave();
      if (!await abandon()) return;
    }
    notes.clearSelection();
  };
  const handleRetry = async () => {
    if (notes.failedSelectionId) await handleSelect(notes.failedSelectionId);
    else if (notes.errorOperation === "save") await notes.save();
  };

  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 : le renommage se fait EN PLACE dans la ligne de liste, et non par le dialogue modal qu'utilise le chat. La
  liste Notes est hébergée par une popover et par un drawer téléphone, deux surfaces déjà modales : y superposer un
  dialogue créerait une seconde couche modale par-dessus la première, que l'opérateur devrait fermer deux fois.
  */
  const startRename = (note: ProjectNoteSummary) => {
    setRenamingId(note.id);
    setRenameDraft(note.title);
  };
  const cancelRename = () => { setRenamingId(null); setRenameDraft(""); };
  const commitRename = async (id: string) => {
    const title = renameDraft.trim();
    const current = notes.notes.find((candidate) => candidate.id === id);
    cancelRename();
    if (!title || !current || title === current.title) return;
    await notes.renameNote(id, title);
    onChanged?.();
  };
  const handleDeleteNote = async (note: ProjectNoteSummary) => {
    if (!await confirm.confirm({ title: t("notes.deleteTitle", "Delete note?"), message: t("notes.deleteMessage", "This action cannot be undone."), confirmLabel: t("common.delete", "Delete"), danger: true })) return;
    if (note.id === notes.selected?.id) cancelScheduledSave();
    if (!await notes.removeNote(note.id)) return;
    addToast?.(t("notes.deleted", "Note deleted"), "success");
    onChanged?.();
    if (dedicatedNoteId === note.id || (floating && note.id === notes.selected?.id)) floating?.onClose();
  };

  /* La cible du menu est résolue à chaque rendu dans les données COURANTES : une note retirée par un
     rafraîchissement ferme son menu au lieu d'exposer une action sur un objet périmé. */
  const menuNote = rowMenu.anchor ? notes.notes.find((candidate) => `note:${candidate.id}` === rowMenu.anchor?.key) ?? null : null;
  useEffect(() => {
    if (rowMenu.anchor && !menuNote) rowMenu.close();
  }, [menuNote, rowMenu]);
  const menuActions: ListItemMenuAction[] = menuNote ? [
    { id: "rename", label: t("notes.rename", "Rename"), testId: "notes-menu-rename", onSelect: () => startRename(menuNote) },
    { id: "delete", label: t("common.delete", "Delete"), tone: "danger", testId: "notes-menu-delete", onSelect: () => void handleDeleteNote(menuNote) },
  ] : [];

  const list = <div className="notes-list">
    <div className="notes-search">
      <label className="search-field">
        <Search className="search-field-icon" size={14} aria-hidden="true" />
        <input className="search-field-input" type="search" value={notes.search} aria-label={t("notes.search", "Search notes")} placeholder={t("notes.search", "Search notes")} onChange={(event) => notes.setSearch(event.target.value)} />
      </label>
    </div>
    {notes.loading && !notes.notes.length ? <p className="notes-state">{t("common.loading", "Loading…")}</p> : null}
    {notes.error && !notes.selected ? <div className="notes-state" role="alert"><p>{notes.error}</p><button className="btn" type="button" onClick={() => void notes.loadList(notes.search)}>{t("common.retry", "Retry")}</button></div> : null}
    {!notes.loading && !notes.error && !notes.notes.length ? <div className="notes-state"><p>{notes.search ? t("notes.noResults", "No notes found") : t("notes.empty", "No notes yet")}</p></div> : null}
    <div className="notes-list-items">{notes.notes.map((note) => {
      const isSelected = !listOnly && note.id === activeNoteId;
      const isRenaming = renamingId === note.id;
      return <div key={note.id} className={`notes-list-item${isSelected ? " notes-list-item--selected" : ""}`}>
        {isRenaming
          ? <input
            className="input notes-list-item-rename"
            data-testid="notes-list-item-rename-input"
            aria-label={t("notes.renameAria", "Rename {{title}}", { title: note.title })}
            maxLength={200}
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => void commitRename(note.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void commitRename(note.id); }
              else if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
            }}
          />
          : <button type="button" className="notes-list-item-select" data-testid="notes-list-item-context-row" aria-current={isSelected ? "page" : undefined} {...rowMenu.getRowProps(`note:${note.id}`)} onClick={() => void handleSelect(note.id)}><strong>{note.title}</strong><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString()}</time></button>}
      </div>;
    })}</div>
    <ListItemContextMenu
      anchor={rowMenu.anchor}
      ariaLabel={t("notes.actionsAria", "Note actions for {{title}}", { title: menuNote?.title ?? "" })}
      actions={menuActions}
      onClose={rowMenu.close}
      data-testid="notes-list-item-context-menu"
    />
  </div>;

  const detail = <main className="notes-detail">
    {pendingSelection ? <div className="notes-state notes-detail-empty" data-testid="notes-detail-pending"><StickyNote aria-hidden="true" /><p>{t("common.loading", "Loading\u2026")}</p></div> : confirmedNote ? <>
      {notes.conflict ? <div className="notes-conflict" role="alert"><p>{t("notes.conflict", "This note changed elsewhere. Your draft is preserved.")}</p><button className="btn" type="button" onClick={() => void notes.reload()}><RefreshCw aria-hidden="true" />{t("notes.reload", "Reload server version")}</button><button className="btn btn-primary" type="button" onClick={() => void notes.overwrite()}>{t("notes.overwrite", "Overwrite with my draft")}</button></div> : null}
      {notes.error && !notes.conflict ? <div className="notes-error" role="alert">{notes.error}{notes.failedSelectionId || notes.errorOperation === "save" ? <button className="btn" type="button" onClick={() => void handleRetry()}>{t("common.retry", "Retry")}</button> : null}</div> : null}
      <div className="notes-editor"><FileEditor content={notes.draftContent} onChange={handleContentChange} filePath={`${confirmedNote.id}.md`} hideToolbar /></div>
    </> : notes.error && notes.failedSelectionId ? <div className="notes-state notes-detail-empty" role="alert"><p>{notes.error}</p><button className="btn" type="button" onClick={() => void handleRetry()}>{t("common.retry", "Retry")}</button></div> : <div className="notes-state notes-detail-empty"><StickyNote aria-hidden="true" /><p>{notes.loading ? t("common.loading", "Loading…") : t("notes.select", "Select a note or create a new one")}</p></div>}
  </main>;

  /*
  FNXC:NotesCollectionLayout 2026-09-13-16:29:
  The standard Notes destination composes its existing controller through the shared rail and detail shell. Dedicated note windows remain detail-only and keep their independent dirty guard, draft, conflict, save, and floating-window lifecycle.
  */
  const saveIndicator = confirmedNote
    ? <span className="notes-save-state" data-testid="notes-save-state" aria-live="polite" title={t("notes.autoSaved", "Changes are saved automatically")}>{notes.saving ? t("notes.saving", "Saving…") : t("notes.savedState", "Saved")}</span>
    : null;
  const createAction = !dedicated ? <ViewActionButton kind="create" label={t("notes.new", "New note")} onClick={() => void handleCreate()} disabled={!projectId || notes.saving} /> : null;
  const header = <ViewHeader
    icon={StickyNote}
    title={confirmedNoteTitle ?? t("nav.notes", "Notes")}
    onClose={floating ? requestFloatingClose : undefined}
    backAction={!dedicated && detailPaneActive && !listRailVisible ? { label: t("notes.backToList", "Back to notes"), onClick: () => void handleBackToList(), "data-testid": "notes-back-btn" } : undefined}
    actions={saveIndicator || createAction ? <>{saveIndicator}{createAction}</> : undefined}
  />;
  const content = <section className={`notes-view${floating ? " notes-view--floating" : ""}${compact ? " notes-view--compact" : ""}${listOnly ? " notes-view--list-only" : ""}${dedicated ? " notes-view--dedicated" : ""}${detailPaneActive ? " notes-view--detail" : ""}`} aria-label={t("nav.notes", "Notes")}>
    <ViewLayout
      header={header}
      sidebar={!dedicated ? <ViewSidebar ariaLabel={t("notes.list", "Notes list")} resizable={!compact}>{list}</ViewSidebar> : undefined}
      mobilePane={detailPaneActive ? "detail" : "list"}
      contentOwnsScroll={!listOnly}
    >
      {!listOnly ? detail : <div />}
    </ViewLayout>
  </section>;
  if (!floating) return content;
  return <FloatingWindow title={confirmedNoteTitle ?? t("nav.notes", "Notes")} ariaLabel={confirmedNoteTitle ?? t("nav.notes", "Notes")} onClose={() => void requestFloatingClose()} windowKey={dedicatedNoteId ? `note-${projectId}-${dedicatedNoteId}` : "notes-view"} hideHeader dragHandleSelector=".view-header" minSize={{ width: 360, height: 280 }} raiseToFrontSignal={floating.raiseToFrontSignal}><div onPointerDown={floating.onActivate} onFocusCapture={floating.onActivate}>{content}</div></FloatingWindow>;
}
