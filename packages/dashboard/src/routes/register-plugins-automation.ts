import type { NextFunction, Request, Response } from "express";
import { AutomationStore, RoutineStore, isWebhookTrigger, resolvePluginEntryPath, type RoutineTriggerType, type ScheduleType } from "@fusion/core";
import { ApiError, badRequest, conflict, internalError, notFound } from "../api-error.js";
import { verifyWebhookSignature } from "../github-webhooks.js";
import { resolvePluginManifest } from "../plugin-routes.js";
import { isAbsolute, resolve } from "node:path";
import * as nodeFs from "node:fs";
import type { ApiRoutesContext } from "./types.js";
import { automationLiveRuns, createAutomationLiveRunCallbacks, createAutomationRunStreamHandlerFactory } from "./automation-live-run.js";
import { executeScheduleSteps, executeSingleCommand, validateAutomationSteps } from "./automation-step-execution.js";
import { BUNDLED_PLUGIN_RUNTIMES, extractBundledPluginId, resolveBundledPluginDirInDashboard } from "./plugin-bundled-runtimes.js";

export interface PluginsAutomationRouteDependencies {
  parseLastEventId(req: Request): number | undefined;
  replayBufferedSSE(res: Response, bufferedEvents: Array<{ id: number; event: string; data: string }>): boolean;
  getCreateFnAgent: () => typeof import("@fusion/engine").createFnAgent | undefined;
}

