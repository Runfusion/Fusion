import { Router, type Request } from "express";
import { resolve, sep } from "node:path";
import type { TaskStore } from "@fusion/core";
import type { ServerOptions } from "../server.js";
import { ApiError, internalError } from "../api-error.js";
import { getOrCreateProjectStore } from "../project-store-resolver.js";
import { createRuntimeLogger } from "../runtime-logger.js";
import type { RuntimeLogger } from "../runtime-logger.js";
import type {
  ApiRoutesContext,
  AuthSyncAuditLogInput,
  ProjectContext,
  RemoteRouteDiagnosticInput,
  RemoteRouteErrorClassification,
  ScopeValue,
} from "./types.js";

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error instanceof Error) {
    throw internalError(error.message || fallbackMessage);
  }

  throw internalError(fallbackMessage);
}

export function classifyRemoteRouteError(error: unknown): RemoteRouteErrorClassification {
  const fallbackMessage = String(error);

  if (error instanceof Error) {
    const errorClass = error.constructor?.name || error.name || "Error";
    const errorMessage = error.message || fallbackMessage;

    if (error.name === "AbortError") {
      return { classification: "timeout", errorClass, errorMessage };
    }

    if (error instanceof TypeError) {
      return { classification: "transport", errorClass, errorMessage };
    }

    return { classification: "unexpected", errorClass, errorMessage };
  }

  if ((error as { name?: unknown } | null)?.name === "AbortError") {
    return { classification: "timeout", errorClass: "AbortError", errorMessage: fallbackMessage };
  }

  return {
    classification: "unexpected",
    errorClass: typeof error,
    errorMessage: fallbackMessage,
  };
}

// FNXC:CentralProjectIdentity 2026-07-14-00:15: normalize with .trim() and treat a
// whitespace-only projectId as absent so it falls through to the launch-id resolution
// instead of binding a bogus id (restores strictness the seam replaced).
export function getProjectIdFromRequest(req: Request): string | undefined {
  if (req.query && typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0) {
    return req.query.projectId.trim();
  }
  if (req.body && typeof req.body.projectId === "string" && req.body.projectId.trim().length > 0) {
    return req.body.projectId.trim();
  }
  return undefined;
}

/*
FNXC:CentralProjectIdentity 2026-07-13-23:50:
Directive: dashboard API requests operate on an EXPLICIT central-registry project id, never a silent bind to the raw launch-directory TaskStore.
Resolution order for a request's project identity:
  1. request `projectId` (query/body),
  2. else the daemon's registered launch project id (`options.engine.getProjectId()`),
  3. else undefined — the caller is an unregistered/legacy launch directory and the raw injected store is a last resort (see warnLaunchDirFallbackOnce).
Once an id resolves it ALWAYS flows through the same bound-store path used for explicit ids (engine store when a live engine exists, else getOrCreateProjectStore), so store identity always comes from the central registry — with one dedup: the launch project reuses the injected registry-bound store instead of booting a second connection pool for the same id.
*/
export function resolveRequestProjectId(req: Request, options?: ServerOptions): string | undefined {
  return getProjectIdFromRequest(req) ?? options?.engine?.getProjectId?.() ?? undefined;
}

/*
FNXC:CentralProjectIdentity 2026-07-13-23:51:
The launch-dir raw-store fallback is legacy behavior preserved ONLY for unregistered directories (no request id AND no registered launch engine). Warn once per process (not per request) so the signal is visible without flooding logs; a single flag is shared with server.ts's resolveScopedStore via this exported helper.
*/
let warnedLaunchDirFallback = false;
export function warnLaunchDirFallbackOnce(options?: ServerOptions): void {
  if (warnedLaunchDirFallback) return;
  warnedLaunchDirFallback = true;
  const message =
    "project-scope fallback: request without projectId on an unregistered launch directory — using launch-dir store";
  const logger = options?.runtimeLogger;
  if (logger?.warn) {
    logger.warn(message);
  } else {
    console.warn(message);
  }
}

