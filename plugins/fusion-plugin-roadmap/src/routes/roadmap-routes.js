import { RoadmapStore } from "../store/roadmap-store.js";
import { generateFeatureSuggestions, generateMilestoneSuggestions, SUGGESTION_TIMEOUT_MS, ParseError as SuggestionParseError, ServiceUnavailableError as SuggestionServiceUnavailableError, validateFeatureSuggestionInput, validateSuggestionInput, ValidationError as SuggestionValidationError, } from "./roadmap-suggestions.js";
const roadmapStoreCache = new WeakMap();
function getRoadmapStore(ctx) {
    const taskStoreWithRoadmaps = ctx.taskStore;
    if (typeof taskStoreWithRoadmaps.getRoadmapStore === "function") {
        return taskStoreWithRoadmaps.getRoadmapStore();
    }
    const key = ctx.taskStore;
    const cached = roadmapStoreCache.get(key);
    if (cached)
        return cached;
    const store = new RoadmapStore(ctx.taskStore.getDatabase());
    roadmapStoreCache.set(key, store);
    return store;
}
function asRequest(req) {
    return req;
}
function badRequest(message) {
    return { status: 400, body: { error: message } };
}
function notFound(message) {
    return { status: 404, body: { error: message } };
}
function serverError(message) {
    return { status: 500, body: { error: message } };
}
function noContent() {
    return { status: 204 };
}
function routeHandler(handler) {
    return async (req, ctx) => {
        const roadmapStore = getRoadmapStore(ctx);
        try {
            return await handler(asRequest(req), ctx, roadmapStore);
        }
        catch (error) {
            if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
                return notFound(error.message);
            }
            return serverError(error instanceof Error ? error.message : "Internal server error");
        }
    };
}
function validateTitle(title) {
    if (!title || typeof title !== "string" || !title.trim()) {
        throw new Error("title is required");
    }
    if (title.length > 200) {
        throw new Error("title must not exceed 200 characters");
    }
    return title.trim();
}
function validateDescription(desc) {
    if (desc === undefined || desc === null)
        return undefined;
    if (typeof desc !== "string") {
        throw new Error("description must be a string");
    }
    if (desc.length > 5000) {
        throw new Error("description must not exceed 5000 characters");
    }
    return desc.trim() || undefined;
}
function validateStringArray(arr, fieldName) {
    if (!Array.isArray(arr)) {
        throw new Error(`${fieldName} must be an array`);
    }
    if (!arr.every((item) => typeof item === "string")) {
        throw new Error(`${fieldName} must be an array of strings`);
    }
    return arr;
}
export function createRoadmapPluginRoutes() {
    return [
        {
            method: "GET",
            path: "/roadmaps",
            handler: routeHandler((_req, _ctx, roadmapStore) => roadmapStore.listRoadmaps()),
        },
        {
            method: "POST",
            path: "/roadmaps",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return {
                        status: 201,
                        body: roadmapStore.createRoadmap({
                            title: validateTitle(body?.title),
                            description: validateDescription(body?.description),
                        }),
                    };
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        {
            method: "GET",
            path: "/roadmaps/:roadmapId",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const roadmap = roadmapStore.getRoadmapWithHierarchy(req.params.roadmapId);
                return roadmap ? roadmap : notFound(`Roadmap ${req.params.roadmapId} not found`);
            }),
        },
        {
            method: "PATCH",
            path: "/roadmaps/:roadmapId",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return roadmapStore.updateRoadmap(req.params.roadmapId, {
                        title: body.title !== undefined ? validateTitle(body.title) : undefined,
                        description: body.description !== undefined ? validateDescription(body.description) : undefined,
                    });
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        { method: "DELETE", path: "/roadmaps/:roadmapId", handler: routeHandler((req, _ctx, roadmapStore) => {
                roadmapStore.deleteRoadmap(req.params.roadmapId);
                return noContent();
            }) },
        {
            method: "POST",
            path: "/roadmaps/:roadmapId/milestones",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return {
                        status: 201,
                        body: roadmapStore.createMilestone(req.params.roadmapId, {
                            title: validateTitle(body?.title),
                            description: validateDescription(body?.description),
                        }),
                    };
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        {
            method: "POST",
            path: "/roadmaps/:roadmapId/milestones/reorder",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                try {
                    const body = req.body;
                    roadmapStore.reorderMilestones({ roadmapId: req.params.roadmapId, orderedMilestoneIds: validateStringArray(body?.orderedMilestoneIds, "orderedMilestoneIds") });
                    return noContent();
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        {
            method: "PATCH",
            path: "/roadmaps/milestones/:milestoneId",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return roadmapStore.updateMilestone(req.params.milestoneId, {
                        title: body.title !== undefined ? validateTitle(body.title) : undefined,
                        description: body.description !== undefined ? validateDescription(body.description) : undefined,
                    });
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        { method: "DELETE", path: "/roadmaps/milestones/:milestoneId", handler: routeHandler((req, _ctx, roadmapStore) => {
                roadmapStore.deleteMilestone(req.params.milestoneId);
                return noContent();
            }) },
        {
            method: "POST",
            path: "/roadmaps/milestones/:milestoneId/features",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return {
                        status: 201,
                        body: roadmapStore.createFeature(req.params.milestoneId, {
                            title: validateTitle(body?.title),
                            description: validateDescription(body?.description),
                        }),
                    };
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        {
            method: "POST",
            path: "/roadmaps/milestones/:milestoneId/features/reorder",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                try {
                    const body = req.body;
                    const milestone = roadmapStore.getMilestone(req.params.milestoneId);
                    if (!milestone)
                        return notFound(`Milestone ${req.params.milestoneId} not found`);
                    roadmapStore.reorderFeatures({ roadmapId: milestone.roadmapId, milestoneId: req.params.milestoneId, orderedFeatureIds: validateStringArray(body?.orderedFeatureIds, "orderedFeatureIds") });
                    return noContent();
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        {
            method: "PATCH",
            path: "/roadmaps/features/:featureId",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                try {
                    return roadmapStore.updateFeature(req.params.featureId, {
                        title: body.title !== undefined ? validateTitle(body.title) : undefined,
                        description: body.description !== undefined ? validateDescription(body.description) : undefined,
                    });
                }
                catch (error) {
                    return badRequest(error instanceof Error ? error.message : "Invalid input");
                }
            }),
        },
        { method: "DELETE", path: "/roadmaps/features/:featureId", handler: routeHandler((req, _ctx, roadmapStore) => {
                roadmapStore.deleteFeature(req.params.featureId);
                return noContent();
            }) },
        {
            method: "POST",
            path: "/roadmaps/features/:featureId/move",
            handler: routeHandler((req, _ctx, roadmapStore) => {
                const body = req.body;
                if (!body?.targetMilestoneId)
                    return badRequest("targetMilestoneId is required");
                if (typeof body.targetIndex !== "number")
                    return badRequest("targetIndex must be a number");
                const feature = roadmapStore.getFeature(req.params.featureId);
                if (!feature)
                    return notFound(`Feature ${req.params.featureId} not found`);
                const fromMilestone = roadmapStore.getMilestone(feature.milestoneId);
                if (!fromMilestone)
                    return notFound(`Source milestone ${feature.milestoneId} not found`);
                const toMilestone = roadmapStore.getMilestone(body.targetMilestoneId);
                if (!toMilestone)
                    return notFound(`Target milestone ${body.targetMilestoneId} not found`);
                roadmapStore.moveFeature({
                    roadmapId: fromMilestone.roadmapId,
                    featureId: req.params.featureId,
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
                const roadmap = roadmapStore.getRoadmap(req.params.roadmapId);
                if (!roadmap)
                    return notFound(`Roadmap ${req.params.roadmapId} not found`);
                try {
                    validateSuggestionInput(req.body);
                }
                catch (error) {
                    if (error instanceof SuggestionValidationError)
                        return badRequest(error.message);
                    throw error;
                }
                try {
                    const body = req.body;
                    const suggestions = await generateMilestoneSuggestions(body.goalPrompt, body.count, ctx.taskStore.getRootDir(), undefined, undefined, ctx.createAiSession);
                    return { suggestions };
                }
                catch (error) {
                    if (error instanceof SuggestionParseError)
                        return serverError(error.message);
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
                const milestone = roadmapStore.getMilestone(req.params.milestoneId);
                if (!milestone)
                    return notFound(`Milestone ${req.params.milestoneId} not found`);
                const roadmap = roadmapStore.getRoadmap(milestone.roadmapId);
                if (!roadmap)
                    return notFound(`Roadmap ${milestone.roadmapId} not found`);
                try {
                    validateFeatureSuggestionInput(req.body);
                }
                catch (error) {
                    if (error instanceof SuggestionValidationError)
                        return badRequest(error.message);
                    throw error;
                }
                try {
                    const body = req.body;
                    const suggestions = await generateFeatureSuggestions({
                        roadmapTitle: roadmap.title,
                        roadmapDescription: roadmap.description,
                        milestoneTitle: milestone.title,
                        milestoneDescription: milestone.description,
                        existingFeatureTitles: roadmapStore.listFeatures(milestone.id).map((feature) => feature.title),
                    }, body.count, body.prompt, ctx.taskStore.getRootDir(), undefined, undefined, ctx.createAiSession);
                    return { suggestions };
                }
                catch (error) {
                    if (error instanceof SuggestionParseError)
                        return serverError(error.message);
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
            handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getRoadmapExport(req.params.roadmapId)),
        },
        {
            method: "GET",
            path: "/roadmaps/:roadmapId/handoff",
            handler: routeHandler((req, _ctx, roadmapStore) => ({
                mission: roadmapStore.getMissionPlanningHandoff(req.params.roadmapId),
                features: roadmapStore.listFeatureTaskPlanningHandoffs(req.params.roadmapId),
            })),
        },
        {
            method: "GET",
            path: "/roadmaps/:roadmapId/handoff/mission",
            handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getMissionPlanningHandoff(req.params.roadmapId)),
        },
        {
            method: "GET",
            path: "/roadmaps/:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task",
            handler: routeHandler((req, _ctx, roadmapStore) => roadmapStore.getRoadmapFeatureHandoff(req.params.roadmapId, req.params.milestoneId, req.params.featureId)),
        },
    ];
}
export { SUGGESTION_TIMEOUT_MS };
//# sourceMappingURL=roadmap-routes.js.map