/*
FNXC:PluginsAutomationRoutes 2026-07-19-12:00:
Automation, routine, and plugin-management endpoints live in this registrar so routes.ts remains an orchestrator. Preserve registration order: Express parameter matching makes operation paths and the registry pass-through precedence-sensitive.
*/
export function registerPluginsAutomationRoutes(ctx: ApiRoutesContext, deps: PluginsAutomationRouteDependencies): void {
  const { router, options, parseScopeParam, resolveAutomationStore, resolveRoutineStore, resolveRoutineRunner, getScopedStore, getProjectContext, rethrowAsApiError, runtimeLogger } = ctx;
  const makeRunStreamHandler = createAutomationRunStreamHandlerFactory({ parseScopeParam, rethrowAsApiError, ...deps });
  // ── Automation / Scheduled Task Routes ────────────────────────────
  //
  // Scope-aware endpoints: Accept `scope=global|project` query param or body field.
  // - When scope=global: Operations target the global automation store
  // - When scope=project: Operations target project-scoped automations (filtered by scope)
  // - When scope is omitted: Legacy default behavior (global store, backward compatible)
  //
  // Error codes:
  // - 400: Invalid scope value or validation failure
  // - 404: Schedule not found
  // - 503: Automation store unavailable

  // GET /automations — list all scheduled tasks (optionally filtered by scope)
  router.get("/automations", async (req: Request, res: Response) => {
    // Return empty array when no store available (legacy backward-compatible behavior)
    if (!options?.automationStore) {
      return res.json([]);
    }

    try {
      const scope = parseScopeParam(req);
      const automationStore = resolveAutomationStore(req, scope);

      // Get all schedules and filter by scope if specified
      // When scope is omitted, return all schedules (legacy behavior)
      const allSchedules = await automationStore.listSchedules();
      if (scope) {
        const filteredSchedules = allSchedules.filter((s) => s.scope === scope);
        res.json(filteredSchedules);
      } else {
        res.json(allSchedules);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations — create a new schedule (with optional scope)
  router.post("/automations", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validation
      if (!name?.trim()) {
        throw badRequest("Name is required");
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      if (!hasSteps && !command?.trim()) {
        throw badRequest("Command is required when no steps are provided");
      }
      const validTypes = ["hourly", "daily", "weekly", "monthly", "custom", "every15Minutes", "every30Minutes", "every2Hours", "every6Hours", "every12Hours", "weekdays"];
      if (!scheduleType || !validTypes.includes(scheduleType)) {
        throw badRequest(`Invalid schedule type. Must be one of: ${validTypes.join(", ")}`);
      }
      if (scheduleType === "custom") {
        if (!cronExpression?.trim()) {
          throw badRequest("Cron expression is required for custom schedule type");
        }
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }
      // Validate steps if provided
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      // Determine scope for the new schedule
      // Default to "project" for backward compatibility when scope is omitted
      const scheduleScope = scope ?? "project";

      const schedule = await automationStore.createSchedule({
        name,
        description,
        scheduleType: scheduleType as ScheduleType,
        cronExpression,
        command: command ?? "",
        enabled,
        timeoutMs,
        steps: hasSteps ? steps : undefined,
        scope: scheduleScope,
      });
      res.status(201).json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // GET /automations/:id — get a single schedule
  router.get("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // PATCH /automations/:id — update a schedule
  router.patch("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      // by fetching it first (can't filter in update without scope support in store)
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const { name, description, scheduleType, cronExpression, command, enabled, timeoutMs, steps } = req.body;

      // Validate cron if switching to custom
      if (scheduleType === "custom" && cronExpression) {
        if (!AutomationStore.isValidCron(cronExpression)) {
          throw badRequest(`Invalid cron expression: "${cronExpression}"`);
        }
      }

      // Validate steps if provided
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const schedule = await automationStore.updateSchedule(id, {
        name,
        description,
        scheduleType,
        cronExpression,
        command,
        enabled,
        timeoutMs,
        steps: steps !== undefined ? steps : undefined,
      });
      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty") || (err instanceof Error ? err.message : String(err)).includes("Invalid cron")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // DELETE /automations/:id — delete a schedule
  router.delete("/automations/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const deleted = await automationStore.deleteSchedule(id);
      res.json(deleted);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/run — trigger a manual run
  router.post("/automations/:id/run", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);
    let liveRunId: string | undefined;

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      const liveRun = automationLiveRuns.start(schedule.id);
      liveRunId = liveRun.runId;
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      const startedAt = new Date().toISOString();
      const scopedStore = await getScopedStore(req);
      let result: import("@fusion/core").AutomationRunResult;

      if (schedule.steps && schedule.steps.length > 0) {
        // Multi-step execution
        result = await executeScheduleSteps(schedule, startedAt, scopedStore, liveCallbacks, deps.getCreateFnAgent);
      } else {
        // Legacy single-command execution
        // FNXC:Automations 2026-07-04-00:00:
        // FN-7537: command/backup runs (including the new in-process backup branch inside
        // executeSingleCommand) stream through the same onStep/onText live-run callbacks as every other
        // step type, so the live-output panel populates during the run (step-start immediately, output once
        // available) rather than only at the terminal `complete` event.
        liveCallbacks.onStep?.({ stepIndex: 0, stepId: "command", stepName: schedule.name, stepType: "command", status: "started" });
        result = await executeSingleCommand(schedule.command, schedule.timeoutMs, startedAt, scopedStore);
        liveCallbacks.onStep?.({ stepIndex: 0, stepId: "command", stepName: schedule.name, stepType: "command", status: "completed", success: result.success, error: result.error });
        if (result.output) liveCallbacks.onText?.(result.output);
      }

      // Record the result
      const updated = await automationStore.recordRun(schedule.id, result);
      automationLiveRuns.complete(liveRun.runId, result);
      res.json({ schedule: updated, result, liveRunId: liveRun.runId });
    } catch (err: unknown) {
      if (liveRunId) {
        automationLiveRuns.fail(liveRunId, err instanceof Error ? err.message : String(err));
      }
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * FNXC:AutomationLiveOutput 2026-07-07-08:30 (FN-7663, follow-up from FN-7652):
   * `/automations/:id/run/stream` and `/routines/:id/run/stream` are otherwise-identical SSE
   * endpoints layered over the same `AutomationLiveRunRegistry` (`automationLiveRuns`). Before
   * this consolidation, each route carried its own copy of the header/replay/subscribe/teardown
   * logic — the FN-7652 live-output fix had to be applied twice, and any future fix could drift
   * between the two copies. This single generic factory is parameterized ONLY by what actually
   * differs between the two routes (store resolver, entity getter, not-found message) so a fix
   * to the streaming behavior is written once and applies to both endpoints.
   */
  // GET /automations/:id/run/stream — stream live manual-run output.
  router.get(
    "/automations/:id/run/stream",
    makeRunStreamHandler({
      resolveStore: resolveAutomationStore,
      getEntity: (store, id) => store.getSchedule(id),
      notFoundMessage: "Schedule not found",
    }),
  );

  // POST /automations/:id/toggle — toggle enabled/disabled
  router.post("/automations/:id/toggle", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const schedule = await automationStore.getSchedule(id);

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope && schedule.scope !== scope) {
        throw notFound("Schedule not found");
      }

      const updated = await automationStore.updateSchedule(id, {
        enabled: !schedule.enabled,
      });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /automations/:id/steps/reorder — reorder steps
  router.post("/automations/:id/steps/reorder", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const automationStore = resolveAutomationStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the schedule belongs to that scope
      if (scope) {
        const existing = await automationStore.getSchedule(id);
        if (existing.scope !== scope) {
          throw notFound("Schedule not found");
        }
      }

      const { stepIds } = req.body;
      if (!Array.isArray(stepIds)) {
        throw badRequest("stepIds must be an array");
      }
      const schedule = await automationStore.reorderSteps(id, stepIds);
      res.json(schedule);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Schedule not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("mismatch") || (err instanceof Error ? err.message : String(err)).includes("Unknown step") || (err instanceof Error ? err.message : String(err)).includes("no steps")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // ── Routine Routes ──────────────────────────────────────────────────
  //
  // Scope-aware endpoints: Accept `scope=global|project` query param or body field.
  // - When scope=global: Operations target the global routine store
  // - When scope=project: Operations target project-scoped routines (filtered by scope)
  // - When scope is omitted: Legacy default behavior (global store, backward compatible)
  //
  // Error codes:
  // - 400: Invalid scope value or validation failure
  // - 401: Webhook signature verification failed
  // - 403: Webhook disabled/forbidden
  // - 404: Routine not found
  // - 503: Routine store or runner unavailable

  // GET /routines — list all routines (optionally filtered by scope)
  router.get("/routines", async (req: Request, res: Response) => {
    // Return empty array when no store available (legacy backward-compatible behavior)
    if (!options?.routineStore) {
      return res.json([]);
    }

    try {
      const scope = parseScopeParam(req);
      const routineStore = resolveRoutineStore(req, scope);

      // Get all routines and filter by scope if specified
      // When scope is omitted, return all routines (legacy behavior)
      const allRoutines = await routineStore.listRoutines();
      if (scope) {
        const filteredRoutines = allRoutines.filter((r) => r.scope === scope);
        res.json(filteredRoutines);
      } else {
        res.json(allRoutines);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines — create a new routine (with optional scope)
  router.post("/routines", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const { name, agentId, description, trigger, command, steps, timeoutMs, catchUpPolicy, executionPolicy, enabled } = req.body;

      // Validation
      if (!name?.trim()) {
        throw badRequest("Name is required");
      }
      if (!trigger) {
        throw badRequest("Trigger is required");
      }
      if (!trigger.type) {
        throw badRequest("Trigger must have a type field");
      }
      const validTriggerTypes: RoutineTriggerType[] = ["cron", "webhook", "api", "manual"];
      if (!validTriggerTypes.includes(trigger.type)) {
        throw badRequest(`Invalid trigger type. Must be one of: ${validTriggerTypes.join(", ")}`);
      }
      if (trigger.type === "cron") {
        if (!trigger.cronExpression?.trim()) {
          throw badRequest("Cron expression is required for cron trigger");
        }
        if (!RoutineStore.isValidCron(trigger.cronExpression)) {
          throw badRequest(`Invalid cron expression: "${trigger.cronExpression}"`);
        }
      }
      if (trigger.type === "webhook") {
        // Require an HMAC secret so the webhook endpoint authenticates callers
        // via signed payloads. Without this, anyone who can reach the server
        // and knows the routine id could trigger execution by sending an empty
        // POST to /routines/:id/webhook.
        if (typeof trigger.secret !== "string" || trigger.secret.trim().length < 16) {
          throw badRequest(
            "Webhook trigger requires a secret of at least 16 characters for HMAC signature verification",
          );
        }
      }
      const hasSteps = Array.isArray(steps) && steps.length > 0;
      const hasCommand = typeof command === "string" && command.trim().length > 0;
      if (hasSteps) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }
      if (catchUpPolicy !== undefined) {
        const validCatchUpPolicies: Array<"run" | "skip" | "run_one"> = ["run", "skip", "run_one"];
        if (!validCatchUpPolicies.includes(catchUpPolicy)) {
          throw badRequest(`Invalid catchUpPolicy. Must be one of: ${validCatchUpPolicies.join(", ")}`);
        }
      }
      if (executionPolicy !== undefined) {
        const validExecutionPolicies: Array<"parallel" | "queue" | "reject"> = ["parallel", "queue", "reject"];
        if (!validExecutionPolicies.includes(executionPolicy)) {
          throw badRequest(`Invalid executionPolicy. Must be one of: ${validExecutionPolicies.join(", ")}`);
        }
      }

      // Determine scope for the new routine
      // Default to "project" for backward compatibility when scope is omitted
      const routineScope = scope ?? "project";

      const routine = await routineStore.createRoutine({
        name: name.trim(),
        agentId: typeof agentId === "string" ? agentId.trim() : "",
        description,
        trigger,
        command: hasCommand ? command : undefined,
        steps: hasSteps ? steps : undefined,
        timeoutMs,
        catchUpPolicy,
        executionPolicy,
        enabled,
        scope: routineScope,
      });
      res.status(201).json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // GET /routines/:id — get a single routine
  router.get("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      res.json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // PATCH /routines/:id — update a routine
  router.patch("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope) {
        const existing = await routineStore.getRoutine(id);
        if (existing.scope !== scope) {
          throw notFound("Routine not found");
        }
      }

      const { name, description, trigger, command, steps, timeoutMs, catchUpPolicy, executionPolicy, enabled } = req.body;

      // Validate name if provided
      if (name !== undefined && !name.trim()) {
        throw badRequest("Name cannot be empty");
      }

      // Validate trigger if provided
      if (trigger !== undefined) {
        if (trigger.type) {
          const validTriggerTypes: RoutineTriggerType[] = ["cron", "webhook", "api", "manual"];
          if (!validTriggerTypes.includes(trigger.type)) {
            throw badRequest(`Invalid trigger type. Must be one of: ${validTriggerTypes.join(", ")}`);
          }
          if (trigger.type === "cron" && trigger.cronExpression) {
            if (!RoutineStore.isValidCron(trigger.cronExpression)) {
              throw badRequest(`Invalid cron expression: "${trigger.cronExpression}"`);
            }
          }
          if (trigger.type === "webhook") {
            if (typeof trigger.secret !== "string" || trigger.secret.trim().length < 16) {
              throw badRequest(
                "Webhook trigger requires a secret of at least 16 characters for HMAC signature verification",
              );
            }
          }
        }
      }
      if (Array.isArray(steps) && steps.length > 0) {
        const stepErr = validateAutomationSteps(steps);
        if (stepErr) {
          throw badRequest(stepErr);
        }
      }

      const routine = await routineStore.updateRoutine(id, {
        name: name !== undefined ? name.trim() : undefined,
        description,
        trigger,
        command: command !== undefined ? command : undefined,
        steps: steps !== undefined ? steps : undefined,
        timeoutMs,
        catchUpPolicy,
        executionPolicy,
        enabled,
      });
      res.json(routine);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty") || (err instanceof Error ? err.message : String(err)).includes("Invalid cron")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // DELETE /routines/:id — delete a routine
  router.delete("/routines/:id", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope) {
        const existing = await routineStore.getRoutine(id);
        if (existing.scope !== scope) {
          throw notFound("Routine not found");
        }
      }

      const deleted = await routineStore.deleteRoutine(id);
      res.json(deleted);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/run — manual trigger (backward-compatible alias for /trigger)
  router.post("/routines/:id/run", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);
    const routineRunner = resolveRoutineRunner(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      const liveRun = automationLiveRuns.start(routine.id);
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      try {
        // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
        const result = await routineRunner.triggerManual(id, liveCallbacks);
        const updated = await routineStore.getRoutine(id);
        automationLiveRuns.complete(liveRun.runId, result);
        res.json({ routine: updated, result, liveRunId: liveRun.runId });
      } catch (err) {
        automationLiveRuns.fail(liveRun.runId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/trigger — canonical manual trigger (uses RoutineRunner)
  // POST /routines/:id/run is a backward-compatible alias with identical behavior
  router.post("/routines/:id/trigger", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);
    const routineRunner = resolveRoutineRunner(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      const liveRun = automationLiveRuns.start(routine.id);
      const liveCallbacks = createAutomationLiveRunCallbacks(liveRun.runId);
      try {
        // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
        const result = await routineRunner.triggerManual(id, liveCallbacks);
        const updated = await routineStore.getRoutine(id);
        automationLiveRuns.complete(liveRun.runId, result);
        res.json({ routine: updated, result, liveRunId: liveRun.runId });
      } catch (err) {
        automationLiveRuns.fail(liveRun.runId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // GET /routines/:id/run/stream — stream live manual routine output.
  router.get(
    "/routines/:id/run/stream",
    makeRunStreamHandler({
      resolveStore: resolveRoutineStore,
      getEntity: (store, id) => store.getRoutine(id),
      notFoundMessage: "Routine not found",
    }),
  );

  // GET /routines/:id/runs — get execution history
  router.get("/routines/:id/runs", async (req: Request, res: Response) => {
    const scope = parseScopeParam(req);
    const routineStore = resolveRoutineStore(req, scope);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Scope isolation: if scope is specified, verify the routine belongs to that scope
      if (scope && routine.scope !== scope) {
        throw notFound("Routine not found");
      }

      res.json(routine.runHistory);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });

  // POST /routines/:id/webhook — incoming webhook trigger
  // Note: Webhook routes do NOT use scope params from the request - webhooks are triggered
  // externally and the routine's own scope determines which store to use.
  // The webhook URL should include the scope implicitly via the routine ID.
  router.post("/routines/:id/webhook", async (req: Request, res: Response) => {
    // Webhook triggers don't accept scope params from the request
    // The routine's scope field determines which store to use
    const routineStore = resolveRoutineStore(req, undefined);
    const routineRunner = resolveRoutineRunner(req, undefined);

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const routine = await routineStore.getRoutine(id);

      // Validate this is a webhook-type routine
      if (!isWebhookTrigger(routine.trigger)) {
        throw badRequest("Routine is not configured for webhook triggers");
      }

      // Validate routine is enabled
      if (!routine.enabled) {
        throw badRequest("Routine is disabled");
      }

      // Get raw body for HMAC verification
      const rawBody = req.rawBody;
      const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;

      // A webhook routine without a secret is treated as a misconfiguration
      // and refused. New routines require a secret at create time (see POST
      // /routines), but legacy routines persisted before that validation was
      // added could still reach this branch without one.
      if (!routine.trigger.secret) {
        throw new ApiError(
          401,
          "Webhook trigger is not configured with a secret; set routine.trigger.secret before use",
        );
      }
      if (!rawBody) {
        throw badRequest("Raw body not available for signature verification");
      }
      if (!signatureHeader) {
        throw new ApiError(401, "Missing signature header");
      }
      const verification = verifyWebhookSignature(rawBody, signatureHeader, routine.trigger.secret);
      if (!verification.valid) {
        throw new ApiError(401, verification.error ?? "Invalid signature");
      }

      // Execute via RoutineRunner (persistence handled by RoutineRunner.completeRoutineExecution)
      const payload = req.body;
      const result = await routineRunner.triggerWebhook(id, payload, signatureHeader);
      const updated = await routineStore.getRoutine(id);
      res.json({ routine: updated, result });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Routine not found");
      }
      rethrowAsApiError(err);
    }
  });


  // ── Plugin Routes ─────────────────────────────────────────────────────────
  // Plugin management endpoints with projectId scoping support.
  // Uses getScopedStore(req) pattern for multi-project support.
  // Requires pluginStore in options.

  /**
   * GET /api/plugins
   * List all installed plugins.
   * Query: { projectId?: string, enabled?: boolean }
   */
  router.get("/plugins", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();

    const filter: { enabled?: boolean } = {};
    if (req.query.enabled !== undefined) {
      filter.enabled = req.query.enabled === "true";
    }

    const plugins = await pluginStore.listPlugins(filter);
    res.json(plugins);
  });

  /**
   * GET /api/plugins/ui-slots
   * Get all UI slot definitions from active plugins.
   * Returns aggregated array of { pluginId, slot } objects.
   */
  router.get("/plugins/ui-slots", async (_req: Request, res: Response) => {
    const slots = options?.pluginLoader?.getPluginUiSlots() ?? [];
    const normalizedSlots = slots
      .map((entry) => ({
        pluginId: entry.pluginId,
        slot: {
          ...entry.slot,
          surface: entry.slot.surface ?? (typeof entry.slot.slotId === "string" ? entry.slot.slotId : undefined),
          order: entry.slot.order ?? null,
        },
      }))
      .sort((a, b) => {
        const orderA = typeof a.slot.order === "number" ? a.slot.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.slot.order === "number" ? b.slot.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
        return String(a.slot.slotId).localeCompare(String(b.slot.slotId));
      });
    res.json(normalizedSlots);
  });

  /**
   * GET /api/plugins/ui-contributions
   * Get all structured UI contributions from active plugins.
   */
  router.get("/plugins/ui-contributions", async (_req: Request, res: Response) => {
    const contributions = options?.pluginLoader?.getPluginUiContributions() ?? [];
    const normalizedContributions = contributions
      .map((entry) => ({
        pluginId: entry.pluginId,
        contribution: {
          ...entry.contribution,
          order: entry.contribution.order ?? null,
        },
      }))
      .sort((a, b) => {
        const orderA = typeof a.contribution.order === "number" ? a.contribution.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.contribution.order === "number" ? b.contribution.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        if (a.pluginId !== b.pluginId) return a.pluginId.localeCompare(b.pluginId);
        return a.contribution.contributionId.localeCompare(b.contribution.contributionId);
      });
    res.json(normalizedContributions);
  });


  /**
   * GET /api/plugins/dashboard-views
   * Get all plugin top-level dashboard view definitions from active plugins.
   * Returns aggregated array of { pluginId, view } objects.
   */
  /*
  FNXC:PluginNavigation 2026-07-19-17:01:
  Dashboard views are a loaded-plugin contract scoped to the requested project. Never use the
  launch project's fallback loader for an explicit project id: doing so leaks enabled Compound
  Engineering navigation from project A into project B while B's loader is still absent or empty.
  */
  router.get("/plugins/dashboard-views", async (req: Request, res: Response) => {
    const { engine, projectId } = await getProjectContext(req);
    const pluginLoader = engine?.getPluginRunner?.()?.getLoader()
      ?? (projectId === undefined ? options?.pluginLoader : undefined);
    const views = await pluginLoader?.getPluginDashboardViews() ?? [];
    res.json(views);
  });

  /**
   * GET /api/plugins/runtimes
   * Get all plugin runtime metadata from active plugins.
   * Returns aggregated array of { pluginId, runtimeId, name, description, version }.
   */
  router.get("/plugins/runtimes", async (_req: Request, res: Response) => {
    const runtimes = options?.pluginLoader?.getPluginRuntimes() ?? [];
    const installed = runtimes.map(({ pluginId, runtime }) => ({
      pluginId,
      runtimeId: runtime.metadata.runtimeId,
      name: runtime.metadata.name,
      description: runtime.metadata.description,
      version: runtime.metadata.version,
    }));
    const installedRuntimeIds = new Set(installed.map((r) => r.runtimeId));
    const bundledFallback = BUNDLED_PLUGIN_RUNTIMES.filter(
      (r) => !installedRuntimeIds.has(r.runtimeId),
    );
    res.json([...installed, ...bundledFallback]);
  });

  /**
   * GET /api/plugins/:id
   * Get a single plugin by ID.
   * Query: { projectId?: string }
   */
  router.get("/plugins/:id", async (req: Request, res: Response, next: NextFunction) => {
    // "registry" is a static sub-route (GET /plugins/registry) owned by the
    // plugin sub-router mounted further below. Because this generic ":id" route
    // is registered first, Express would otherwise match it for the literal
    // path "/plugins/registry" (id === "registry") and throw
    // 'Plugin "registry" not found', shadowing the real registry handler.
    // Fall through so the mounted sub-router can serve the registry listing.
    if (req.params.id === "registry") {
      next();
      return;
    }
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  });

  /**
   * GET /api/plugins/:id/settings
   * Get plugin settings by plugin ID.
   * Query: { projectId?: string }
   */
  router.get("/plugins/:id/settings", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    try {
      const plugin = await pluginStore.getPlugin(id);
      res.json(plugin.settings);
    } catch (err: unknown) {
      const isNotFoundError = err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found");
      const isBundledFallback = BUNDLED_PLUGIN_RUNTIMES.some((r) => r.pluginId === id);
      if (isNotFoundError && isBundledFallback) {
        // Bundled runtime plugins can be surfaced in settings before they've
        // been lazily installed. Return empty defaults so cards can open.
        res.json({});
        return;
      }
      if (isNotFoundError) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }
  });

  /**
   * POST /api/plugins
   * Create or register a plugin.
   * Requires `mode` discriminator in body:
   *   - mode: "register" → body must include { id, name, version, path }, optional { enabled, settings, projectId }
   *   - mode: "install" → body must include { path }, optional { projectId }
   * Returns 201 on success, 400 for validation errors, 409 for conflicts.
   */
  router.post("/plugins", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body is required");
    }

    const body = req.body as Record<string, unknown>;

    // Validate mode discriminator is present
    if (!("mode" in body) || typeof body.mode !== "string") {
      throw badRequest("Request body must have a 'mode' field with value 'register' or 'install'");
    }

    const mode = body.mode as string;

    if (mode === "register") {
      // Register mode: requires id, name, version, path
      if (typeof body.id !== "string" || !body.id.trim()) {
        throw badRequest("'id' is required for register mode and must be a non-empty string");
      }
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw badRequest("'name' is required for register mode and must be a non-empty string");
      }
      if (typeof body.version !== "string" || !body.version.trim()) {
        throw badRequest("'version' is required for register mode and must be a non-empty string");
      }
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw badRequest("'path' is required for register mode and must be a non-empty string");
      }

      const manifest: import("@fusion/core").PluginManifest = {
        id: body.id as string,
        name: body.name as string,
        version: body.version as string,
        description: typeof body.description === "string" ? body.description : undefined,
        author: typeof body.author === "string" ? body.author : undefined,
        homepage: typeof body.homepage === "string" ? body.homepage : undefined,
        dependencies: Array.isArray(body.dependencies) ? (body.dependencies as string[]) : undefined,
        settingsSchema: typeof body.settingsSchema === "object" && body.settingsSchema !== null
          ? (body.settingsSchema as Record<string, import("@fusion/core").PluginSettingSchema>)
          : undefined,
      };

      const settings = typeof body.settings === "object" && body.settings !== null
        ? (body.settings as Record<string, unknown>)
        : undefined;

      // If enabled and loader is available, try to load the plugin
      let plugin: import("@fusion/core").PluginInstallation;
      try {
        plugin = await pluginStore.registerPlugin({
          manifest,
          path: body.path as string,
          settings,
        });

        if (plugin.enabled && options?.pluginLoader) {
          try {
            await options.pluginLoader.loadPlugin(plugin.id);
          } catch (loadErr) {
            // Log but don't fail - plugin is registered, just not loaded
            runtimeLogger.child("plugin-routes").error(`Failed to load plugin ${plugin.id}`, {
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            });
          }
        }

        res.status(201).json(plugin);
      } catch (err: unknown) {
        if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("already registered")) {
          throw conflict(err instanceof Error ? err.message : String(err));
        }
        throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
      }
    } else if (mode === "install") {
      // Install mode: requires path, loads manifest from path
      // Supports package root and dist-folder selections via resolvePluginManifest
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw badRequest("'path' is required for install mode and must be a non-empty string");
      }

      // Check if runtime install interface is available
      if (!options?.pluginLoader) {
        throw badRequest("Plugin install mode is not supported: plugin loader not available");
      }

      const aiScanOnLoad = body.aiScanOnLoad;
      if (aiScanOnLoad !== undefined && typeof aiScanOnLoad !== "boolean") {
        throw badRequest("'aiScanOnLoad' must be a boolean when provided");
      }

      const requestPath = (body.path as string).trim();
      const absoluteRequestPath = isAbsolute(requestPath) ? requestPath : resolve(process.cwd(), requestPath);

      let manifestPathForInstall = absoluteRequestPath;
      let manifestResolutionError: ApiError | null = null;
      let attemptedBundledLookup = false;

      try {
        await resolvePluginManifest(manifestPathForInstall);
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          manifestResolutionError = err;
          const bundledPluginId = extractBundledPluginId(requestPath) ?? extractBundledPluginId(absoluteRequestPath);
          if (bundledPluginId) {
            attemptedBundledLookup = true;
            const bundledPath = resolveBundledPluginDirInDashboard(bundledPluginId);
            if (bundledPath) {
              manifestPathForInstall = bundledPath;
            }
          }
        } else {
          throw err;
        }
      }

      if (manifestResolutionError && manifestPathForInstall === absoluteRequestPath) {
        if (attemptedBundledLookup) {
          throw notFound(
            `Plugin install path not found: ${requestPath}. `
            + "Checked resolved local path and bundled plugin locations.",
          );
        }
        throw manifestResolutionError;
      }

      // Resolve manifest — supports package root and dist-folder selections
      const { manifestDir, manifest } = await resolvePluginManifest(manifestPathForInstall);

      // Register the loadable entry FILE, not the package directory — Node ESM
      // cannot import directories, so the loader rejects directory paths.
      const entryPath = resolvePluginEntryPath(manifestDir);
      if (!entryPath) {
        throw badRequest(
          `Plugin at ${manifestDir} has no loadable entry file `
          + "(expected bundled.js, dist/index.js, or src/index.ts)",
        );
      }

      try {
        const plugin = await pluginStore.registerPlugin({
          manifest,
          path: entryPath,
          ...(typeof aiScanOnLoad === "boolean" ? { aiScanOnLoad } : {}),
        });

        // If enabled, try to load it. If load fails while aiScanOnLoad=true,
        // remove the new registration so install does not leave a broken record.
        if (plugin.enabled) {
          try {
            await options.pluginLoader.loadPlugin(plugin.id);
          } catch (loadErr) {
            if (plugin.aiScanOnLoad) {
              await pluginStore.unregisterPlugin(plugin.id);
              throw badRequest(loadErr instanceof Error ? loadErr.message : String(loadErr));
            }
            runtimeLogger.child("plugin-routes").error(`Failed to load plugin ${plugin.id}`, {
              error: loadErr instanceof Error ? loadErr.message : String(loadErr),
            });
          }
        }

        res.status(201).json(plugin);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("already registered")) {
          throw conflict(err instanceof Error ? err.message : String(err));
        }
        throw internalError(err instanceof Error ? err.message : "Failed to register plugin");
      }
    } else {
      throw badRequest(`Invalid mode: '${mode}'. Must be 'register' or 'install'`);
    }
  });

  /**
   * POST /api/plugins/:id/enable
   * Enable a plugin and start it.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/enable", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin = await pluginStore.enablePlugin(id);

    // Heal legacy registrations that stored the package directory instead of
    // a loadable entry file (Node ESM cannot import directories). Mirrors the
    // CLI's startup heal in ensureBundledPluginInstalled.
    try {
      if (nodeFs.statSync(plugin.path).isDirectory()) {
        const entryPath = resolvePluginEntryPath(plugin.path);
        if (entryPath) {
          plugin = await pluginStore.updatePlugin(id, { path: entryPath });
        }
      }
    } catch {
      // Path missing or unreadable — let loadPlugin surface the real error.
    }

    // Start the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.loadPlugin(id);
      } catch (loadErr) {
        // Update state to error
        await pluginStore.updatePluginState(
          id,
          "error",
          loadErr instanceof Error ? loadErr.message : String(loadErr),
        );
        plugin = await pluginStore.getPlugin(id);
      }
    }

    res.json(plugin);
  });

  /**
   * POST /api/plugins/:id/disable
   * Disable a plugin and stop it.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/disable", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    // Stop the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.stopPlugin(id);
      } catch {
        // Ignore errors from stopping - plugin might not be loaded
      }
    }

    const plugin = await pluginStore.disablePlugin(id);
    res.json(plugin);
  });

  /**
   * POST /api/plugins/:id/reload
   * Reload a running plugin with updated code.
   * Body: { projectId?: string }
   */
  router.post("/plugins/:id/reload", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (plugin.state !== "started") {
      throw badRequest("Plugin is not currently loaded. Use enable instead.");
    }

    if (!options?.pluginRunner?.reloadPlugin) {
      throw internalError("Plugin runner not available");
    }

    try {
      await options.pluginRunner.reloadPlugin(id);
    } catch (reloadErr: unknown) {
      throw internalError(`Reload failed: ${reloadErr instanceof Error ? reloadErr.message : String(reloadErr)}`);
    }

    const updatedPlugin = await pluginStore.getPlugin(id);
    res.json(updatedPlugin);
  });

  /**
   * PATCH /api/plugins/:id
   * Update plugin config.
   * Body: { aiScanOnLoad: boolean }
   */
  router.patch("/plugins/:id", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object" || typeof (req.body as { aiScanOnLoad?: unknown }).aiScanOnLoad !== "boolean") {
      throw badRequest("Request body must be { aiScanOnLoad: boolean }");
    }

    try {
      const plugin = await pluginStore.updatePlugin(id, {
        aiScanOnLoad: (req.body as { aiScanOnLoad: boolean }).aiScanOnLoad,
      });
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update plugin");
    }
  });

  /**
   * POST /api/plugins/:id/rescan
   * Trigger a fresh plugin scan/load gate via reload or load flow.
   */
  router.post("/plugins/:id/rescan", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch {
      throw notFound(`Plugin "${id}" not found`);
    }

    if (!options?.pluginLoader) {
      throw internalError("Plugin loader not available");
    }

    try {
      if (plugin.state === "started" && options.pluginRunner?.reloadPlugin) {
        await options.pluginRunner.reloadPlugin(id);
      } else if (plugin.enabled) {
        await options.pluginLoader.loadPlugin(id);
      }
    } catch (reloadErr) {
      runtimeLogger.child("plugin-routes").error(`Failed to rescan plugin ${id}`, {
        error: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
      });
    }

    res.json(await pluginStore.getPlugin(id));
  });

  /**
   * GET /api/plugins/:id/setup-status
   * Check plugin setup status.
   */
  router.get("/plugins/:id/setup-status", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    let plugin: import("@fusion/core").PluginInstallation;
    try {
      plugin = await pluginStore.getPlugin(id);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      throw internalError(err instanceof Error ? err.message : "Unknown error");
    }

    if (!options?.pluginRunner?.checkPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const hasSetup = setupInfo.some((entry) => entry.pluginId === id);

    if (!hasSetup) {
      res.json({ hasSetup: false });
      return;
    }

    if (plugin.state !== "started") {
      res.json({
        hasSetup: true,
        setupCheckDeferred: true,
        deferredReason: "plugin-not-started",
        pluginState: plugin.state,
      });
      return;
    }

    const status = await options.pluginRunner.checkPluginSetup(id);
    res.json({ hasSetup: true, ...status });
  });

  /**
   * POST /api/plugins/:id/setup/install
   * Trigger plugin setup install hook.
   */
  router.post("/plugins/:id/setup/install", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    const plugin = await pluginStore.getPlugin(id);
    if (!plugin.enabled) {
      throw badRequest("Plugin must be enabled before setup install");
    }

    if (!options?.pluginRunner?.installPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup?.hooks.install) {
      throw badRequest("Plugin has no install hook");
    }

    const result = await options.pluginRunner.installPluginSetup(id);
    res.json(result ?? { success: true });
  });

  /**
   * POST /api/plugins/:id/setup/uninstall
   * Trigger plugin setup uninstall hook.
   */
  router.post("/plugins/:id/setup/uninstall", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    await pluginStore.getPlugin(id);

    if (!options?.pluginRunner?.uninstallPluginSetup || !options?.pluginRunner?.getPluginSetupInfo) {
      throw internalError("Plugin runner not available");
    }

    const setupInfo = options.pluginRunner.getPluginSetupInfo();
    const setup = setupInfo.find((entry) => entry.pluginId === id);
    if (!setup) {
      res.json({ success: true });
      return;
    }

    const result = await options.pluginRunner.uninstallPluginSetup(id);
    res.json(result ?? { success: true });
  });

  /**
   * PUT /api/plugins/:id/settings
   * Update plugin settings.
   * Body: { settings: Record<string, unknown>, projectId?: string }
   */
  router.put("/plugins/:id/settings", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object with 'settings' field");
    }

    const body = req.body as Record<string, unknown>;
    const settings = body.settings as Record<string, unknown> | undefined;

    if (!settings || typeof settings !== "object") {
      throw badRequest("Request body must have a 'settings' object");
    }

    // Auto-install bundled runtime plugins (Hermes/OpenClaw/Paperclip) on
    // first save. The Settings UI surfaces these as fallback cards before
    // they're actually registered, so the first PUT must lazily install them
    // rather than 404. The host (CLI) injects ensureBundledPluginInstalled
    // because dashboard doesn't know the on-disk bundle layout.
    const isBundledFallback = BUNDLED_PLUGIN_RUNTIMES.some((r) => r.pluginId === id);
    if (isBundledFallback && options?.ensureBundledPluginInstalled) {
      let alreadyRegistered = true;
      try {
        await pluginStore.getPlugin(id);
      } catch {
        alreadyRegistered = false;
      }
      if (!alreadyRegistered) {
        try {
          const installOk = await options.ensureBundledPluginInstalled(id);
          if (!installOk) {
            throw internalError(
              `Bundled plugin "${id}" is unavailable in this build and could not be auto-installed`,
            );
          }
        } catch (installErr) {
          if (installErr instanceof ApiError) {
            throw installErr;
          }
          throw internalError(
            `Failed to auto-install bundled plugin "${id}": ${installErr instanceof Error ? installErr.message : String(installErr)}`,
          );
        }
      }
    }

    try {
      const plugin = await pluginStore.updatePluginSettings(id, settings);
      res.json(plugin);
    } catch (err: unknown) {
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(`Plugin "${id}" not found`);
      }
      if (err instanceof Error && (err instanceof Error ? err.message : String(err)).includes("validation failed")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      throw internalError(err instanceof Error ? err.message : "Failed to update settings");
    }
  });

  /**
   * DELETE /api/plugins/:id
   * Uninstall a plugin.
   * Query: { projectId?: string }
   */
  router.delete("/plugins/:id", async (req: Request, res: Response) => {
    const { store: scopedStore } = await getProjectContext(req);
    const pluginStore = scopedStore.getPluginStore();
    const id = req.params.id as string;

    // Stop the plugin if loader is available
    if (options?.pluginLoader) {
      try {
        await options.pluginLoader.stopPlugin(id);
      } catch {
        // Ignore - plugin might not be loaded
      }
    }

    await pluginStore.unregisterPlugin(id);
    res.status(204).send();
  });


}
