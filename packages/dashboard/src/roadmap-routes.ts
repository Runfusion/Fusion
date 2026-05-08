import { Router, type Request, type Response } from "express";
import { createRequire } from "node:module";
import { getCreateAiSessionFactory, type PluginContext, type PluginRouteDefinition, type TaskStore } from "@fusion/core";

const require = createRequire(import.meta.url);
const { createRoadmapPluginRoutes } = require("../../../plugins/fusion-plugin-roadmap/src/routes/roadmap-routes.js") as {
  createRoadmapPluginRoutes: () => PluginRouteDefinition[];
};

function isRouteResponse(value: unknown): value is { status: number; body?: unknown } {
  return (
    typeof value === "object"
    && value !== null
    && "status" in value
    && typeof (value as { status?: unknown }).status === "number"
  );
}

async function buildContext(store: TaskStore): Promise<PluginContext> {
  const createAiSession = await getCreateAiSessionFactory();

  return {
    pluginId: "fusion-plugin-roadmap",
    taskStore: store,
    settings: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    emitEvent: () => {},
    createAiSession,
  };
}

export function createRoadmapRouter(store: TaskStore): Router {
  const router = Router();
  const routes = createRoadmapPluginRoutes();

  for (const route of routes) {
    const handler = async (req: Request, res: Response) => {
      const result = await route.handler(req, await buildContext(store));
      if (isRouteResponse(result)) {
        if (result.status === 204) {
          res.status(204).send();
          return;
        }
        if (result.body === undefined) {
          res.status(result.status).send();
          return;
        }
        res.status(result.status).json(result.body);
        return;
      }
      res.status(200).json(result);
    };

    registerRoute(router, route, handler, normalizeLegacyRoadmapPath(route.path));
  }

  return router;
}

function normalizeLegacyRoadmapPath(path: string): string {
  if (path === "/roadmaps") return "/";
  if (path.startsWith("/roadmaps/")) return path.slice("/roadmaps".length);
  return path;
}

function registerRoute(
  router: Router,
  route: PluginRouteDefinition,
  handler: (req: Request, res: Response) => Promise<void>,
  normalizedPath: string,
): void {
  switch (route.method) {
    case "GET":
      router.get(normalizedPath, handler);
      break;
    case "POST":
      router.post(normalizedPath, handler);
      break;
    case "PUT":
      router.put(normalizedPath, handler);
      break;
    case "PATCH":
      router.patch(normalizedPath, handler);
      break;
    case "DELETE":
      router.delete(normalizedPath, handler);
      break;
  }
}

export { createRoadmapPluginRoutes };
