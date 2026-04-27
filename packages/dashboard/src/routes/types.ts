import type { Request, Router } from "express";
import type { AutomationStore, RoutineStore, TaskStore } from "@fusion/core";
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
  options?: ServerOptions;
  runtimeLogger: RuntimeLogger;
  planningLogger: RuntimeLogger;
  chatLogger: RuntimeLogger;
  getProjectIdFromRequest(req: Request): string | undefined;
  getScopedStore(req: Request): Promise<TaskStore>;
  getProjectContext(req: Request): Promise<ProjectContext>;
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
