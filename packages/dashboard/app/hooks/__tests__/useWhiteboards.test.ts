import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardDocument } from "@fusion/core";
import { ApiRequestError } from "../../api/client/client";
import { useWhiteboards } from "../useWhiteboards";

const api = vi.hoisted(() => ({
  fetchWhiteboards: vi.fn(), fetchWhiteboard: vi.fn(), createWhiteboard: vi.fn(), renameWhiteboard: vi.fn(),
  saveWhiteboard: vi.fn(), deleteWhiteboard: vi.fn(), fetchWhiteboardRevisions: vi.fn(), restoreWhiteboardRevision: vi.fn(),
}));
vi.mock("../../api/whiteboards", () => api);

const documentA = { version: 1, frames: [], texts: [], relations: [] } as unknown as WhiteboardDocument;
const documentB = { version: 1, frames: [], texts: [{ id: "b" }], relations: [] } as unknown as WhiteboardDocument;
const boardA = { id: "a", title: "A", document: documentA, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const boardB = { id: "b", title: "B", document: documentB, revision: 1, createdAt: "2026-01-02", updatedAt: "2026-01-02" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

describe("useWhiteboards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchWhiteboards.mockResolvedValue({ whiteboards: [boardA] });
    api.fetchWhiteboard.mockResolvedValue(boardA);
    api.createWhiteboard.mockResolvedValue(boardB);
    api.fetchWhiteboardRevisions.mockResolvedValue({ revisions: [] });
  });

  it("clears project data immediately and ignores a late list from the old project", async () => {
    const listA = deferred<{ whiteboards: typeof boardA[] }>();
    api.fetchWhiteboards.mockImplementation((projectId: string) => projectId === "A" ? listA.promise : Promise.resolve({ whiteboards: [boardB] }));
    const { result, rerender } = renderHook(({ projectId }) => useWhiteboards(projectId), { initialProps: { projectId: "A" as string | undefined } });
    await waitFor(() => expect(api.fetchWhiteboards).toHaveBeenCalledWith("A", ""));
    rerender({ projectId: "B" });
    expect(result.current.selected).toBeNull();
    await waitFor(() => expect(result.current.whiteboards).toEqual([boardB]));
    await act(async () => { listA.resolve({ whiteboards: [boardA] }); await listA.promise; });
    expect(result.current.whiteboards).toEqual([boardB]);
    rerender({ projectId: undefined });
    expect(result.current.whiteboards).toEqual([]);
  });

  it("keeps the latest selection when an older detail response arrives late", async () => {
    const a = deferred<typeof boardA>();
    const b = deferred<typeof boardB>();
    api.fetchWhiteboard.mockImplementation((_projectId: string, id: string) => id === "a" ? a.promise : b.promise);
    const { result } = renderHook(() => useWhiteboards("P"));
    await waitFor(() => expect(result.current.whiteboards).toHaveLength(1));
    let selectA!: Promise<unknown>; let selectB!: Promise<unknown>;
    act(() => { selectA = result.current.select("a"); selectB = result.current.select("b"); });
    await act(async () => { b.resolve(boardB); await selectB; });
    await act(async () => { a.resolve(boardA); await selectA; });
    expect(result.current.selected).toEqual(boardB);
    expect(result.current.draftDocument).toBe(documentB);
  });

  it("does not replace a newer draft or selection when save resolves late", async () => {
    const save = deferred<typeof boardA>();
    api.saveWhiteboard.mockReturnValue(save.promise);
    api.fetchWhiteboard.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === "a" ? boardA : boardB));
    const { result } = renderHook(() => useWhiteboards("P"));
    await waitFor(() => expect(result.current.whiteboards).toHaveLength(1));
    await act(async () => result.current.select("a"));
    act(() => result.current.setDraftDocument(documentB));
    let saving!: Promise<unknown>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    await act(async () => result.current.select("b"));
    await act(async () => { save.resolve({ ...boardA, document: documentB, revision: 2 }); await saving; });
    expect(result.current.selected).toEqual(boardB);
    expect(result.current.draftDocument).toBe(documentB);
  });

  it("preserves the exact draft on conflict and creates a copy instead of overwriting", async () => {
    api.saveWhiteboard.mockRejectedValue(new ApiRequestError("conflict", 409, { code: "WHITEBOARD_REVISION_CONFLICT" }));
    const copied = { ...boardB, id: "copy", title: "A (copy)", document: documentB };
    api.createWhiteboard.mockResolvedValue(copied);
    const { result } = renderHook(() => useWhiteboards("P"));
    await waitFor(() => expect(result.current.whiteboards).toHaveLength(1));
    await act(async () => result.current.select("a"));
    act(() => { result.current.setDraftTitle("Local"); result.current.setDraftDocument(documentB); });
    await act(async () => result.current.save());
    expect(result.current.conflict).toBe(true);
    expect(result.current.draftTitle).toBe("Local");
    expect(result.current.draftDocument).toBe(documentB);
    await act(async () => result.current.createConflictCopy("A (copy)"));
    expect(api.createWhiteboard).toHaveBeenCalledWith("P", "A (copy)", documentB);
    expect(api.saveWhiteboard).toHaveBeenCalledTimes(1);
    expect(result.current.selected).toEqual(copied);
  });

  it("serializes mutations against the latest accepted CAS revision", async () => {
    const first = deferred<typeof boardA>();
    let serverRevision = 1;
    api.saveWhiteboard.mockImplementation((_projectId: string, _id: string, _document: WhiteboardDocument, expectedRevision: number) => {
      if (expectedRevision !== serverRevision) return Promise.reject(new ApiRequestError("conflict", 409));
      serverRevision = 2;
      return first.promise;
    });
    api.renameWhiteboard.mockImplementation((_projectId: string, _id: string, title: string, expectedRevision: number) => {
      if (expectedRevision !== serverRevision) return Promise.reject(new ApiRequestError("conflict", 409));
      serverRevision = 3;
      return Promise.resolve({ ...boardA, title, revision: serverRevision });
    });
    const { result } = renderHook(() => useWhiteboards("P"));
    await waitFor(() => expect(result.current.whiteboards).toHaveLength(1));
    await act(async () => result.current.select("a"));
    let savePromise!: Promise<unknown>; let renamePromise!: Promise<unknown>;
    act(() => { savePromise = result.current.save(); renamePromise = result.current.rename("Renamed"); });
    await waitFor(() => expect(api.saveWhiteboard).toHaveBeenCalledTimes(1));
    expect(api.renameWhiteboard).not.toHaveBeenCalled();
    await act(async () => { first.resolve({ ...boardA, revision: 2 }); await savePromise; await renamePromise; });
    expect(api.saveWhiteboard).toHaveBeenCalledWith("P", "a", documentA, 1);
    expect(api.renameWhiteboard).toHaveBeenCalledWith("P", "a", "Renamed", 2);
    expect(result.current.conflict).toBe(false);
    expect(result.current.selected?.revision).toBe(3);
  });

  it("loads history and installs a restored revision as the new current revision", async () => {
    const revision = { revision: 1, title: "A", document: documentA, createdAt: "2026-01-01" };
    api.fetchWhiteboardRevisions.mockResolvedValue({ revisions: [revision] });
    api.restoreWhiteboardRevision.mockResolvedValue({ ...boardA, document: documentB, revision: 2 });
    const { result } = renderHook(() => useWhiteboards("P"));
    await waitFor(() => expect(result.current.whiteboards).toHaveLength(1));
    await act(async () => result.current.select("a"));
    await act(async () => result.current.loadRevisions());
    expect(result.current.revisions).toEqual([revision]);
    await act(async () => result.current.restore(1));
    expect(api.restoreWhiteboardRevision).toHaveBeenCalledWith("P", "a", 1, 1);
    expect(result.current.selected?.revision).toBe(2);
    expect(result.current.dirty).toBe(false);
  });
});
