import { ApiError, badRequest } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

/**
 * Values that are never safe to return from a portability endpoint. Reference-only
 * `secretRef` values remain portable because they do not contain secret material.
 */
const SECRET_RESPONSE_KEY = /(?:api[_-]?key|token|password|credential|auth|secret)(?!ref$)/i;

function scrubResponseSecrets(value: unknown, key?: string): unknown {
  if (key && SECRET_RESPONSE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => scrubResponseSecrets(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([entryKey, entryValue]) => {
    const scrubbed = scrubResponseSecrets(entryValue, entryKey);
    return scrubbed === undefined ? [] : [[entryKey, scrubbed]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Register project-scoped org portability and configuration history endpoints.
 */
export function registerOrgPortabilityRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  /*
  FNXC:CommandCenterConfig 2026-07-18-12:00:
  FR-05 requires the dashboard to export a portable organization bundle without
  relying on a CLI handoff. The core assembler scrubs secrets by default; this
  route applies a second response-boundary scrub so no credential value can be
  exposed even if a future core caller accidentally returns one.
  */
  router.post("/org/export", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      // FNXC:CommandCenterConfig 2026-07-18-12:00: FN-8283 exports are intentionally typed at this route boundary until its core branch lands; do not duplicate bundle assembly or secret scrubbing in the dashboard.
      const { AgentStore, RoutineStore, AutomationStore, assembleOrgBundle } = await import("@fusion/core") as unknown as {
        AgentStore: new (options: { rootDir: string; asyncLayer?: unknown }) => { init(): Promise<void> };
        RoutineStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        AutomationStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        assembleOrgBundle: (stores: unknown) => Promise<unknown>;
      };
      const asyncLayer = scopedStore.getAsyncLayer() ?? undefined;
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer });
      await agentStore.init();
      const bundle = await assembleOrgBundle({
        projectRoot: scopedStore.getRootDir(),
        agentStore,
        routineStore: new RoutineStore(scopedStore.getRootDir(), { asyncLayer }),
        automationStore: new AutomationStore(scopedStore.getRootDir(), { asyncLayer }),
        settingsStore: scopedStore,
      });
      res.json({ bundle: scrubResponseSecrets(bundle) });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.post("/org/import", async (req, res) => {
    try {
      const { bundle, dryRun = false, collisionMode } = req.body ?? {};
      if (!isRecord(bundle)) throw badRequest("bundle must be an object");
      if (typeof dryRun !== "boolean") throw badRequest("dryRun must be a boolean");
      if (collisionMode !== undefined && collisionMode !== "skip" && collisionMode !== "suffix") {
        throw badRequest("collisionMode must be 'skip' or 'suffix'");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, RoutineStore, AutomationStore, materializeOrgBundle } = await import("@fusion/core") as unknown as {
        AgentStore: new (options: { rootDir: string; asyncLayer?: unknown }) => { init(): Promise<void> };
        RoutineStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        AutomationStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        materializeOrgBundle: (stores: unknown, bundle: Record<string, unknown>, options: { dryRun: boolean; collisionMode?: "skip" | "suffix" }) => Promise<unknown>;
      };
      const asyncLayer = scopedStore.getAsyncLayer() ?? undefined;
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer });
      await agentStore.init();
      const result = await materializeOrgBundle({
        projectRoot: scopedStore.getRootDir(), agentStore,
        routineStore: new RoutineStore(scopedStore.getRootDir(), { asyncLayer }),
        automationStore: new AutomationStore(scopedStore.getRootDir(), { asyncLayer }),
        settingsStore: scopedStore,
      }, scrubResponseSecrets(bundle) as Record<string, unknown>, { dryRun, collisionMode });
      res.json({ result: scrubResponseSecrets(result), dryRun });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.get("/config/revisions", async (req, res) => {
    try {
      const configKind = req.query.configKind;
      if (configKind !== undefined && configKind !== "project-settings") {
        throw badRequest("configKind must be project-settings");
      }
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const layer = scopedStore.getAsyncLayer();
      if (!layer) throw badRequest("Configuration history requires the PostgreSQL revision store");
      // FNXC:CommandCenterConfig 2026-07-18-12:00: FN-8282's revision facade is consumed through this narrow compatibility type until the dependency export is merged into this branch.
      const { ConfigurationRevisionStore } = await import("@fusion/core") as unknown as {
        ConfigurationRevisionStore: new (layer: unknown, projectId?: string) => { list(kind: "project-settings", target: Record<string, string>): Promise<unknown[]> };
      };
      // FNXC:CommandCenterConfig 2026-07-18-12:00: Dashboard history starts with the project settings target because that is the configuration surface rendered beside these controls; rollback remains the core's exact, forward-recorded operation.
      const revisions = await new ConfigurationRevisionStore(layer, projectId).list("project-settings", { projectId: projectId ?? "" });
      res.json({ revisions });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.post("/config/revisions/:revisionId/rollback", async (req, res) => {
    try {
      const revisionId = req.params.revisionId?.trim();
      if (!revisionId) throw badRequest("revisionId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const revision = await (scopedStore as unknown as { rollbackConfiguration(id: string, changedBy: { kind: "human"; id: string }): Promise<unknown> }).rollbackConfiguration(revisionId, { kind: "human", id: "dashboard-operator" });
      res.json({ revision });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });
}
