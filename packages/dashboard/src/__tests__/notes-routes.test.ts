// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { NoteNotFoundError, NoteRevisionConflictError, type ProjectNote, type TaskStore } from "@fusion/core";
import { createNotesRouter } from "../notes-routes.js";
import type { ServerOptions } from "../server.js";
import { get, request } from "../test-request.js";

function memoryStore() {
  const rows = new Map<string, ProjectNote>(); let sequence = 0;
  return {
    listNotes: (q?: string) => [...rows.values()].filter((n) => !q || `${n.title} ${n.content}`.includes(q)).map(({ content: _, ...n }) => n),
    getNote: (id: string) => rows.get(id) ?? null,
    createNote: (input: { title: string; content?: string }) => { const now = new Date().toISOString(); const note = { id: `n-${++sequence}`, title: input.title, content: input.content ?? "", revision: 1, createdAt: now, updatedAt: now }; rows.set(note.id, note); return note; },
    updateNote: (id: string, input: { title?: string; content?: string; expectedRevision: number }) => { const old = rows.get(id); if (!old) throw new NoteNotFoundError(id); if (old.revision !== input.expectedRevision) throw new NoteRevisionConflictError(id, input.expectedRevision); const note = { ...old, ...input, revision: old.revision + 1, updatedAt: new Date().toISOString() }; rows.set(id, note); return note; },
    deleteNote: (id: string, rev: number) => { const old = rows.get(id); if (!old) throw new NoteNotFoundError(id); if (old.revision !== rev) throw new NoteRevisionConflictError(id, rev); rows.delete(id); },
  };
}

describe("notes-routes", () => {
  let app: express.Express;
  beforeEach(() => { const notes = memoryStore(); app = express(); app.use(express.json({ limit: "2mb" })); app.use("/api/notes", createNotesRouter({ getNoteStore: () => notes } as unknown as TaskStore)); });
  it("creates, searches, updates and deletes with revision fencing", async () => {
    const made = await request(app, "POST", "/api/notes", JSON.stringify({ title: "Commande", content: "pnpm test" }), { "content-type": "application/json" });
    expect(made.status).toBe(201);
    expect((await get(app, "/api/notes?q=pnpm")).body.notes).toHaveLength(1);
    const changed = await request(app, "PATCH", `/api/notes/${made.body.id}`, JSON.stringify({ content: "logs", expectedRevision: 1 }), { "content-type": "application/json" });
    expect(changed.body.revision).toBe(2);
    const conflict = await request(app, "PATCH", `/api/notes/${made.body.id}`, JSON.stringify({ content: "stale", expectedRevision: 1 }), { "content-type": "application/json" });
    expect(conflict.status).toBe(409); expect(conflict.body.details.code).toBe("NOTE_REVISION_CONFLICT");
    expect((await request(app, "DELETE", `/api/notes/${made.body.id}?expectedRevision=2`)).status).toBe(204);
    expect((await get(app, `/api/notes/${made.body.id}`)).status).toBe(404);
  });
  it("rejects invalid and oversized bodies", async () => {
    expect((await request(app, "POST", "/api/notes", JSON.stringify({ title: "" }), { "content-type": "application/json" })).status).toBe(400);
    expect((await request(app, "POST", "/api/notes", JSON.stringify({ title: "x", content: "x".repeat(1024 * 1024 + 1) }), { "content-type": "application/json" })).status).toBe(400);
  });

  it("never resolves project identity from a note body", async () => {
    const notesA = memoryStore();
    const notesB = memoryStore();
    const stores = {
      A: { getNoteStore: () => notesA } as unknown as TaskStore,
      B: { getNoteStore: () => notesB } as unknown as TaskStore,
    };
    const options = {
      engineManager: {
        getEngine: (projectId: string) => ({ getTaskStore: () => stores[projectId as keyof typeof stores] }),
      },
    } as unknown as ServerOptions;
    const scopedApp = express();
    scopedApp.use(express.json());
    scopedApp.use("/api/notes", createNotesRouter(stores.A, options));

    const madeA = await request(scopedApp, "POST", "/api/notes?projectId=A", JSON.stringify({ title: "A", content: "secret-a" }), { "content-type": "application/json" });
    const madeB = await request(scopedApp, "POST", "/api/notes?projectId=B", JSON.stringify({ title: "B", content: "secret-b" }), { "content-type": "application/json" });
    expect(madeA.body.id).toBe(madeB.body.id);

    const redirectedRead = await request(scopedApp, "GET", "/api/notes?projectId=A", JSON.stringify({ projectId: "B" }), { "content-type": "application/json" });
    const redirectedWrite = await request(scopedApp, "PATCH", `/api/notes/${madeA.body.id}?projectId=A`, JSON.stringify({ projectId: "B", content: "stolen", expectedRevision: 1 }), { "content-type": "application/json" });
    expect(redirectedRead.status).toBe(400);
    expect(redirectedWrite.status).toBe(400);

    expect((await get(scopedApp, `/api/notes/${madeA.body.id}?projectId=A`)).body.content).toBe("secret-a");
    expect((await get(scopedApp, `/api/notes/${madeB.body.id}?projectId=B`)).body.content).toBe("secret-b");
  });
});
