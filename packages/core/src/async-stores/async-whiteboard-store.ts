import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import { createEmptyWhiteboardDocument, validateWhiteboardDocument, validateWhiteboardTitle, WhiteboardNotFoundError, WhiteboardRevisionConflictError, type ProjectWhiteboard, type ProjectWhiteboardSummary, type WhiteboardDocumentV1, type WhiteboardRevision } from "../whiteboards/whiteboard-types.js";

const columns = { id: schema.project.whiteboards.id, title: schema.project.whiteboards.title, document: schema.project.whiteboards.document, revision: schema.project.whiteboards.revision, createdAt: schema.project.whiteboards.createdAt, updatedAt: schema.project.whiteboards.updatedAt };
function row(row: typeof schema.project.whiteboards.$inferSelect): ProjectWhiteboard { return { ...row, document: validateWhiteboardDocument(row.document) }; }

/* FNXC:WhiteboardAlpha 2026-09-10-05:42: Every mutation advances the project-scoped head with one revision CAS and inserts its immutable snapshot in the same transaction; conflicts never leave partial history or expose a last-write-wins route. */
export class AsyncWhiteboardStore {
  constructor(private readonly layer: AsyncDataLayer) { if (!layer.projectId?.trim()) throw new Error("WhiteboardStore requires a project-scoped AsyncDataLayer"); }
  private get projectId(): string { return this.layer.projectId!; }

  async listWhiteboards(search?: string): Promise<ProjectWhiteboardSummary[]> {
    const scope = eq(schema.project.whiteboards.projectId, this.projectId); const term = search?.trim();
    const rows = await this.layer.db.select(columns).from(schema.project.whiteboards).where(term ? and(scope, ilike(schema.project.whiteboards.title, `%${term}%`)) : scope).orderBy(desc(schema.project.whiteboards.updatedAt), desc(schema.project.whiteboards.id));
    return rows.map(({ document: _document, ...summary }) => summary);
  }
  async getWhiteboard(id: string): Promise<ProjectWhiteboard | null> {
    const rows = await this.layer.db.select().from(schema.project.whiteboards).where(and(eq(schema.project.whiteboards.projectId, this.projectId), eq(schema.project.whiteboards.id, id))); return rows[0] ? row(rows[0]) : null;
  }
  async createWhiteboard(input: { title: string; document?: WhiteboardDocumentV1; id?: string }): Promise<ProjectWhiteboard> {
    const now = new Date().toISOString(); const id = input.id ?? randomUUID(); const title = validateWhiteboardTitle(input.title); const document = validateWhiteboardDocument(input.document ?? createEmptyWhiteboardDocument());
    return this.layer.db.transaction(async (tx) => {
      const inserted = (await tx.insert(schema.project.whiteboards).values({ projectId: this.projectId, id, title, document, revision: 1, createdAt: now, updatedAt: now }).returning())[0]!;
      await tx.insert(schema.project.whiteboardRevisions).values({ projectId: this.projectId, whiteboardId: id, revision: 1, title, document, createdAt: now }); return row(inserted);
    });
  }
  private async mutate(id: string, expectedRevision: number, changes: { title?: string; document?: WhiteboardDocumentV1 }): Promise<ProjectWhiteboard> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new RangeError("Invalid expected revision");
    const title = changes.title === undefined ? undefined : validateWhiteboardTitle(changes.title); const document = changes.document === undefined ? undefined : validateWhiteboardDocument(changes.document); const now = new Date().toISOString();
    return this.layer.db.transaction(async (tx) => {
      const updated = (await tx.update(schema.project.whiteboards).set({ ...(title === undefined ? {} : { title }), ...(document === undefined ? {} : { document }), revision: expectedRevision + 1, updatedAt: now }).where(and(eq(schema.project.whiteboards.projectId, this.projectId), eq(schema.project.whiteboards.id, id), eq(schema.project.whiteboards.revision, expectedRevision))).returning())[0];
      if (!updated) { const exists = (await tx.select({ id: schema.project.whiteboards.id }).from(schema.project.whiteboards).where(and(eq(schema.project.whiteboards.projectId, this.projectId), eq(schema.project.whiteboards.id, id))))[0]; if (!exists) throw new WhiteboardNotFoundError(id); throw new WhiteboardRevisionConflictError(id, expectedRevision); }
      await tx.insert(schema.project.whiteboardRevisions).values({ projectId: this.projectId, whiteboardId: id, revision: updated.revision, title: updated.title, document: updated.document, createdAt: now }); return row(updated);
    });
  }
  saveWhiteboard(id: string, input: { document: WhiteboardDocumentV1; expectedRevision: number } | WhiteboardDocumentV1, expectedRevision?: number) { const payload = "document" in input && "expectedRevision" in input ? input : { document: input as WhiteboardDocumentV1, expectedRevision: expectedRevision! }; return this.mutate(id, payload.expectedRevision, { document: payload.document }); }
  renameWhiteboard(id: string, input: { title: string; expectedRevision: number } | string, expectedRevision?: number) { const payload = typeof input === "string" ? { title: input, expectedRevision: expectedRevision! } : input; return this.mutate(id, payload.expectedRevision, { title: payload.title }); }
  async listRevisions(id: string): Promise<WhiteboardRevision[]> {
    if (!(await this.getWhiteboard(id))) throw new WhiteboardNotFoundError(id);
    const rows = await this.layer.db.select().from(schema.project.whiteboardRevisions).where(and(eq(schema.project.whiteboardRevisions.projectId, this.projectId), eq(schema.project.whiteboardRevisions.whiteboardId, id))).orderBy(desc(schema.project.whiteboardRevisions.revision));
    return rows.map((r) => ({ revision: r.revision, title: r.title, document: validateWhiteboardDocument(r.document), createdAt: r.createdAt }));
  }
  listWhiteboardRevisions(id: string): Promise<WhiteboardRevision[]> { return this.listRevisions(id); }
  async restoreWhiteboard(id: string, sourceRevision: number, expectedRevision: number): Promise<ProjectWhiteboard> {
    const snapshots = await this.layer.db.select().from(schema.project.whiteboardRevisions).where(and(eq(schema.project.whiteboardRevisions.projectId, this.projectId), eq(schema.project.whiteboardRevisions.whiteboardId, id), eq(schema.project.whiteboardRevisions.revision, sourceRevision)));
    const snapshot = snapshots[0]; if (!snapshot) { if (!(await this.getWhiteboard(id))) throw new WhiteboardNotFoundError(id); throw new WhiteboardNotFoundError(`${id}@${sourceRevision}`); }
    return this.mutate(id, expectedRevision, { title: snapshot.title, document: validateWhiteboardDocument(snapshot.document) });
  }
  restoreWhiteboardRevision(id: string, input: { revision: number; expectedRevision: number }): Promise<ProjectWhiteboard> { return this.restoreWhiteboard(id, input.revision, input.expectedRevision); }
  async deleteWhiteboard(id: string, expectedRevision: number): Promise<void> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new RangeError("Invalid expected revision");
    const deleted = await this.layer.db.delete(schema.project.whiteboards).where(and(eq(schema.project.whiteboards.projectId, this.projectId), eq(schema.project.whiteboards.id, id), eq(schema.project.whiteboards.revision, expectedRevision))).returning({ id: schema.project.whiteboards.id });
    if (deleted[0]) return; if (!(await this.getWhiteboard(id))) throw new WhiteboardNotFoundError(id); throw new WhiteboardRevisionConflictError(id, expectedRevision);
  }
}
