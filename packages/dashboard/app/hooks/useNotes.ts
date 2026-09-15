import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectNote, ProjectNoteSummary } from "@fusion/core";
import { ApiRequestError } from "../api/client/client";
import { createNote, deleteNote, fetchNote, fetchNotes, updateNote } from "../api/notes";

export interface NotesState {
  notes: ProjectNoteSummary[];
  selected: ProjectNote | null;
  pendingSelectedId: string | null;
  failedSelectionId: string | null;
  draftTitle: string;
  draftContent: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  errorOperation: "selection" | "save" | "other" | null;
  conflict: boolean;
  dirty: boolean;
  search: string;
}

/*
FNXC:ProjectNotes 2026-09-09-17:52:
A project switch invalidates every list/detail response and clears visible note data immediately. Mutations are serialized and fenced by project, note selection, and request identity; a late save updates its list summary but cannot replace another selected note or mark newer local text as saved. Revision and network failures retain the exact local draft until the user explicitly reloads, retries, or overwrites it.

FNXC:ProjectNotes 2026-09-09-23:29:
A note click publishes its pending id before detail loading finishes so selection feedback is immediate. Only the latest selection request may promote or clear that pending id; stale resolutions and rejections preserve the newer selection, draft, loading state, and error state.

FNXC:ProjectNotes 2026-09-09-23:47:
Selection failures retain the attempted note id so Retry repeats the failed read instead of saving the previously loaded note. Other operations clear that provenance before publishing their own error.

FNXC:ProjectNotes 2026-09-09-23:47:
A newly created note takes ownership from the selection request that was current when creation started. It invalidates that in-flight read before publishing the new active note, while a selection started later remains authoritative.
*/
export type UseNotesController = ReturnType<typeof useNotes>;

