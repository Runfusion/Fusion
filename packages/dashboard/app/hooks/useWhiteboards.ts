import { useCallback, useEffect, useRef, useState } from "react";
import type { WhiteboardDocument } from "@fusion/core";
import { ApiRequestError } from "../api/client/client";
import {
  createWhiteboard,
  deleteWhiteboard,
  fetchWhiteboard,
  fetchWhiteboardRevisions,
  fetchWhiteboards,
  renameWhiteboard,
  restoreWhiteboardRevision,
  saveWhiteboard,
  type Whiteboard,
  type WhiteboardRevision,
  type WhiteboardSummary,
} from "../api/whiteboards";

export interface WhiteboardsState {
  whiteboards: WhiteboardSummary[];
  selected: Whiteboard | null;
  pendingSelectedId: string | null;
  draftTitle: string;
  draftDocument: WhiteboardDocument | null;
  revisions: WhiteboardRevision[];
  search: string;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  error: string | null;
}

const initialState: WhiteboardsState = {
  whiteboards: [], selected: null, pendingSelectedId: null, draftTitle: "", draftDocument: null,
  revisions: [], search: "", loading: false, saving: false, dirty: false, conflict: false, error: null,
};

/*
FNXC:WhiteboardClientConcurrency 2026-09-10-05:53:
Whiteboard responses are authoritative only for the project, selection, and request incarnation that started them. Project changes clear visible data synchronously, document mutations run serially, and late reads or saves cannot replace a newer selection or draft.

FNXC:WhiteboardClientConcurrency 2026-09-10-07:17:
Queued mutation intents resolve their expected revision only when execution starts. Every accepted server response updates a synchronous per-document revision ledger before the next intent runs, preventing serialized save, rename, restore, or delete operations from issuing stale CAS revisions.

FNXC:WhiteboardConflictRecovery 2026-09-10-05:53:
A failed CAS keeps the exact local document and offers only remote reload or copy creation. The client never fetches a fresh revision and silently retries an overwrite because that would bypass the durable optimistic-concurrency contract.
*/
export function useWhiteboards(projectId?: string) {
  const [state, setState] = useState<WhiteboardsState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const projectGeneration = useRef(0);
  const listRequest = useRef(0);
  const selectionRequest = useRef(0);
  const revisionsRequest = useRef(0);
  const mutationRequest = useRef(0);
  const draftGeneration = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const authoritativeRevisions = useRef(new Map<string, number>());

  const rememberAuthoritative = useCallback((whiteboard: Whiteboard) => {
    authoritativeRevisions.current.set(whiteboard.id, whiteboard.revision);
  }, []);
  const expectedRevisionFor = useCallback((id: string, fallback: number) => {
    return authoritativeRevisions.current.get(id) ?? (stateRef.current.selected?.id === id ? stateRef.current.selected.revision : fallback);
  }, []);

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const loadList = useCallback(async (search = "") => {
    if (!projectId) return;
    const project = projectGeneration.current;
    const request = ++listRequest.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetchWhiteboards(projectId, search);
      if (activeProject.current === projectId && projectGeneration.current === project && listRequest.current === request) {
        setState((current) => ({ ...current, whiteboards: response.whiteboards, loading: false }));
      }
    } catch (error) {
      if (activeProject.current === projectId && projectGeneration.current === project && listRequest.current === request) {
        setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Unable to load whiteboards" }));
      }
    }
  }, [projectId]);

  useEffect(() => {
    projectGeneration.current += 1;
    listRequest.current += 1;
    selectionRequest.current += 1;
    revisionsRequest.current += 1;
    mutationRequest.current += 1;
    draftGeneration.current += 1;
    queue.current = Promise.resolve();
    authoritativeRevisions.current.clear();
    setState({ ...initialState, loading: Boolean(projectId) });
    if (projectId) void loadList();
  }, [projectId, loadList]);

  const select = useCallback(async (id: string) => {
    if (!projectId) return null;
    const project = projectGeneration.current;
    const request = ++selectionRequest.current;
    revisionsRequest.current += 1;
    setState((current) => ({ ...current, pendingSelectedId: id, revisions: [], loading: true, error: null }));
    try {
      const whiteboard = await fetchWhiteboard(projectId, id);
      if (activeProject.current !== projectId || projectGeneration.current !== project || selectionRequest.current !== request) return null;
      draftGeneration.current += 1;
      rememberAuthoritative(whiteboard);
      setState((current) => ({ ...current, selected: whiteboard, pendingSelectedId: null, draftTitle: whiteboard.title, draftDocument: whiteboard.document, revisions: [], loading: false, dirty: false, conflict: false, error: null }));
      return whiteboard;
    } catch (error) {
      if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === request) {
        setState((current) => ({ ...current, pendingSelectedId: null, loading: false, error: error instanceof Error ? error.message : "Unable to load whiteboard" }));
      }
      return null;
    }
  }, [projectId, rememberAuthoritative]);

  const clearSelection = useCallback(() => {
    selectionRequest.current += 1;
    revisionsRequest.current += 1;
    draftGeneration.current += 1;
    setState((current) => ({ ...current, selected: null, pendingSelectedId: null, draftTitle: "", draftDocument: null, revisions: [], dirty: false, conflict: false, error: null }));
  }, []);
  const setSearch = useCallback((search: string) => { setState((current) => ({ ...current, search })); void loadList(search); }, [loadList]);
  const setDraftTitle = useCallback((draftTitle: string) => { draftGeneration.current += 1; setState((current) => ({ ...current, draftTitle, dirty: draftTitle !== current.selected?.title || current.draftDocument !== current.selected?.document })); }, []);
  const setDraftDocument = useCallback((draftDocument: WhiteboardDocument) => { draftGeneration.current += 1; setState((current) => ({ ...current, draftDocument, dirty: draftDocument !== current.selected?.document || current.draftTitle !== current.selected?.title })); }, []);

  const create = useCallback((title = "Nouveau tableau", document?: WhiteboardDocument) => {
    if (!projectId) return Promise.resolve(null);
    const project = projectGeneration.current;
    const request = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId || projectGeneration.current !== project) return null;
      setState((current) => ({ ...current, saving: true, error: null }));
      try {
        const whiteboard = await createWhiteboard(projectId, title, document);
        if (activeProject.current !== projectId || projectGeneration.current !== project) return null;
        selectionRequest.current += 1;
        revisionsRequest.current += 1;
        draftGeneration.current += 1;
        rememberAuthoritative(whiteboard);
        setState((current) => ({ ...current, saving: mutationRequest.current === request ? false : current.saving, whiteboards: [whiteboard, ...current.whiteboards.filter((item) => item.id !== whiteboard.id)], selected: whiteboard, pendingSelectedId: null, draftTitle: whiteboard.title, draftDocument: whiteboard.document, revisions: [], dirty: false, conflict: false, error: null }));
        return whiteboard;
      } catch (error) {
        if (activeProject.current === projectId && projectGeneration.current === project) setState((current) => ({ ...current, saving: mutationRequest.current === request ? false : current.saving, error: error instanceof Error ? error.message : "Unable to create whiteboard" }));
        return null;
      }
    });
  }, [enqueue, projectId, rememberAuthoritative]);

  const save = useCallback(() => {
    const snapshot = stateRef.current;
    if (!projectId || !snapshot.selected || !snapshot.draftDocument) return Promise.resolve(null);
    const selected = snapshot.selected;
    const document = snapshot.draftDocument;
    const project = projectGeneration.current;
    const selection = selectionRequest.current;
    const draft = draftGeneration.current;
    const request = ++mutationRequest.current;
    return enqueue(async () => {
      if (activeProject.current !== projectId || projectGeneration.current !== project) return null;
      setState((current) => ({ ...current, saving: true, conflict: false, error: null }));
      try {
        const whiteboard = await saveWhiteboard(projectId, selected.id, document, expectedRevisionFor(selected.id, selected.revision));
        if (activeProject.current !== projectId || projectGeneration.current !== project) return null;
        rememberAuthoritative(whiteboard);
        setState((current) => {
          const ownsSelection = selectionRequest.current === selection && current.selected?.id === selected.id;
          const ownsDraft = ownsSelection && draftGeneration.current === draft;
          return { ...current, saving: mutationRequest.current === request ? false : current.saving, whiteboards: [whiteboard, ...current.whiteboards.filter((item) => item.id !== whiteboard.id)], ...(ownsSelection ? { selected: whiteboard } : {}), ...(ownsDraft ? { draftTitle: whiteboard.title, draftDocument: whiteboard.document, dirty: false, conflict: false } : {}), error: ownsSelection ? null : current.error };
        });
        return whiteboard;
      } catch (error) {
        if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection) {
          setState((current) => ({ ...current, saving: mutationRequest.current === request ? false : current.saving, error: error instanceof Error ? error.message : "Unable to save whiteboard", conflict: error instanceof ApiRequestError && error.status === 409, dirty: true }));
        }
        return null;
      }
    });
  }, [enqueue, expectedRevisionFor, projectId, rememberAuthoritative]);

  const rename = useCallback((title = stateRef.current.draftTitle) => {
    const selected = stateRef.current.selected;
    if (!projectId || !selected) return Promise.resolve(null);
    const project = projectGeneration.current;
    const selection = selectionRequest.current;
    return enqueue(async () => {
      try {
        const whiteboard = await renameWhiteboard(projectId, selected.id, title, expectedRevisionFor(selected.id, selected.revision));
        if (activeProject.current !== projectId || projectGeneration.current !== project || selectionRequest.current !== selection) return null;
        rememberAuthoritative(whiteboard);
        draftGeneration.current += 1;
        setState((current) => ({ ...current, selected: whiteboard, draftTitle: whiteboard.title, whiteboards: [whiteboard, ...current.whiteboards.filter((item) => item.id !== whiteboard.id)], dirty: current.draftDocument !== whiteboard.document, conflict: false, error: null }));
        return whiteboard;
      } catch (error) {
        if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Unable to rename whiteboard", conflict: error instanceof ApiRequestError && error.status === 409 }));
        return null;
      }
    });
  }, [enqueue, expectedRevisionFor, projectId, rememberAuthoritative]);

  const reloadRemote = useCallback(async () => {
    const selected = stateRef.current.selected;
    return selected ? select(selected.id) : null;
  }, [select]);

  const createConflictCopy = useCallback((title?: string) => {
    const current = stateRef.current;
    if (!current.draftDocument) return Promise.resolve(null);
    return create(title ?? `${current.draftTitle || "Whiteboard"} (copy)`, current.draftDocument);
  }, [create]);

  const loadRevisions = useCallback(async () => {
    const selected = stateRef.current.selected;
    if (!projectId || !selected) return [];
    const project = projectGeneration.current;
    const selection = selectionRequest.current;
    const request = ++revisionsRequest.current;
    try {
      const response = await fetchWhiteboardRevisions(projectId, selected.id);
      if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection && revisionsRequest.current === request) setState((current) => ({ ...current, revisions: response.revisions, error: null }));
      return response.revisions;
    } catch (error) {
      if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection && revisionsRequest.current === request) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Unable to load revisions" }));
      return [];
    }
  }, [projectId]);

  const restore = useCallback((revision: number) => {
    const selected = stateRef.current.selected;
    if (!projectId || !selected) return Promise.resolve(null);
    const project = projectGeneration.current;
    const selection = selectionRequest.current;
    return enqueue(async () => {
      try {
        const whiteboard = await restoreWhiteboardRevision(projectId, selected.id, revision, expectedRevisionFor(selected.id, selected.revision));
        if (activeProject.current !== projectId || projectGeneration.current !== project || selectionRequest.current !== selection) return null;
        rememberAuthoritative(whiteboard);
        draftGeneration.current += 1;
        setState((current) => ({ ...current, selected: whiteboard, draftTitle: whiteboard.title, draftDocument: whiteboard.document, whiteboards: [whiteboard, ...current.whiteboards.filter((item) => item.id !== whiteboard.id)], dirty: false, conflict: false, error: null }));
        return whiteboard;
      } catch (error) {
        if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Unable to restore revision", conflict: error instanceof ApiRequestError && error.status === 409 }));
        return null;
      }
    });
  }, [enqueue, expectedRevisionFor, projectId, rememberAuthoritative]);

  const remove = useCallback(() => {
    const selected = stateRef.current.selected;
    if (!projectId || !selected) return Promise.resolve(false);
    const project = projectGeneration.current;
    const selection = selectionRequest.current;
    return enqueue(async () => {
      try {
        await deleteWhiteboard(projectId, selected.id, expectedRevisionFor(selected.id, selected.revision));
        if (activeProject.current !== projectId || projectGeneration.current !== project) return false;
        authoritativeRevisions.current.delete(selected.id);
        setState((current) => ({ ...current, whiteboards: current.whiteboards.filter((item) => item.id !== selected.id), ...(selectionRequest.current === selection && current.selected?.id === selected.id ? { selected: null, draftTitle: "", draftDocument: null, revisions: [], dirty: false, conflict: false } : {}), error: null }));
        return true;
      } catch (error) {
        if (activeProject.current === projectId && projectGeneration.current === project && selectionRequest.current === selection) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Unable to delete whiteboard", conflict: error instanceof ApiRequestError && error.status === 409 }));
        return false;
      }
    });
  }, [enqueue, expectedRevisionFor, projectId]);

  return { ...state, loadList, select, clearSelection, setSearch, setDraftTitle, setDraftDocument, create, save, rename, reloadRemote, createConflictCopy, loadRevisions, restore, remove };
}
