export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_CONTENT_MAX_LENGTH = 1024 * 1024;

export interface ProjectNoteSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectNote extends ProjectNoteSummary {
  content: string;
}

export interface ProjectNoteCreateInput {
  title: string;
  content?: string;
}

export interface ProjectNoteUpdateInput {
  title?: string;
  content?: string;
  expectedRevision: number;
}

export class NoteRevisionConflictError extends Error {
  readonly code = "NOTE_REVISION_CONFLICT";
  constructor(readonly id: string, readonly expectedRevision: number) {
    super(`Note ${id} changed since revision ${expectedRevision}`);
    this.name = "NoteRevisionConflictError";
  }
}

export class NoteNotFoundError extends Error {
  readonly code = "NOTE_NOT_FOUND";
  constructor(readonly id: string) {
    super(`Note ${id} not found`);
    this.name = "NoteNotFoundError";
  }
}
