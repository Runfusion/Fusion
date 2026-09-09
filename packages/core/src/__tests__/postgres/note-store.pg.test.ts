import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { NOTE_CONTENT_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH, NoteRevisionConflictError } from "../../notes/note-types.js";
import { AsyncNoteStore } from "../../async-stores/async-note-store.js";

pgDescribe("NoteStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_note_store", projectId: "notes-project" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);
  const notes = (): AsyncNoteStore => h.store().getNoteStore();

  it("persists notes, permits duplicate titles, and orders recent changes first", async () => {
    const first = await notes().createNote({ title: "Commande", content: "pnpm test" });
    const second = await notes().createNote({ title: "Commande", content: "logs\n```\nok\n```" });
    await h.adminSql()`UPDATE project.notes SET updated_at = '2026-01-01T00:00:00.000Z' WHERE project_id = 'notes-project' AND id = ${second.id}`;
    const changed = await notes().updateNote(first.id, { expectedRevision: first.revision, content: "pnpm lint" });
    expect(changed.revision).toBe(2);
    expect((await notes().listNotes()).map((note) => note.id)).toEqual([first.id, second.id]);
    expect((await new AsyncNoteStore(h.layer()).getNote(first.id))?.content).toBe("pnpm lint");
  });

  it("lets exactly one concurrent CAS writer win and preserves the winner", async () => {
    const note = await notes().createNote({ title: "Concurrente", content: "base" });
    const results = await Promise.allSettled([
      notes().updateNote(note.id, { expectedRevision: 1, content: "A" }),
      notes().updateNote(note.id, { expectedRevision: 1, content: "B" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toBeInstanceOf(NoteRevisionConflictError);
    expect(["A", "B"]).toContain((await notes().getNote(note.id))?.content);
  });

  it("revision-fences deletion and supports empty content plus search", async () => {
    const note = await notes().createNote({ title: "Journal", content: "" });
    const updated = await notes().updateNote(note.id, { expectedRevision: 1, content: "needle" });
    await expect(notes().deleteNote(note.id, 1)).rejects.toBeInstanceOf(NoteRevisionConflictError);
    expect(await notes().listNotes("needle")).toHaveLength(1);
    await notes().deleteNote(note.id, updated.revision);
    expect(await notes().getNote(note.id)).toBeNull();
  });

  it("isolates the same note id across projects", async () => {
    const projectA = notes();
    const projectB = new AsyncNoteStore({ ...h.layer(), projectId: "notes-project-b" });
    const id = "shared-note-id";
    await projectA.createNote({ id, title: "Même titre", content: "A" });
    await projectB.createNote({ id, title: "Même titre", content: "B" });

    await projectA.updateNote(id, { expectedRevision: 1, content: "A2" });
    expect((await projectA.getNote(id))?.content).toBe("A2");
    expect((await projectB.getNote(id))?.content).toBe("B");
    await projectA.deleteNote(id, 2);
    expect(await projectA.getNote(id)).toBeNull();
    expect((await projectB.getNote(id))?.content).toBe("B");
  });

  it("enforces exact title and UTF-8 content limits", async () => {
    const accepted = await notes().createNote({ title: "t".repeat(NOTE_TITLE_MAX_LENGTH), content: "é".repeat(NOTE_CONTENT_MAX_LENGTH / 2) });
    expect((await notes().getNote(accepted.id))?.content).toHaveLength(NOTE_CONTENT_MAX_LENGTH / 2);
    await expect(notes().createNote({ title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1) })).rejects.toBeInstanceOf(RangeError);
    await expect(notes().createNote({ title: "t", content: `${"a".repeat(NOTE_CONTENT_MAX_LENGTH)}é` })).rejects.toBeInstanceOf(RangeError);
  });
});