export function useNotes(projectId?: string) {
  const [state, setState] = useState<NotesState>({ notes: [], selected: null, pendingSelectedId: null, failedSelectionId: null, draftTitle: "", draftContent: "", loading: false, saving: false, error: null, errorOperation: null, conflict: false, dirty: false, search: "" });
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const mutationRequest = useRef(0);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const mutation = useRef<Promise<unknown>>(Promise.resolve());

  const loadList = useCallback(async (search = "") => {
    if (!projectId) return;
    const request = ++generation.current;
    setState((s) => ({ ...s, loading: true, failedSelectionId: null, error: null, errorOperation: null }));
    try {
      const result = await fetchNotes(projectId, search);
      if (request === generation.current) setState((s) => ({ ...s, notes: result.notes, loading: false }));
    } catch (error) {
      if (request === generation.current) setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : "Unable to load notes", errorOperation: "other" }));
    }
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    selectionGeneration.current += 1;
    mutationRequest.current += 1;
    setState({ notes: [], selected: null, pendingSelectedId: null, failedSelectionId: null, draftTitle: "", draftContent: "", loading: Boolean(projectId), saving: false, error: null, errorOperation: null, conflict: false, dirty: false, search: "" });
    if (projectId) void loadList();
  }, [projectId, loadList]);

  const select = useCallback(async (id: string) => {
    if (!projectId) return;
    const selectionRequest = ++selectionGeneration.current;
    setState((s) => ({ ...s, pendingSelectedId: id, failedSelectionId: null, loading: true, error: null, errorOperation: null }));
    try {
      const note = await fetchNote(projectId, id);
      if (selectionRequest === selectionGeneration.current && activeProject.current === projectId) {
        setState((s) => ({ ...s, selected: note, pendingSelectedId: null, failedSelectionId: null, errorOperation: null, draftTitle: note.title, draftContent: note.content, loading: false, dirty: false, conflict: false }));
      }
    } catch (error) {
      if (selectionRequest === selectionGeneration.current && activeProject.current === projectId) {
        setState((s) => ({ ...s, pendingSelectedId: null, failedSelectionId: id, loading: false, error: error instanceof Error ? error.message : "Unable to load note", errorOperation: "selection" }));
      }
    }
  }, [projectId]);

  const clearSelection = useCallback(() => { generation.current += 1; selectionGeneration.current += 1; setState((s) => ({ ...s, selected: null, pendingSelectedId: null, failedSelectionId: null, draftTitle: "", draftContent: "", loading: false, dirty: false, conflict: false, error: null, errorOperation: null })); }, []);
  const setSearch = useCallback((search: string) => { setState((s) => ({ ...s, search })); void loadList(search); }, [loadList]);
  const setDraftTitle = useCallback((draftTitle: string) => setState((s) => ({ ...s, draftTitle, dirty: draftTitle !== s.selected?.title || s.draftContent !== s.selected?.content })), []);
  const setDraftContent = useCallback((draftContent: string) => setState((s) => ({ ...s, draftContent, dirty: draftContent !== s.selected?.content || s.draftTitle !== s.selected?.title })), []);

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = mutation.current.then(work, work); mutation.current = next.catch(() => undefined); return next;
  }, []);

  const create = useCallback(() => {
    if (!projectId) return Promise.resolve(null);
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return null;
      setState((s) => ({ ...s, saving: true, failedSelectionId: null, error: null, errorOperation: null }));
      try {
        const note = await createNote(projectId, { title: "Nouvelle note", content: "" });
        if (activeProject.current !== projectId) return null;
        const becomesSelection = selectionGeneration.current === selectedGeneration;
        if (becomesSelection) selectionGeneration.current += 1;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: [note, ...s.notes.filter((summary) => summary.id !== note.id)],
            ...(becomesSelection ? {
              selected: note,
              pendingSelectedId: null,
              failedSelectionId: null,
              draftTitle: note.title,
              draftContent: note.content,
              dirty: false,
              conflict: false,
            } : {}),
          };
        });
        return note;
      } catch (error) {
        if (activeProject.current !== projectId) return null;
        setState((s) => mutationRequest.current === requestId && selectionGeneration.current === selectedGeneration
          ? { ...s, saving: false, error: error instanceof Error ? error.message : "Unable to create note", errorOperation: "other" }
          : s);
        return null;
      }
    });
  }, [enqueue, projectId]);

  const save = useCallback(() => {
    if (!projectId || !state.selected) return Promise.resolve(null);
    const { selected, draftTitle, draftContent } = state;
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return null;
      setState((s) => ({ ...s, saving: true, failedSelectionId: null, error: null, errorOperation: null, conflict: false }));
      try {
        const note = await updateNote(projectId, selected.id, { title: draftTitle, content: draftContent, expectedRevision: selected.revision });
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: [note, ...s.notes.filter((summary) => summary.id !== note.id)],
            ...(ownsSelection ? {
              selected: note,
              conflict: false,
              error: null,
              errorOperation: null,
              dirty: s.draftTitle !== note.title || s.draftContent !== note.content,
            } : {}),
          };
        });
        return note;
      } catch (error) {
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          if (!ownsRequest && !ownsSelection) return s;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            ...(ownsSelection ? {
              error: error instanceof Error ? error.message : "Unable to save note",
              errorOperation: "save",
              conflict: error instanceof ApiRequestError && error.status === 409,
              dirty: true,
            } : {}),
          };
        });
        return null;
      }
    });
  }, [enqueue, projectId, state]);

  const reload = useCallback(async () => { if (state.selected) await select(state.selected.id); }, [select, state.selected]);
  const overwrite = useCallback(() => {
    if (!projectId || !state.selected) return Promise.resolve(null);
    const { selected, draftTitle, draftContent } = state;
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return null;
      setState((s) => ({ ...s, saving: true, failedSelectionId: null, error: null, errorOperation: null }));
      try {
        const latest = await fetchNote(projectId, selected.id);
        if (activeProject.current !== projectId) return null;
        const note = await updateNote(projectId, latest.id, { title: draftTitle, content: draftContent, expectedRevision: latest.revision });
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: [note, ...s.notes.filter((summary) => summary.id !== note.id)],
            ...(ownsSelection ? {
              selected: note,
              conflict: false,
              error: null,
              errorOperation: null,
              dirty: s.draftTitle !== note.title || s.draftContent !== note.content,
            } : {}),
          };
        });
        return note;
      } catch (error) {
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          if (!ownsRequest && !ownsSelection) return s;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            ...(ownsSelection ? { conflict: error instanceof ApiRequestError && error.status === 409, error: error instanceof Error ? error.message : "Unable to overwrite note", errorOperation: "other" as const, dirty: true } : {}),
          };
        });
        return null;
      }
    });
  }, [enqueue, projectId, state]);

  /*
  FNXC:ProjectNotes 2026-09-15-21:23:
  FN-435 : le renommage et la suppression sont désormais déclenchés depuis la LISTE, sur n'importe quelle ligne, alors
  que la liste et le détail partagent UN SEUL contrôleur dans la popover et le drawer. Invariant : une mutation
  déclenchée depuis la liste ne doit jamais altérer le brouillon d'une AUTRE note. Ces opérations résolvent donc leur
  révision par identifiant (résumé de liste, ou note sélectionnée quand c'est la même) et ne touchent `selected`,
  `draftTitle`, `draftContent` et `revision` que lorsque l'identifiant muté EST la sélection courante. Aligner
  `selected.revision` après un renommage de la note ouverte est obligatoire : sans cela l'enregistrement automatique
  suivant repartirait d'une révision périmée et échouerait en 409 immédiatement après chaque renommage.
  */
  const renameNote = useCallback((id: string, title: string) => {
    if (!projectId) return Promise.resolve(null as ProjectNoteSummary | null);
    const summary = state.notes.find((candidate) => candidate.id === id);
    const expectedRevision = state.selected?.id === id ? state.selected.revision : summary?.revision;
    if (expectedRevision === undefined) return Promise.resolve(null as ProjectNoteSummary | null);
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return null;
      setState((s) => ({ ...s, saving: true, failedSelectionId: null, error: null, errorOperation: null }));
      try {
        const note = await updateNote(projectId, id, { title, expectedRevision });
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === id;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: s.notes.map((candidate) => (candidate.id === id ? { ...candidate, ...note } : candidate)),
            ...(ownsSelection ? {
              selected: note,
              draftTitle: note.title,
              conflict: false,
              error: null,
              errorOperation: null,
              dirty: s.draftContent !== note.content,
            } : {}),
          };
        });
        return note;
      } catch (error) {
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          if (!ownsRequest && s.selected?.id !== id) return s;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            error: error instanceof Error ? error.message : "Unable to rename note",
            errorOperation: "other" as const,
            conflict: error instanceof ApiRequestError && error.status === 409,
          };
        });
        return null;
      }
    });
  }, [enqueue, projectId, state.notes, state.selected]);

  const removeNote = useCallback((id: string) => {
    if (!projectId) return Promise.resolve(false);
    const summary = state.notes.find((candidate) => candidate.id === id);
    const expectedRevision = state.selected?.id === id ? state.selected.revision : summary?.revision;
    if (expectedRevision === undefined) return Promise.resolve(false);
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return false;
      setState((s) => ({ ...s, saving: true, failedSelectionId: null, error: null, errorOperation: null }));
      try {
        await deleteNote(projectId, id, expectedRevision);
        if (activeProject.current !== projectId) return false;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === id;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: s.notes.filter((candidate) => candidate.id !== id),
            ...(ownsSelection ? { selected: null, draftTitle: "", draftContent: "", dirty: false, conflict: false } : {}),
          };
        });
        return true;
      } catch (error) {
        if (activeProject.current !== projectId) return false;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          if (!ownsRequest && s.selected?.id !== id) return s;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            error: error instanceof Error ? error.message : "Unable to delete note",
            errorOperation: "other" as const,
            conflict: error instanceof ApiRequestError && error.status === 409,
          };
        });
        return false;
      }
    });
  }, [enqueue, projectId, state.notes, state.selected]);

  /** Legacy selection-scoped delete, preserved for existing callers and reimplemented over `removeNote`. */
  const remove = useCallback(() => (state.selected ? removeNote(state.selected.id) : Promise.resolve(false)), [removeNote, state.selected]);

  /*
  FNXC:ProjectNotes 2026-09-15-21:23:
  FN-435 : point d'entrée UNIQUE de l'enregistrement automatique, qui remplace le bouton Enregistrer supprimé. Il porte
  seul la garde de non-répétition : une écriture déjà en vol, un conflit de révision non tranché ou un échec
  d'enregistrement précédent bloquent toute nouvelle tentative, sinon un anti-rebond qui se redéclenche transformerait
  un 409 en boucle d'écriture infinie et écraserait la décision Recharger/Écraser de l'opérateur.
  */
  const saveIfDirty = useCallback(() => {
    if (!state.dirty || state.saving || state.conflict || state.errorOperation === "save") return Promise.resolve(null as ProjectNote | null);
    return save();
  }, [save, state.conflict, state.dirty, state.errorOperation, state.saving]);

  return { ...state, loadList, select, clearSelection, setSearch, setDraftTitle, setDraftContent, create, save, saveIfDirty, reload, overwrite, remove, removeNote, renameNote };
}
