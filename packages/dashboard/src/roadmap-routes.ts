import { Router, type Request, type Response } from "express";
import { getCreateAiSessionFactory, type PluginContext, type TaskStore } from "@fusion/core";
import { createRoadmapPluginRoutes } from "@fusion-plugin-examples/roadmap";
import { getOrCreateProjectStore } from "./project-store-resolver.js";

function asQueryRecord(query: Request["query"]): Record<string, string | string[] | undefined> {
  return query as Record<string, string | string[] | undefined>;
}

function resolveProjectId(req: Request): string | undefined {
  const queryProjectId = req.query.projectId;
  if (typeof queryProjectId === "string" && queryProjectId.trim()) return queryProjectId;
  if (req.body && typeof req.body === "object") {
    const bodyProjectId = (req.body as { projectId?: unknown }).projectId;
    if (typeof bodyProjectId === "string" && bodyProjectId.trim()) return bodyProjectId;
  }
  return undefined;
}

export function createRoadmapCompatibilityRouter(defaultTaskStore: TaskStore): Router {
  const router = Router();
  const routes = createRoadmapPluginRoutes();

  for (const route of routes) {
    if (!route.path.startsWith("/roadmaps")) continue;

    const handler = async (req: Request, res: Response): Promise<void> => {
      const projectId = resolveProjectId(req);
      const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : null;
      const taskStore = scopedStore ?? defaultTaskStore;
      const createAiSession = await getCreateAiSessionFactory();

      const ctx: PluginContext = {
        pluginId: "fusion-plugin-roadmap",
        taskStore,
        settings: {},
        logger: console,
        emitEvent: () => {},
        createAiSession,
        resolveProjectTaskStore: getOrCreateProjectStore,
      };

      const result = await route.handler({ params: req.params as Record<string, string>, query: asQueryRecord(req.query), body: req.body }, ctx);

      if (result && typeof result === "object" && "status" in (result as Record<string, unknown>) && typeof (result as { status?: unknown }).status === "number") {
        const response = result as { status: number; body?: unknown; headers?: Record<string, string>; contentType?: string };
        if (response.headers) {
          for (const [name, value] of Object.entries(response.headers)) {
            res.setHeader(name, value);
          }
        }
        if (response.contentType) res.setHeader("Content-Type", response.contentType);
        if (response.status === 204) {
          res.status(204).send();
          return;
        }
        if (response.body === undefined) {
          res.status(response.status).send();
          return;
        }
        res.status(response.status).json(response.body);
        return;
      }

      res.status(200).json(result);
    };

    switch (route.method) {
      case "GET":
        router.get(route.path, handler);
        break;
      case "POST":
        router.post(route.path, handler);
        break;
      case "PUT":
        router.put(route.path, handler);
        break;
      case "PATCH":
        router.patch(route.path, handler);
        break;
      case "DELETE":
        router.delete(route.path, handler);
        break;
    }
  }

  return router;
}
