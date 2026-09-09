import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/client/client";
import { useNotes } from "../useNotes";
const api = vi.hoisted(() => ({ fetchNotes: vi.fn(), fetchNote: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() }));
vi.mock("../../api/notes", () => api);
const note = { id: "n1", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const noteB = { id: "n2", title: "Journal", content: "logs B", revision: 1, createdAt: "2026-01-02", updatedAt: "2026-01-02" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("useNotes", () => {
  beforeEach(() => { vi.clearAllMocks(); api.fetchNotes.mockResolvedValue({ notes: [note] }); api.fetchNote.mockResolvedValue(note); });
  it("does not fetch without a project and clears data on project change", async () => {
    const { result, rerender } = renderHook(({ projectId }) => useNotes(projectId), { initialProps: { projectId: undefined as string | undefined } });
    expect(api.fetchNotes).not.toHaveBeenCalled(); rerender({ projectId: "A" }); await waitFor(() => expect(result.current.notes).toHaveLength(1));
    rerender({ projectId: undefined }); expect(result.current.notes).toEqual([]); expect(result.current.selected).toBeNull();
  });
  it("preserves the exact draft after a revision conflict", async () => {
    api.updateNote.mockRejectedValue(new ApiRequestError("conflict", 409, { code: "NOTE_REVISION_CONFLICT" }));
    const { result } = renderHook(() => useNotes("A")); await waitFor(() => expect(result.current.notes).toHaveLength(1));
    await act(async () => result.current.select("n1")); act(() => { result.current.setDraftTitle("Local"); result.current.setDraftContent("logs locaux"); });
    await act(async () => result.current.save());
    expect(result.current.conflict).toBe(true); expect(result.current.draftTitle).toBe("Local"); expect(result.current.draftContent).toBe("logs locaux"); expect(result.current.dirty).toBe(true);
  });

  it("ignores a late project A list after switching to project B", async () => {
    const listA = deferred<{ notes: typeof note[] }>();
    api.fetchNotes.mockImplementation((projectId: string) => projectId === "A" ? listA.promise : Promise.resolve({ notes: [noteB] }));
    const { result, rerender } = renderHook(({ projectId }) => useNotes(projectId), { initialProps: { projectId: "A" } });
    await waitFor(() => expect(api.fetchNotes).toHaveBeenCalledWith("A", ""));
    rerender({ projectId: "B" });
    await waitFor(() => expect(result.current.notes).toEqual([noteB]));
    await act(async () => { listA.resolve({ notes: [note] }); await listA.promise; });
    expect(result.current.notes).toEqual([noteB]);
  });

  it("keeps edits made while a save is in flight dirty", async () => {
    const update = deferred<typeof note>();
    api.updateNote.mockReturnValue(update.promise);
    const { result } = renderHook(() => useNotes("A"));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    await act(async () => result.current.select(note.id));
    act(() => result.current.setDraftContent("contenu envoyé"));
    let saving!: Promise<typeof note | null>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    act(() => result.current.setDraftContent("brouillon plus récent"));
    await act(async () => {
      update.resolve({ ...note, content: "contenu envoyé", revision: 2 });
      await saving;
    });
    expect(result.current.selected?.content).toBe("contenu envoyé");
    expect(result.current.draftContent).toBe("brouillon plus récent");
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
  });

  it("does not replace note B when save A resolves late", async () => {
    const update = deferred<typeof note>();
    api.updateNote.mockReturnValue(update.promise);
    api.fetchNote.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === noteB.id ? noteB : note));
    const { result } = renderHook(() => useNotes("A"));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    await act(async () => result.current.select(note.id));
    act(() => result.current.setDraftContent("contenu A envoyé"));
    let saving!: Promise<typeof note | null>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    await act(async () => result.current.select(noteB.id));
    expect(result.current.selected?.id).toBe(noteB.id);
    await act(async () => {
      update.resolve({ ...note, content: "contenu A envoyé", revision: 2 });
      await saving;
    });
    expect(result.current.selected).toEqual(noteB);
    expect(result.current.draftContent).toBe(noteB.content);
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
  });
});
