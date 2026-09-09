import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectNote, ProjectNoteSummary } from "@fusion/core";
import { ApiRequestError } from "../api/client/client";
import { createNote, deleteNote, fetchNote, fetchNotes, updateNote } from "../api/notes";

export interface NotesState {
  notes: ProjectNoteSummary[];
  selected: ProjectNote | null;
  draftTitle: string;
  draftContent: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
  dirty: boolean;
  search: string;
}

/*
FNXC:ProjectNotes 2026-09-09-17:52:
A project switch invalidates every list/detail response and clears visible note data immediately. Mutations are serialized and fenced by project, note selection, and request identity; a late save updates its list summary but cannot replace another selected note or mark newer local text as saved. Revision and network failures retain the exact local draft until the user explicitly reloads, retries, or overwrites it.
*/
export function useNotes(projectId?: string) {
  const [state, setState] = useState<NotesState>({ notes: [], selected: null, draftTitle: "", draftContent: "", loading: false, saving: false, error: null, conflict: false, dirty: false, search: "" });
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const mutationRequest = useRef(0);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const mutation = useRef<Promise<unknown>>(Promise.resolve());

  const loadList = useCallback(async (search = "") => {
    if (!projectId) return;
    const request = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await fetchNotes(projectId, search);
      if (request === generation.current) setState((s) => ({ ...s, notes: result.notes, loading: false }));
    } catch (error) {
      if (request === generation.current) setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : "Unable to load notes" }));
    }
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    selectionGeneration.current += 1;
    mutationRequest.current += 1;
    setState({ notes: [], selected: null, draftTitle: "", draftContent: "", loading: Boolean(projectId), saving: false, error: null, conflict: false, dirty: false, search: "" });
    if (projectId) void loadList();
  }, [projectId, loadList]);

  const select = useCallback(async (id: string) => {
    if (!projectId) return;
    selectionGeneration.current += 1;
    const request = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const note = await fetchNote(projectId, id);
      if (request === generation.current) setState((s) => ({ ...s, selected: note, draftTitle: note.title, draftContent: note.content, loading: false, dirty: false, conflict: false }));
    } catch (error) { if (request === generation.current) setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : "Unable to load note" })); }
  }, [projectId]);

  const clearSelection = useCallback(() => { generation.current += 1; selectionGeneration.current += 1; setState((s) => ({ ...s, selected: null, draftTitle: "", draftContent: "", dirty: false, conflict: false, error: null })); }, []);
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
      setState((s) => ({ ...s, saving: true, error: null }));
      try {
        const note = await createNote(projectId, { title: "Nouvelle note", content: "" });
        if (activeProject.current !== projectId) return null;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: [note, ...s.notes.filter((summary) => summary.id !== note.id)],
            ...(ownsSelection ? { selected: note, draftTitle: note.title, draftContent: note.content, dirty: false, conflict: false } : {}),
          };
        });
        return note;
      } catch (error) {
        if (activeProject.current !== projectId) return null;
        setState((s) => mutationRequest.current === requestId && selectionGeneration.current === selectedGeneration
          ? { ...s, saving: false, error: error instanceof Error ? error.message : "Unable to create note" }
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
      setState((s) => ({ ...s, saving: true, error: null, conflict: false }));
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
      setState((s) => ({ ...s, saving: true, error: null }));
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
            ...(ownsSelection ? { conflict: error instanceof ApiRequestError && error.status === 409, error: error instanceof Error ? error.message : "Unable to overwrite note", dirty: true } : {}),
          };
        });
        return null;
      }
    });
  }, [enqueue, projectId, state]);

  const remove = useCallback(() => {
    if (!projectId || !state.selected) return Promise.resolve(false);
    const selected = state.selected;
    const selectedGeneration = selectionGeneration.current;
    const requestId = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId) return false;
      setState((s) => ({ ...s, saving: true, error: null }));
      try {
        await deleteNote(projectId, selected.id, selected.revision);
        if (activeProject.current !== projectId) return false;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            notes: s.notes.filter((summary) => summary.id !== selected.id),
            ...(ownsSelection ? { selected: null, draftTitle: "", draftContent: "", dirty: false, conflict: false } : {}),
          };
        });
        return true;
      } catch (error) {
        if (activeProject.current !== projectId) return false;
        setState((s) => {
          const ownsRequest = mutationRequest.current === requestId;
          const ownsSelection = selectionGeneration.current === selectedGeneration && s.selected?.id === selected.id;
          if (!ownsRequest && !ownsSelection) return s;
          return {
            ...s,
            ...(ownsRequest ? { saving: false } : {}),
            ...(ownsSelection ? { error: error instanceof Error ? error.message : "Unable to delete note", conflict: error instanceof ApiRequestError && error.status === 409 } : {}),
          };
        });
        return false;
      }
    });
  }, [enqueue, projectId, state.selected]);

  return { ...state, loadList, select, clearSelection, setSearch, setDraftTitle, setDraftContent, create, save, reload, overwrite, remove };
}
