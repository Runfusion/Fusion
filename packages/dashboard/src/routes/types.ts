import type { Request, RequestHandler, Router } from "express";
import type { AutomationStore, PluginLoader, RoutineStore, TaskStore } from "@fusion/core";
import type { ServerOptions } from "../server.js";
import type { RuntimeLogger } from "../runtime-logger.js";

export interface ProjectContext {
  store: TaskStore;
  engine: import("@fusion/engine").ProjectEngine | undefined;
  projectId: string | undefined;
}

export interface RemoteRouteDiagnosticInput {
  route: string;
  message: string;
  nodeId?: string;
  upstreamPath?: string;
  stage?: string;
  operationStage?: string;
  error?: unknown;
  level?: "info" | "warn" | "error";
  context?: Record<string, unknown>;
}

export interface RemoteRouteErrorClassification {
  classification: "timeout" | "transport" | "unexpected";
  errorClass: string;
  errorMessage: string;
}

export interface AuthSyncAuditLogInput {
  level?: "info" | "warn" | "error";
  operation: "receive" | "sync";
  direction: "push" | "pull" | "receive";
  route: "/settings/auth-receive" | "/nodes/:id/auth/sync";
  sourceNodeId?: string;
  targetNodeId?: string;
  providerNames: string[];
}

export type ScopeValue = "global" | "project";

export interface ApiRoutesContext {
  router: Router;
  store: TaskStore;
  /** Narrow multipart seam for routes that must accept local binary artifacts. */
  reportUpload?: { single(fieldName: string): RequestHandler };
  options?: ServerOptions;
  runtimeLogger: RuntimeLogger;
  planningLogger: RuntimeLogger;
  chatLogger: RuntimeLogger;
  getProjectIdFromRequest(req: Request): string | undefined;
  getScopedStore(req: Request): Promise<TaskStore>;
  getProjectContext(req: Request): Promise<ProjectContext>;
  /*
  FNXC:PluginEnablementScope 2026-07-22-20:30:
  Single per-request plugin-loader resolution shared by plugin management/introspection
  routes AND plugin-defined HTTP route dispatch, so navigation (dashboard-views) and the
  routes it calls can never disagree about which plugins exist for a project.
  */
  getProjectPluginLoader(
    scopedStore: TaskStore,
    engine?: { getPluginRunner?: () => { getLoader?: () => PluginLoader } | undefined },
  ): Promise<PluginLoader | undefined>;
  prioritizeProjectsForCurrentDirectory<T extends { path: string }>(projects: T[]): T[];
  emitRemoteRouteDiagnostic(input: RemoteRouteDiagnosticInput): void;
  emitAuthSyncAuditLog(input: AuthSyncAuditLogInput): void;
  parseScopeParam(req: Request): ScopeValue | undefined;
  resolveAutomationStore(req: Request, scope: ScopeValue | undefined): AutomationStore;
  resolveRoutineStore(req: Request, scope: ScopeValue | undefined): RoutineStore;
  resolveRoutineRunner(req: Request, scope: ScopeValue | undefined): NonNullable<ServerOptions["routineRunner"]>;
  registerDispose(callback: () => void): void;
  dispose(): void;
  rethrowAsApiError(error: unknown, fallbackMessage?: string): never;
}

export type ApiRouteRegistrar = (context: ApiRoutesContext) => void;
