import { afterEach, describe, expect, it, vi } from "vitest";
import { createNote, deleteNote, fetchNote, fetchNotes, updateNote } from "../notes";
const response = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
describe("notes api", () => {
  afterEach(() => vi.restoreAllMocks());
  it("encodes project, ids, search, payloads and cancellation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ notes: [] }));
    const controller = new AbortController();
    await fetchNotes("project A", "build logs", controller.signal);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/notes?q=build+logs&projectId=project%20A");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    await fetchNote("project A", "note/a");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/notes/note%2Fa?projectId=project%20A");
    await createNote("p", { title: "T", content: "C" });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(JSON.stringify({ title: "T", content: "C" }));
    await updateNote("p", "n", { content: "new", expectedRevision: 2 });
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("PATCH");
    await deleteNote("p", "n", 3);
    expect(fetchMock.mock.calls[4]?.[0]).toContain("expectedRevision=3&projectId=p");
  });
});
