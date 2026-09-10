import { AsyncLocalStorage } from "node:async_hooks";
import { Router, type Request, type Response } from "express";
import type { TaskStore, WhiteboardDocument } from "@fusion/core";
import { badRequest, catchHandler, conflict, notFound } from "./api-error.js";
import { getScopedStore as resolveScopedRequestStore } from "./routes/context.js";
import type { ServerOptions } from "./server.js";

interface WhiteboardStoreApi {
  listWhiteboards(search?: string): Promise<unknown> | unknown;
  getWhiteboard(id: string): Promise<unknown | null> | unknown | null;
  createWhiteboard(input: { title: string; document?: WhiteboardDocument }): Promise<unknown> | unknown;
  renameWhiteboard(id: string, input: { title: string; expectedRevision: number }): Promise<unknown> | unknown;
  saveWhiteboard(id: string, input: { document: WhiteboardDocument; expectedRevision: number }): Promise<unknown> | unknown;
  deleteWhiteboard(id: string, expectedRevision: number): Promise<void> | void;
  listWhiteboardRevisions(id: string): Promise<unknown> | unknown;
  restoreWhiteboardRevision(id: string, input: { revision: number; expectedRevision: number }): Promise<unknown> | unknown;
}

function body(req: Request): Record<string, unknown> {
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw badRequest("body must be a JSON object");
  return req.body as Record<string, unknown>;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw badRequest("title must contain 1 to 200 characters");
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw badRequest("invalid whiteboard id");
  return value;
}
function revision(value: unknown, field = "expectedRevision"): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) throw badRequest(`${field} must be a positive integer`);
  return parsed as number;
}
function document(value: unknown): WhiteboardDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("document must be a JSON object");
  return value as WhiteboardDocument;
}
function mapStoreError(error: unknown): never {
  const candidate = error as { code?: unknown; name?: unknown };
  if (candidate?.code === "WHITEBOARD_NOT_FOUND" || candidate?.name === "WhiteboardNotFoundError") throw notFound("Whiteboard not found");
  if (candidate?.code === "WHITEBOARD_REVISION_CONFLICT" || candidate?.name === "WhiteboardRevisionConflictError") {
    throw conflict("Whiteboard revision conflict", { code: "WHITEBOARD_REVISION_CONFLICT" });
  }
  if (candidate?.code === "WHITEBOARD_VALIDATION_ERROR" || candidate?.name === "WhiteboardValidationError") {
    throw badRequest(error instanceof Error ? error.message : "Invalid whiteboard document");
  }
  throw error;
}

/*
FNXC:WhiteboardProjectApi 2026-09-10-05:53:
Whiteboard project identity comes exclusively from the request query or launch context. Every document mutation uses an expected revision, maps stale writes to a stable 409, and exposes no force-write route.
*/
export function createWhiteboardRouter(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const context = new AsyncLocalStorage<TaskStore>();
  const scoped = () => (context.getStore() ?? store).getWhiteboardStore() as unknown as WhiteboardStoreApi;

  router.use(catchHandler(async (req: Request, _res: Response, next) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "projectId")) throw badRequest("projectId must be provided in the query context");
    context.run(await resolveScopedRequestStore(req, store, options), next);
  }));

  router.get("/", catchHandler(async (req, res) => {
    const search = req.query.q;
    if (search !== undefined && (typeof search !== "string" || search.length > 200)) throw badRequest("q must be a string up to 200 characters");
    res.json({ whiteboards: await scoped().listWhiteboards(search as string | undefined) });
  }));
  router.post("/", catchHandler(async (req, res) => {
    const input = body(req);
    try {
      res.status(201).json(await scoped().createWhiteboard({ title: title(input.title), ...(input.document === undefined ? {} : { document: document(input.document) }) }));
    } catch (error) { mapStoreError(error); }
  }));
  router.get("/:id/revisions", catchHandler(async (req, res) => {
    try { res.json({ revisions: await scoped().listWhiteboardRevisions(id(req.params.id)) }); }
    catch (error) { mapStoreError(error); }
  }));
  router.post("/:id/revisions/:revision/restore", catchHandler(async (req, res) => {
    const input = body(req);
    try { res.json(await scoped().restoreWhiteboardRevision(id(req.params.id), { revision: revision(req.params.revision, "revision"), expectedRevision: revision(input.expectedRevision) })); }
    catch (error) { mapStoreError(error); }
  }));
  router.get("/:id", catchHandler(async (req, res) => {
    const whiteboard = await scoped().getWhiteboard(id(req.params.id));
    if (!whiteboard) throw notFound("Whiteboard not found");
    res.json(whiteboard);
  }));
  router.patch("/:id", catchHandler(async (req, res) => {
    const input = body(req);
    try { res.json(await scoped().renameWhiteboard(id(req.params.id), { title: title(input.title), expectedRevision: revision(input.expectedRevision) })); }
    catch (error) { mapStoreError(error); }
  }));
  router.put("/:id", catchHandler(async (req, res) => {
    const input = body(req);
    try { res.json(await scoped().saveWhiteboard(id(req.params.id), { document: document(input.document), expectedRevision: revision(input.expectedRevision) })); }
    catch (error) { mapStoreError(error); }
  }));
  router.delete("/:id", catchHandler(async (req, res) => {
    try { await scoped().deleteWhiteboard(id(req.params.id), revision(req.query.expectedRevision)); res.status(204).end(); }
    catch (error) { mapStoreError(error); }
  }));
  return router;
}