/*
FNXC:CentralProjectIdentity 2026-07-14-00:15:
Single id-based store-resolution core shared by both routes/context.ts getScopedStore
and server.ts resolveScopedStore (the realtime path). Deduplicates the previously
mirrored resolution so identity semantics can never drift between the two entry points.
Given an ALREADY-resolved id (request id → launch id folded in by the caller):
  1. no id → one-time launch-dir fallback warn + return the raw injected store,
  2. live engineManager engine for the id → its TaskStore,
  3. id === launch project id → reuse the injected registry-bound store (no duplicate pool),
  4. else → getOrCreateProjectStore(id).

FNXC:CentralProjectIdentity 2026-07-14-00:15 (F6 caveat):
Launch-store reuse (step 3) assumes the injected store belongs to a live launch engine.
When an engineManager is present but getEngine(launchId) is undefined, this cannot
distinguish a launch engine that was never started (store still valid) from one that was
explicitly stopped/paused (store may be closed). ProjectEngineManager exposes no synchronous
engine-liveness/paused introspection (getEngine returns undefined for a stopped engine since
it is deleted from the engines map, and paused status lives async in CentralCore), so no
correct fall-through to getOrCreateProjectStore(launchId) is implementable here without
inventing an API. Behavior is preserved; a live engine store (step 2) always wins first.
*/
export async function resolveStoreForProjectId(
  resolvedId: string | undefined,
  store: TaskStore,
  options?: ServerOptions,
): Promise<TaskStore> {
  if (!resolvedId) {
    warnLaunchDirFallbackOnce(options);
    return store;
  }

  const engineManager = options?.engineManager;
  if (engineManager) {
    const engine = engineManager.getEngine(resolvedId);
    if (engine) {
      return engine.getTaskStore();
    }
  }

  // Launch project: the injected store is already registry-bound to this id, so
  // reuse it instead of booting a duplicate connection pool via
  // getOrCreateProjectStore. See the F6 caveat above.
  if (options?.engine?.getProjectId?.() === resolvedId) {
    return store;
  }

  return getOrCreateProjectStore(resolvedId);
}

export async function getScopedStore(
  req: Request,
  store: TaskStore,
  options?: ServerOptions,
): Promise<TaskStore> {
  const projectId = resolveRequestProjectId(req, options);
  return resolveStoreForProjectId(projectId, store, options);
}

export async function getProjectContext(
  req: Request,
  store: TaskStore,
  options?: ServerOptions,
): Promise<ProjectContext> {
  const projectId = resolveRequestProjectId(req, options);
  const engineManager = options?.engineManager;

  if (!projectId) {
    // No request id and no registered launch engine: unregistered/legacy launch
    // directory. Preserve the raw-store last resort with a one-time warn.
    warnLaunchDirFallbackOnce(options);
    return { store, engine: undefined, projectId: undefined };
  }

  if (engineManager) {
    const engine = engineManager.getEngine(projectId);
    if (!engine) {
      // Trigger lazy engine start as fire-and-forget so this request is not
      // blocked while the engine initialises (engine.start() may take several
      // seconds for a newly-registered project).
      // The engine will be available for subsequent requests once it starts.
      engineManager.onProjectAccessed(projectId);
    }
    if (engine) {
      return { store: engine.getTaskStore(), engine, projectId };
    }
  }

  // Launch project: reuse the live launch engine + its registry-bound store
  // rather than a duplicate boot. The resolved projectId is returned explicitly
  // (never undefined) so downstream context is always attributable to a
  // central-registry id.
  if (options?.engine && options.engine.getProjectId?.() === projectId) {
    try {
      return { store: options.engine.getTaskStore(), engine: options.engine, projectId };
    } catch {
      // Fall back to scoped store resolution.
    }
  }

  const scopedStore = await getScopedStore(req, store, options);
  return { store: scopedStore, engine: undefined, projectId };
}

export function emitRemoteRouteDiagnostic(
  runtimeLogger: RuntimeLogger,
  input: RemoteRouteDiagnosticInput,
): void {
  const logger = runtimeLogger.child("remote-route").child(input.route);
  const level = input.level ?? "error";

  const context: Record<string, unknown> = {
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.upstreamPath !== undefined ? { upstreamPath: input.upstreamPath } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.operationStage !== undefined ? { operationStage: input.operationStage } : {}),
    ...(input.context ?? {}),
  };

  if (input.error !== undefined) {
    const classified = classifyRemoteRouteError(input.error);
    context.transportClassification = classified.classification;
    context.errorClass = classified.errorClass;
    context.errorMessage = classified.errorMessage;
  }

  if (level === "info") {
    logger.info(input.message, context);
    return;
  }

  if (level === "warn") {
    logger.warn(input.message, context);
    return;
  }

  logger.error(input.message, context);
}

