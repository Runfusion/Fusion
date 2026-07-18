import { AsyncLocalStorage } from "node:async_hooks";
import { Router } from "express";
import type { TaskStore } from "@fusion/core";
import type { ServerOptions } from "./server.js";
import { badRequest, catchHandler, notFound } from "./api-error.js";
import { getScopedStore as resolveScopedRequestStore } from "./routes/context.js";

/*
FNXC:Ideation 2026-07-30-15:30:
The human dashboard route delegates every operation to TaskStore's one persisted
ideation store. Convergence therefore shares the same atomic Mission handoff as
the engine tools instead of becoming a weaker UI-only persistence path.
*/
export function createIdeationRouter(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();
  const ideation = () => (requestContext.getStore() ?? store).getIdeationStore();

  router.use(async (req, _res, next) => {
    try { requestContext.run(await resolveScopedRequestStore(req, store, options), next); }
    catch (error) { next(error); }
  });

  router.get("/", catchHandler(async (_req, res) => res.json(await ideation().listSessions())));
  router.get("/:id", catchHandler(async (req, res) => {
    const session = await ideation().getSessionWithCandidates(String(req.params.id));
    if (!session) throw notFound("Ideation session not found");
    res.json(session);
  }));
  router.post("/", catchHandler(async (req, res) => {
    const { title, prompt } = req.body ?? {};
    if (typeof title !== "string") throw badRequest("title must be a non-empty string");
    if (prompt !== undefined && typeof prompt !== "string") throw badRequest("prompt must be a string");
    res.status(201).json(await ideation().createSession({ title, prompt }));
  }));
  router.post("/:id/candidates", catchHandler(async (req, res) => {
    const { content, origin, sourceRef } = req.body ?? {};
    if (typeof content !== "string" || !["agent", "human", "research"].includes(origin)) throw badRequest("content and a valid origin are required");
    if (sourceRef !== undefined && typeof sourceRef !== "string") throw badRequest("sourceRef must be a string");
    res.status(201).json(await ideation().addCandidate(String(req.params.id), { content, origin, sourceRef }));
  }));
  router.post("/:id/converge", catchHandler(async (req, res) => {
    const { candidateId, targetMissionId, targetFeatureId } = req.body ?? {};
    if (typeof candidateId !== "string") throw badRequest("candidateId is required");
    if (targetMissionId !== undefined && typeof targetMissionId !== "string") throw badRequest("targetMissionId must be a string");
    if (targetFeatureId !== undefined && typeof targetFeatureId !== "string") throw badRequest("targetFeatureId must be a string");
    res.json(await ideation().convergeSession(String(req.params.id), candidateId, { targetMissionId, targetFeatureId }));
  }));
  return router;
}
