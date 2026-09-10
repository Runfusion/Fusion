// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskStore, WhiteboardDocument } from "@fusion/core";
import { createWhiteboardRouter } from "../whiteboard-routes.js";
import type { ServerOptions } from "../server.js";
import { get, request } from "../test-request.js";

const emptyDocument = { version: 1, frames: [], texts: [], relations: [] } as unknown as WhiteboardDocument;
const populatedDocument = {
  version: 1,
  frames: [{ id: "frame", kind: "process-step", x: 0, y: 0, width: 300, height: 200 }],
  texts: [
    { id: "source", role: "idea", text: "Décision", x: 20, y: 20, frameId: "frame" },
    { id: "yes", role: "body", text: "Oui", x: 500, y: 20 },
    { id: "no", role: "body", text: "Non", x: 500, y: 180 },
  ],
  relations: [{ id: "relation", sourceId: "source", annotation: "Choix", junction: { id: "junction", x: 400, y: 100 }, branches: [{ id: "yes-branch", targetId: "yes", annotation: "Oui" }, { id: "no-branch", targetId: "no", annotation: "Non" }] }],
} as unknown as WhiteboardDocument;

class StoreError extends Error { constructor(public code: string) { super(code); } }
function memoryStore() {
  type Row = { id: string; title: string; document: WhiteboardDocument; revision: number; createdAt: string; updatedAt: string };
  const rows = new Map<string, Row>();
  const history = new Map<string, Row[]>();
  let sequence = 0;
  const requireRow = (id: string) => { const row = rows.get(id); if (!row) throw new StoreError("WHITEBOARD_NOT_FOUND"); return row; };
  const commit = (id: string, expectedRevision: number, patch: Partial<Row>) => {
    const old = requireRow(id);
    if (old.revision !== expectedRevision) throw new StoreError("WHITEBOARD_REVISION_CONFLICT");
    const row = { ...old, ...patch, revision: old.revision + 1, updatedAt: new Date().toISOString() };
    rows.set(id, row); history.set(id, [...(history.get(id) ?? []), row]); return row;
  };
  return {
    listWhiteboards: (q?: string) => [...rows.values()].filter((row) => !q || row.title.includes(q)).map(({ document: _, ...summary }) => summary),
    getWhiteboard: (id: string) => rows.get(id) ?? null,
    createWhiteboard: ({ title, document = emptyDocument }: { title: string; document?: WhiteboardDocument }) => { const now = new Date().toISOString(); const row = { id: `w-${++sequence}`, title, document, revision: 1, createdAt: now, updatedAt: now }; rows.set(row.id, row); history.set(row.id, [row]); return row; },
    renameWhiteboard: (id: string, input: { title: string; expectedRevision: number }) => commit(id, input.expectedRevision, { title: input.title }),
    saveWhiteboard: (id: string, input: { document: WhiteboardDocument; expectedRevision: number }) => commit(id, input.expectedRevision, { document: input.document }),
    deleteWhiteboard: (id: string, expectedRevision: number) => { const row = requireRow(id); if (row.revision !== expectedRevision) throw new StoreError("WHITEBOARD_REVISION_CONFLICT"); rows.delete(id); history.delete(id); },
    listWhiteboardRevisions: (id: string) => { requireRow(id); return history.get(id) ?? []; },
    restoreWhiteboardRevision: (id: string, input: { revision: number; expectedRevision: number }) => { const old = (history.get(id) ?? []).find((row) => row.revision === input.revision); if (!old) throw new StoreError("WHITEBOARD_NOT_FOUND"); return commit(id, input.expectedRevision, { title: old.title, document: old.document }); },
  };
}
function appFor(whiteboards = memoryStore(), options?: ServerOptions) {
  const app = express(); app.use(express.json({ limit: "6mb" })); app.use("/api/whiteboards", createWhiteboardRouter({ getWhiteboardStore: () => whiteboards } as unknown as TaskStore, options)); return app;
}

describe("whiteboard-routes", () => {
  let app: express.Express;
  beforeEach(() => { app = appFor(); });

  it("round-trips a multi-target document and permits duplicate titles in search", async () => {
    const first = await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "Parcours", document: populatedDocument }), { "content-type": "application/json" });
    const second = await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "Parcours" }), { "content-type": "application/json" });
    expect(first.status).toBe(201); expect(second.status).toBe(201); expect(second.body.id).not.toBe(first.body.id);
    expect((await get(app, "/api/whiteboards?q=Parcours")).body.whiteboards).toHaveLength(2);
    expect((await get(app, `/api/whiteboards/${first.body.id}`)).body.document.relations[0].branches).toHaveLength(2);
  });

  it("uses revision CAS for save, rename, restore, and delete", async () => {
    const made = await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "Initial" }), { "content-type": "application/json" });
    const saved = await request(app, "PUT", `/api/whiteboards/${made.body.id}`, JSON.stringify({ document: populatedDocument, expectedRevision: 1 }), { "content-type": "application/json" });
    expect(saved.body.revision).toBe(2);
    const stale = await request(app, "PATCH", `/api/whiteboards/${made.body.id}`, JSON.stringify({ title: "Stale", expectedRevision: 1 }), { "content-type": "application/json" });
    expect(stale.status).toBe(409); expect(stale.body.details.code).toBe("WHITEBOARD_REVISION_CONFLICT");
    const restored = await request(app, "POST", `/api/whiteboards/${made.body.id}/revisions/1/restore`, JSON.stringify({ expectedRevision: 2 }), { "content-type": "application/json" });
    expect(restored.body.revision).toBe(3); expect(restored.body.document).toEqual(emptyDocument);
    expect((await get(app, `/api/whiteboards/${made.body.id}/revisions`)).body.revisions).toHaveLength(3);
    expect((await request(app, "DELETE", `/api/whiteboards/${made.body.id}?expectedRevision=2`)).status).toBe(409);
    expect((await request(app, "DELETE", `/api/whiteboards/${made.body.id}?expectedRevision=3`)).status).toBe(204);
  });

  it("rejects malformed payloads and project spoofing", async () => {
    expect((await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "" }), { "content-type": "application/json" })).status).toBe(400);
    expect((await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "x", document: [] }), { "content-type": "application/json" })).status).toBe(400);
    expect((await request(app, "POST", "/api/whiteboards", JSON.stringify({ title: "x", projectId: "B" }), { "content-type": "application/json" })).status).toBe(400);
  });

  it("resolves the store from query context and isolates equal ids", async () => {
    const stores = { A: memoryStore(), B: memoryStore() };
    const taskStores = {
      A: { getWhiteboardStore: () => stores.A } as unknown as TaskStore,
      B: { getWhiteboardStore: () => stores.B } as unknown as TaskStore,
    };
    const options = { engineManager: { getEngine: (projectId: string) => ({ getTaskStore: () => taskStores[projectId as keyof typeof taskStores] }) } } as unknown as ServerOptions;
    const scoped = appFor(stores.A, options);
    const a = await request(scoped, "POST", "/api/whiteboards?projectId=A", JSON.stringify({ title: "A" }), { "content-type": "application/json" });
    const b = await request(scoped, "POST", "/api/whiteboards?projectId=B", JSON.stringify({ title: "B" }), { "content-type": "application/json" });
    expect(a.body.id).toBe(b.body.id);
    expect((await get(scoped, `/api/whiteboards/${a.body.id}?projectId=A`)).body.title).toBe("A");
    expect((await get(scoped, `/api/whiteboards/${b.body.id}?projectId=B`)).body.title).toBe("B");
  });
});