export function createApiRoutesContext(store: TaskStore, options?: ServerOptions): ApiRoutesContext {
  const router = Router();
  const runtimeLogger = options?.runtimeLogger?.child("routes") ?? createRuntimeLogger("routes");
  const planningLogger = runtimeLogger.child("planning");
  const chatLogger = runtimeLogger.child("chat");

  function prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[] {
    const cwd = resolve(process.cwd());

    const rankProject = (projectPath: string): number => {
      const normalizedProjectPath = resolve(projectPath);
      if (normalizedProjectPath === cwd) {
        return Number.MAX_SAFE_INTEGER;
      }

      const prefix = normalizedProjectPath.endsWith(sep)
        ? normalizedProjectPath
        : `${normalizedProjectPath}${sep}`;

      if (!cwd.startsWith(prefix)) {
        return -1;
      }

      return normalizedProjectPath.length;
    };

    return [...projects].sort((a, b) => rankProject(b.path) - rankProject(a.path));
  }

  const resolveScopedStore = (req: Request): Promise<TaskStore> => getScopedStore(req, store, options);
  const resolveProjectContext = (req: Request): Promise<ProjectContext> => getProjectContext(req, store, options);
  const disposeCallbacks: Array<() => void> = [];

  function emitAuthSyncAuditLog(input: AuthSyncAuditLogInput): void {
    const logger = runtimeLogger.child("settings-sync").child("auth");
    const level = input.level ?? "info";
    const providerNames = input.providerNames.filter((provider) => typeof provider === "string");

    const context: Record<string, unknown> = {
      operation: input.operation,
      direction: input.direction,
      route: input.route,
      providerNames,
      providerCount: providerNames.length,
      ...(input.sourceNodeId !== undefined ? { sourceNodeId: input.sourceNodeId } : {}),
      ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
    };

    if (level === "warn") {
      logger.warn("Auth sync diagnostic event", context);
      return;
    }

    if (level === "error") {
      logger.error("Auth sync diagnostic event", context);
      return;
    }

    logger.info("Auth sync diagnostic event", context);
  }

  function parseScopeParam(req: Request): ScopeValue | undefined {
    const rawScope =
      (typeof req.query.scope === "string" ? req.query.scope : undefined) ??
      (req.body && typeof req.body.scope === "string" ? req.body.scope : undefined);

    if (rawScope === undefined || rawScope === "") {
      return undefined;
    }

    if (rawScope !== "global" && rawScope !== "project") {
      throw new ApiError(400, `Invalid scope value "${rawScope}". Must be "global" or "project".`);
    }

    return rawScope;
  }

  function resolveAutomationStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").AutomationStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.automationStore;
      if (!defaultStore) {
        throw new ApiError(503, "Automation store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getAutomationStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    const defaultStore = options?.automationStore;
    if (!defaultStore) {
      throw new ApiError(503, "Automation store not available");
    }
    return defaultStore;
  }

  function resolveRoutineStore(req: Request, scope: ScopeValue | undefined): import("@fusion/core").RoutineStore {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "global" || scope === undefined) {
      const defaultStore = options?.routineStore;
      if (!defaultStore) {
        throw new ApiError(503, "Routine store not available");
      }
      return defaultStore;
    }

    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineStore = engine.getRoutineStore();
        if (engineStore) {
          return engineStore;
        }
      }
    }

    const defaultStore = options?.routineStore;
    if (!defaultStore) {
      throw new ApiError(503, "Routine store not available");
    }
    return defaultStore;
  }

  function resolveRoutineRunner(req: Request, scope: ScopeValue | undefined): NonNullable<ServerOptions["routineRunner"]> {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (scope === "project" && projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        const engineRunner = engine.getRoutineRunner();
        if (engineRunner) {
          return {
            triggerManual: engineRunner.triggerManual.bind(engineRunner),
            triggerWebhook: engineRunner.triggerWebhook.bind(engineRunner),
          };
        }
      }
    }

    const runner = options?.routineRunner;
    if (!runner) {
      throw new ApiError(503, "Routine execution not available");
    }
    return runner;
  }

  return {
    router,
    store,
    options,
    runtimeLogger,
    planningLogger,
    chatLogger,
    prioritizeProjectsForCurrentDirectory,
    getProjectIdFromRequest,
    getScopedStore: resolveScopedStore,
    getProjectContext: resolveProjectContext,
    emitRemoteRouteDiagnostic: (input) => emitRemoteRouteDiagnostic(runtimeLogger, input),
    emitAuthSyncAuditLog,
    parseScopeParam,
    resolveAutomationStore,
    resolveRoutineStore,
    resolveRoutineRunner,
    registerDispose: (callback) => {
      disposeCallbacks.push(callback);
    },
    dispose: () => {
      while (disposeCallbacks.length > 0) {
        const callback = disposeCallbacks.pop();
        if (!callback) continue;
        try {
          callback();
        } catch {
          // best-effort cleanup
        }
      }
    },
    rethrowAsApiError,
  };
}
