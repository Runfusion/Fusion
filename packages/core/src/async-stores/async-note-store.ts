import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import {
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteNotFoundError,
  NoteRevisionConflictError,
  type ProjectNote,
  type ProjectNoteCreateInput,
  type ProjectNoteSummary,
  type ProjectNoteUpdateInput,
} from "../notes/note-types.js";

const noteColumns = {
  id: schema.project.notes.id,
  title: schema.project.notes.title,
  content: schema.project.notes.content,
  revision: schema.project.notes.revision,
  createdAt: schema.project.notes.createdAt,
  updatedAt: schema.project.notes.updatedAt,
};

function validateTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || title.length > NOTE_TITLE_MAX_LENGTH) throw new RangeError("Invalid note title");
  return normalized;
}

function validateContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") > NOTE_CONTENT_MAX_LENGTH) throw new RangeError("Note content is too large");
  return content;
}

/*
FNXC:ProjectNotes 2026-09-09-17:08:
Notes are durable user text scoped by the AsyncDataLayer project identity. Every query includes project_id explicitly, and update/delete use one atomic revision CAS so concurrent writers cannot silently overwrite a draft.
*/
export class AsyncNoteStore {
  constructor(private readonly layer: AsyncDataLayer) {
    if (!layer.projectId?.trim()) throw new Error("NoteStore requires a project-scoped AsyncDataLayer");
  }

  async listNotes(search?: string): Promise<ProjectNoteSummary[]> {
    const scope = eq(schema.project.notes.projectId, this.layer.projectId!);
    const term = search?.trim();
    const rows = await this.layer.db.select(noteColumns).from(schema.project.notes)
      .where(term ? and(scope, or(ilike(schema.project.notes.title, `%${term}%`), ilike(schema.project.notes.content, `%${term}%`))) : scope)
      .orderBy(desc(schema.project.notes.updatedAt), desc(schema.project.notes.id));
    return rows.map(({ content: _content, ...summary }) => summary);
  }

  async getNote(id: string): Promise<ProjectNote | null> {
    const rows = await this.layer.db.select(noteColumns).from(schema.project.notes).where(and(
      eq(schema.project.notes.projectId, this.layer.projectId!), eq(schema.project.notes.id, id),
    ));
    return rows[0] ?? null;
  }

  async createNote(input: ProjectNoteCreateInput & { id?: string }): Promise<ProjectNote> {
    const now = new Date().toISOString();
    const rows = await this.layer.db.insert(schema.project.notes).values({
      projectId: this.layer.projectId!, id: input.id ?? randomUUID(), title: validateTitle(input.title),
      content: validateContent(input.content ?? ""), revision: 1, createdAt: now, updatedAt: now,
    }).returning(noteColumns);
    return rows[0]!;
  }

  async updateNote(id: string, input: ProjectNoteUpdateInput): Promise<ProjectNote> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new RangeError("Invalid expected revision");
    const changes: { title?: string; content?: string; revision: number; updatedAt: string } = {
      revision: input.expectedRevision + 1, updatedAt: new Date().toISOString(),
    };
    if (input.title !== undefined) changes.title = validateTitle(input.title);
    if (input.content !== undefined) changes.content = validateContent(input.content);
    const rows = await this.layer.db.update(schema.project.notes).set(changes).where(and(
      eq(schema.project.notes.projectId, this.layer.projectId!), eq(schema.project.notes.id, id),
      eq(schema.project.notes.revision, input.expectedRevision),
    )).returning(noteColumns);
    if (rows[0]) return rows[0];
    if (!(await this.getNote(id))) throw new NoteNotFoundError(id);
    throw new NoteRevisionConflictError(id, input.expectedRevision);
  }

  async deleteNote(id: string, expectedRevision: number): Promise<void> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new RangeError("Invalid expected revision");
    const rows = await this.layer.db.delete(schema.project.notes).where(and(
      eq(schema.project.notes.projectId, this.layer.projectId!), eq(schema.project.notes.id, id),
      eq(schema.project.notes.revision, expectedRevision),
    )).returning({ id: schema.project.notes.id });
    if (rows[0]) return;
    if (!(await this.getNote(id))) throw new NoteNotFoundError(id);
    throw new NoteRevisionConflictError(id, expectedRevision);
  }
}
