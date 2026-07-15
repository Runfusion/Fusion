import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";

interface RouteRequest {
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
import { RoadmapStore } from "../store/roadmap-store.js";
import { AsyncRoadmapStore } from "../store/async-roadmap-store.js";
import {
  generateFeatureSuggestions,
  generateMilestoneSuggestions,
  SUGGESTION_TIMEOUT_MS,
  ParseError as SuggestionParseError,
  ServiceUnavailableError as SuggestionServiceUnavailableError,
  validateFeatureSuggestionInput,
  validateSuggestionInput,
  ValidationError as SuggestionValidationError,
} from "./roadmap-suggestions.js";

type RoadmapRuntimeStore = RoadmapStore | AsyncRoadmapStore;
const roadmapStoreCache = new WeakMap<object, RoadmapRuntimeStore>();

function resolveProjectId(req: RouteRequest): string | undefined {
  const queryProjectId = paramValue(req.query?.projectId);
  if (queryProjectId.trim()) return queryProjectId.trim();
  const bodyProjectId = req.body && typeof req.body === "object"
    ? (req.body as { projectId?: unknown }).projectId
    : undefined;
  if (typeof bodyProjectId === "string" && bodyProjectId.trim()) return bodyProjectId.trim();
  return undefined;
}

async function getRoadmapStore(req: RouteRequest, ctx: PluginContext): Promise<RoadmapRuntimeStore> {
  const projectId = resolveProjectId(req);
  const scopedTaskStore = projectId && ctx.resolveProjectTaskStore
    ? await ctx.resolveProjectTaskStore(projectId)
    : ctx.taskStore;

  const taskStoreWithRoadmaps = scopedTaskStore as PluginContext["taskStore"] & {
    getRoadmapStore?: () => RoadmapStore;
  };

  if (typeof taskStoreWithRoadmaps.getRoadmapStore === "function") {
    return taskStoreWithRoadmaps.getRoadmapStore();
  }

  const key = scopedTaskStore as object;
  const cached = roadmapStoreCache.get(key);
  if (cached) return cached;
  const layer = scopedTaskStore.getAsyncLayer();
  if (!layer) throw new Error("Roadmap plugin routes require the project PostgreSQL AsyncDataLayer");
  /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Bundled roadmap routes use only their project-scoped PostgreSQL store. */
  const store = new AsyncRoadmapStore(layer);
  roadmapStoreCache.set(key, store);
  return store;
}

function asRequest(req: unknown): RouteRequest {
  return req as RouteRequest;
}

function paramValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function badRequest(message: string): PluginRouteResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message: string): PluginRouteResponse {
  return { status: 404, body: { error: message } };
}

function serverError(message: string): PluginRouteResponse {
  return { status: 500, body: { error: message } };
}

function noContent(): PluginRouteResponse {
  return { status: 204 };
}

function routeHandler<T>(handler: (req: RouteRequest, ctx: PluginContext, roadmapStore: RoadmapRuntimeStore) => Promise<T | PluginRouteResponse> | T | PluginRouteResponse) {
  return async (req: unknown, ctx: PluginContext): Promise<T | PluginRouteResponse> => {
    const routeRequest = asRequest(req);
    const roadmapStore = await getRoadmapStore(routeRequest, ctx);
    try {
      return await handler(routeRequest, ctx, roadmapStore);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        return notFound(error.message);
      }
      return serverError(error instanceof Error ? error.message : "Internal server error");
    }
  };
}

function validateTitle(title: unknown): string {
  if (!title || typeof title !== "string" || !title.trim()) {
    throw new Error("title is required");
  }
  if (title.length > 200) {
    throw new Error("title must not exceed 200 characters");
  }
  return title.trim();
}

function validateDescription(desc: unknown): string | undefined {
  if (desc === undefined || desc === null) return undefined;
  if (typeof desc !== "string") {
    throw new Error("description must be a string");
  }
  if (desc.length > 5000) {
    throw new Error("description must not exceed 5000 characters");
  }
  return desc.trim() || undefined;
}

