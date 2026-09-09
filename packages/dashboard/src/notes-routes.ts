import { AsyncLocalStorage } from "node:async_hooks";
import { Router, type Request, type Response } from "express";
import {
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteNotFoundError,
  NoteRevisionConflictError,
  type TaskStore,
} from "@fusion/core";
import { badRequest, catchHandler, conflict, notFound } from "./api-error.js";
import { getScopedStore as resolveScopedRequestStore } from "./routes/context.js";
import type { ServerOptions } from "./server.js";

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > NOTE_TITLE_MAX_LENGTH) throw badRequest("title must contain 1 to 200 characters");
  return value.trim();
}
function content(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > NOTE_CONTENT_MAX_LENGTH) throw badRequest("content must be a string up to 1 MiB");
  return value;
}
function noteId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw badRequest("invalid note id");
  return value;
}
function revision(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || (parsed as number) < 1) throw badRequest("expectedRevision must be a positive integer");
  return parsed as number;
}
function mapStoreError(error: unknown): never {
  if (error instanceof NoteNotFoundError) throw notFound("Note not found");
  if (error instanceof NoteRevisionConflictError) throw conflict("Note revision conflict", { code: error.code });
  throw error;
}

/*
FNXC:ProjectNotes 2026-09-09-17:49:
Notes accept project identity only from the request query or the registered launch context. Reject a projectId body field before shared store resolution because that resolver supports legacy body scoping for other APIs and would otherwise let note payloads redirect reads or writes across projects.
*/
export function createNotesRouter(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const context = new AsyncLocalStorage<TaskStore>();
  const scoped = () => (context.getStore() ?? store).getNoteStore();
  router.use(catchHandler(async (req: Request, _res: Response, next) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "projectId")) {
      throw badRequest("projectId must be provided in the query context");
    }
    context.run(await resolveScopedRequestStore(req, store, options), next);
  }));
  router.get("/", catchHandler(async (req, res) => {
    const query = req.query.q;
    if (query !== undefined && (typeof query !== "string" || query.length > 200)) throw badRequest("q must be a string up to 200 characters");
    res.json({ notes: await scoped().listNotes(query as string | undefined) });
  }));
  router.get("/:id", catchHandler(async (req, res) => {
    const note = await scoped().getNote(noteId(req.params.id));
    if (!note) throw notFound("Note not found");
    res.json(note);
  }));
  router.post("/", catchHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    res.status(201).json(await scoped().createNote({ title: title(body.title), content: body.content === undefined ? "" : content(body.content) }));
  }));
  router.patch("/:id", catchHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.title === undefined && body.content === undefined) throw badRequest("title or content is required");
    try {
      res.json(await scoped().updateNote(noteId(req.params.id), {
        expectedRevision: revision(body.expectedRevision),
        ...(body.title === undefined ? {} : { title: title(body.title) }),
        ...(body.content === undefined ? {} : { content: content(body.content) }),
      }));
    } catch (error) { mapStoreError(error); }
  }));
  router.delete("/:id", catchHandler(async (req, res) => {
    try { await scoped().deleteNote(noteId(req.params.id), revision(req.query.expectedRevision)); res.status(204).end(); }
    catch (error) { mapStoreError(error); }
  }));
  return router;
}
