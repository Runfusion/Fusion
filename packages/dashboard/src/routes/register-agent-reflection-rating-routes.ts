import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import * as engineModule from "@fusion/engine";

type EngineAgentReflectionService = typeof engineModule extends {
  AgentReflectionService: infer T;
}
  ? T
  : never;

let AgentReflectionServiceBinding: EngineAgentReflectionService | undefined =
  "AgentReflectionService" in engineModule && typeof engineModule.AgentReflectionService === "function"
    ? (engineModule.AgentReflectionService as EngineAgentReflectionService)
    : undefined;

/** @internal test hook for reflection-service-unavailable branches. */
export function __setAgentReflectionServiceForTests(service: EngineAgentReflectionService | undefined): void {
  AgentReflectionServiceBinding = service;
}

export function registerAgentReflectionRatingRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  /**
   * GET /api/agents/:id/reflections/latest
   * Fetch the most recent reflection for an agent.
   * Must be registered before /agents/:id/reflections to avoid matching "latest" as a limit.
   * Response 200: AgentReflection | null — The most recent reflection or null
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   *             { error: "No reflections found" } — When agent has no reflections
   */
  router.get("/agents/:id/reflections/latest", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const reflection = await reflectionStore.getLatestReflection(agentId);
      if (!reflection) {
        throw notFound("No reflections found");
      }

      res.json(reflection);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/reflections
   * List reflection history for an agent.
   * Query params: limit (optional, default 50)
   * Response 200: AgentReflection[] — Array of reflections
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   */
  router.get("/agents/:id/reflections", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Parse limit from query params (default 50)
      const limitParam = req.query.limit;
      const limit = limitParam ? parseInt(String(limitParam), 10) : 50;

      const reflections = await reflectionStore.getReflections(agentId, limit);
      res.json(reflections);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/reflections
   * Trigger a manual reflection for an agent.
   * Response 201: AgentReflection — The created reflection
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   * Response 500: { error: message } — When reflection generation fails
   */
  router.post("/agents/:id/reflections", async (req, res) => {
    try {
      const { store: taskStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir(), asyncLayer: taskStore.getAsyncLayer() ?? undefined });
      const reflectionStore = new ReflectionStore({ rootDir: taskStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const AgentReflectionService = AgentReflectionServiceBinding;
      if (!AgentReflectionService) {
        res.status(503).json({ error: "Reflection service not available" });
        return;
      }

      // Create the reflection service and generate a reflection
      const reflectionService = new AgentReflectionService({
        agentStore,
        taskStore,
        reflectionStore,
        rootDir: taskStore.getRootDir(),
      });

      const reflection = await reflectionService.generateReflection(agentId, "manual");
      if (!reflection) {
        throw internalError("Unable to generate reflection — insufficient history or AI unavailable");
      }

      res.status(201).json(reflection);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/performance
   * Get aggregated performance summary for an agent.
   * Query params: windowMs (optional, default 7 days)
   * Response 200: AgentPerformanceSummary
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   */
  router.get("/agents/:id/performance", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      const reflectionStore = new ReflectionStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      // Parse windowMs from query params (default 7 days)
      const windowMsParam = req.query.windowMs;
      const windowMs = windowMsParam ? parseInt(String(windowMsParam), 10) : undefined;

      const summary = await reflectionStore.getPerformanceSummary(agentId, { windowMs });
      res.json(summary);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/reflection-context
   * Get raw context for debugging agent reflections.
   * Response 200: { context: object } — The built reflection context
   * Response 404: { error: "Agent not found" } — When agent doesn't exist
   * Response 503: { error: "Reflection service not available" } — When engine not initialized
   */
  router.get("/agents/:id/reflection-context", async (req, res) => {
    try {
      const { store: taskStore } = await getProjectContext(req);
      const { AgentStore, ReflectionStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir(), asyncLayer: taskStore.getAsyncLayer() ?? undefined });
      const reflectionStore = new ReflectionStore({ rootDir: taskStore.getFusionDir() });
      await agentStore.init();
      await reflectionStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the agent exists
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const AgentReflectionService = AgentReflectionServiceBinding;
      if (!AgentReflectionService) {
        res.status(503).json({ error: "Reflection service not available" });
        return;
      }

      // Create the service and build the context
      const reflectionService = new AgentReflectionService({
        agentStore,
        taskStore,
        reflectionStore,
        rootDir: taskStore.getRootDir(),
      });

      const context = await reflectionService.buildReflectionContext(agentId);
      res.json({ context });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Rating Routes ─────────────────────────────────────────────────

  /**
   * GET /api/agents/:id/ratings
   * Fetch ratings for an agent.
   * Query params: limit (number, default 50), category (string, optional)
   * Response 200: AgentRating[]
   */
  router.get("/agents/:id/ratings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
      const category = typeof req.query.category === "string" ? req.query.category : undefined;

      const ratings = await agentStore.getRatings(req.params.id, { limit, category });
      res.json(ratings);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/ratings
   * Add a rating for an agent.
   * Body: { score: number, category?: string, comment?: string, runId?: string, taskId?: string, raterType?: string }
   * Response 201: AgentRating — The created rating
   * Response 400: { error: "score is required" } — When score is missing
   *             { error: "score must be a number between 1 and 5" } — When score is invalid
   */
  router.post("/agents/:id/ratings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const { score, category, comment, runId, taskId, raterType } = req.body || {};

      // Validate score
      if (score === undefined || score === null) {
        throw badRequest("score is required");
      }
      if (typeof score !== "number" || !Number.isFinite(score) || score < 1 || score > 5) {
        throw badRequest("score must be a number between 1 and 5");
      }

      // Default raterType to "user" if not provided
      const resolvedRaterType = raterType || "user";

      const rating = await agentStore.addRating(req.params.id, {
        score,
        category,
        comment,
        runId,
        taskId,
        raterType: resolvedRaterType,
      });

      res.status(201).json(rating);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/ratings/summary
   * Fetch rating summary for an agent.
   * Response 200: AgentRatingSummary
   */
  router.get("/agents/:id/ratings/summary", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const summary = await agentStore.getRatingSummary(req.params.id);
      res.json(summary);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/agents/:id/ratings/:ratingId
   * Delete a specific rating.
   * Response 204: No Content
   */
  router.delete("/agents/:id/ratings/:ratingId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      await agentStore.deleteRating(req.params.ratingId);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // ── Agent Generation Routes ──────────────────────────────────────────────


}