function validateStringArray(arr: unknown, fieldName: string): string[] {
  if (!Array.isArray(arr)) {
    throw new Error(`${fieldName} must be an array`);
  }
  if (!arr.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return arr;
}

export function createRoadmapPluginRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/roadmaps",
      handler: routeHandler((_req, _ctx, roadmapStore) => roadmapStore.listRoadmaps()),
    },
    {
      method: "POST",
      path: "/roadmaps",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title: string; description?: string };
        try {
          return {
            status: 201,
            body: await roadmapStore.createRoadmap({
              title: validateTitle(body?.title),
              description: validateDescription(body?.description),
            }),
          };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    {
      method: "GET",
      path: "/roadmaps/:roadmapId",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const roadmap = await roadmapStore.getRoadmapWithHierarchy(paramValue(req.params.roadmapId));
        return roadmap ? roadmap : notFound(`Roadmap ${paramValue(req.params.roadmapId)} not found`);
      }),
    },
    {
      method: "PATCH",
      path: "/roadmaps/:roadmapId",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title?: string; description?: string };
        try {
          return await roadmapStore.updateRoadmap(paramValue(req.params.roadmapId), {
            title: body.title !== undefined ? validateTitle(body.title) : undefined,
            description: body.description !== undefined ? validateDescription(body.description) : undefined,
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    { method: "DELETE", path: "/roadmaps/:roadmapId", handler: routeHandler(async (req, _ctx, roadmapStore) => {
      await roadmapStore.deleteRoadmap(paramValue(req.params.roadmapId));
      return noContent();
    }) },
    {
      method: "POST",
      path: "/roadmaps/:roadmapId/milestones",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title: string; description?: string };
        try {
          return {
            status: 201,
            body: await roadmapStore.createMilestone(paramValue(req.params.roadmapId), {
              title: validateTitle(body?.title),
              description: validateDescription(body?.description),
            }),
          };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    {
      method: "POST",
      path: "/roadmaps/:roadmapId/milestones/reorder",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        try {
          const body = req.body as { orderedMilestoneIds: string[] };
          await roadmapStore.reorderMilestones({ roadmapId: paramValue(req.params.roadmapId), orderedMilestoneIds: validateStringArray(body?.orderedMilestoneIds, "orderedMilestoneIds") });
          return noContent();
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    {
      method: "PATCH",
      path: "/roadmaps/milestones/:milestoneId",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title?: string; description?: string };
        try {
          return await roadmapStore.updateMilestone(paramValue(req.params.milestoneId), {
            title: body.title !== undefined ? validateTitle(body.title) : undefined,
            description: body.description !== undefined ? validateDescription(body.description) : undefined,
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    { method: "DELETE", path: "/roadmaps/milestones/:milestoneId", handler: routeHandler(async (req, _ctx, roadmapStore) => {
      await roadmapStore.deleteMilestone(paramValue(req.params.milestoneId));
      return noContent();
    }) },
    {
      method: "POST",
      path: "/roadmaps/milestones/:milestoneId/features",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title: string; description?: string };
        try {
          return {
            status: 201,
            body: await roadmapStore.createFeature(paramValue(req.params.milestoneId), {
              title: validateTitle(body?.title),
              description: validateDescription(body?.description),
            }),
          };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    {
      method: "POST",
      path: "/roadmaps/milestones/:milestoneId/features/reorder",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        try {
          const body = req.body as { orderedFeatureIds: string[] };
          const milestone = await roadmapStore.getMilestone(paramValue(req.params.milestoneId));
          if (!milestone) return notFound(`Milestone ${paramValue(req.params.milestoneId)} not found`);
          await roadmapStore.reorderFeatures({ roadmapId: milestone.roadmapId, milestoneId: paramValue(req.params.milestoneId), orderedFeatureIds: validateStringArray(body?.orderedFeatureIds, "orderedFeatureIds") });
          return noContent();
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    {
      method: "PATCH",
      path: "/roadmaps/features/:featureId",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { title?: string; description?: string };
        try {
          return await roadmapStore.updateFeature(paramValue(req.params.featureId), {
            title: body.title !== undefined ? validateTitle(body.title) : undefined,
            description: body.description !== undefined ? validateDescription(body.description) : undefined,
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : "Invalid input");
        }
      }),
    },
    { method: "DELETE", path: "/roadmaps/features/:featureId", handler: routeHandler(async (req, _ctx, roadmapStore) => {
      await roadmapStore.deleteFeature(paramValue(req.params.featureId));
      return noContent();
    }) },
    {
      method: "POST",
      path: "/roadmaps/features/:featureId/move",
      handler: routeHandler(async (req, _ctx, roadmapStore) => {
        const body = req.body as { targetMilestoneId: string; targetIndex: number };
        if (!body?.targetMilestoneId) return badRequest("targetMilestoneId is required");
        if (typeof body.targetIndex !== "number") return badRequest("targetIndex must be a number");

        const feature = await roadmapStore.getFeature(paramValue(req.params.featureId));
        if (!feature) return notFound(`Feature ${paramValue(req.params.featureId)} not found`);
        const fromMilestone = await roadmapStore.getMilestone(feature.milestoneId);
        if (!fromMilestone) return notFound(`Source milestone ${feature.milestoneId} not found`);
        const toMilestone = await roadmapStore.getMilestone(body.targetMilestoneId);
        if (!toMilestone) return notFound(`Target milestone ${body.targetMilestoneId} not found`);

        await roadmapStore.moveFeature({
          roadmapId: fromMilestone.roadmapId,
          featureId: paramValue(req.params.featureId),
          fromMilestoneId: feature.milestoneId,
          toMilestoneId: body.targetMilestoneId,
          targetOrderIndex: body.targetIndex,
        });

        return noContent();
      }),
    },
    {
      method: "POST",
      path: "/roadmaps/:roadmapId/suggestions/milestones",
      handler: routeHandler(async (req, ctx, roadmapStore) => {
        const roadmap = await roadmapStore.getRoadmap(paramValue(req.params.roadmapId));
        if (!roadmap) return notFound(`Roadmap ${paramValue(req.params.roadmapId)} not found`);

        try {
          validateSuggestionInput(req.body);
        } catch (error) {
          if (error instanceof SuggestionValidationError) return badRequest(error.message);
          throw error;
        }

        try {
          const body = req.body as { goalPrompt: string; count?: number };
          const suggestions = await generateMilestoneSuggestions(
            body.goalPrompt,
            body.count,
            ctx.taskStore.getRootDir(),
            undefined,
            undefined,
            ctx.createAiSession,
          );
          return { suggestions };
        } catch (error) {
          if (error instanceof SuggestionParseError) return serverError(error.message);
          if (error instanceof SuggestionServiceUnavailableError) {
            return { status: 503, body: { error: error.message } };
          }
          throw error;
        }
      }),
    },
    {
      method: "POST",
      path: "/roadmaps/milestones/:milestoneId/suggestions/features",
      handler: routeHandler(async (req, ctx, roadmapStore) => {
        const milestone = await roadmapStore.getMilestone(paramValue(req.params.milestoneId));
        if (!milestone) return notFound(`Milestone ${paramValue(req.params.milestoneId)} not found`);
        const roadmap = await roadmapStore.getRoadmap(milestone.roadmapId);
        if (!roadmap) return notFound(`Roadmap ${milestone.roadmapId} not found`);

        try {
          validateFeatureSuggestionInput(req.body);
        } catch (error) {
          if (error instanceof SuggestionValidationError) return badRequest(error.message);
          throw error;
        }

        try {
          const body = req.body as { prompt?: string; count?: number };
          const suggestions = await generateFeatureSuggestions(
            {
              roadmapTitle: roadmap.title,
              roadmapDescription: roadmap.description,
              milestoneTitle: milestone.title,
              milestoneDescription: milestone.description,
              existingFeatureTitles: (await roadmapStore.listFeatures(milestone.id)).map((feature) => feature.title),
            },
            body.count,
            body.prompt,
            ctx.taskStore.getRootDir(),
            undefined,
            undefined,
            ctx.createAiSession,
          );
          return { suggestions };
        } catch (error) {
          if (error instanceof SuggestionParseError) return serverError(error.message);
          if (error instanceof SuggestionServiceUnavailableError) {
            return { status: 503, body: { error: error.message } };
          }
          throw error;
        }
      }),
    },
    {
      method: "GET",
      path: "/roadmaps/:roadmapId/export",
      handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getRoadmapExport(paramValue(req.params.roadmapId))),
    },
    {
      method: "GET",
      path: "/roadmaps/:roadmapId/handoff",
      handler: routeHandler(async (req, _ctx, roadmapStore) => ({
        mission: await roadmapStore.getMissionPlanningHandoff(paramValue(req.params.roadmapId)),
        features: await roadmapStore.listFeatureTaskPlanningHandoffs(paramValue(req.params.roadmapId)),
      })),
    },
    {
      method: "GET",
      path: "/roadmaps/:roadmapId/handoff/mission",
      handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getMissionPlanningHandoff(paramValue(req.params.roadmapId))),
    },
    {
      method: "GET",
      path: "/roadmaps/:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task",
      handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getRoadmapFeatureHandoff(paramValue(req.params.roadmapId), paramValue(req.params.milestoneId), paramValue(req.params.featureId))),
    },
  ];
}

export { SUGGESTION_TIMEOUT_MS };
