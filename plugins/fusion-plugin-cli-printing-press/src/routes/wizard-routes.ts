import type { PluginContext, PluginRouteDefinition, PluginRouteResult } from "@fusion/core";
import { generateCli } from "../generation/generator.js";
import { runGeneratedCli } from "../generation/runner.js";
import type { GeneratedCliArtifact, RunRequest } from "../generation/types.js";
import { createCliPressStore } from "../store/cli-press-store.js";
import type { CliSpec, Service } from "../store/cli-press-types.js";
import type { ServiceDraft } from "../wizard/types.js";
import { validateDraft } from "../wizard/validation.js";

interface RouteRequest {
  params: Record<string, string>;
  body?: unknown;
}

function asRequest(req: unknown): RouteRequest { return req as RouteRequest; }
function ok(body: unknown, status = 200): PluginRouteResult { return { status, body }; }

function asArtifact(draft: ServiceDraft): GeneratedCliArtifact | null {
  if (!draft.artifactPath || !draft.generatedAt) return null;
  return {
    draftId: draft.id,
    slug: draft.slug,
    binPath: draft.artifactPath,
    entrypoint: "node",
    generatedAt: draft.generatedAt,
  };
}

function getArtifactDir(id: string, projectRoot: string): string {
  return `${projectRoot}/.fusion/plugins/cli-printing-press/artifacts/${id}`;
}

function getStore(ctx: PluginContext) {
  // FNXC:PostgresCutover 2026-07-04-00:00:
  // Dual-mode: in backend mode pass the AsyncDataLayer so the store routes to
  // Drizzle queries against the plugin-owned PG tables; legacy SQLite mode
  // passes the sync db.
  const backendMode = ctx.taskStore.isBackendMode();
  const db = backendMode ? null : ctx.taskStore.getDatabase();
  const asyncLayer = backendMode ? ctx.taskStore.getAsyncLayer() : null;
  return createCliPressStore(db, asyncLayer);
}

function toDraft(service: Service, spec: CliSpec | undefined, endpoints: ServiceDraft["endpoints"]): ServiceDraft {
  return {
    id: service.id,
    name: service.displayName,
    slug: service.slug,
    description: service.description ?? "",
    baseUrl: service.baseUrl,
    transport: "http",
    endpoints,
    credential: { kind: "none" },
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    generatedAt: spec?.generatedAt,
    regeneratedAt: spec?.generatedAt,
    artifactPath: spec?.status === "generated" ? spec.specJson : undefined,
  };
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function validateRunRequest(body: unknown): { ok: true; value: RunRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Request body is required" };
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.endpointId !== "string" || !candidate.endpointId.trim()) return { ok: false, error: "endpointId is required" };
  if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) return { ok: false, error: "params must be an object" };
  for (const value of Object.values(candidate.params as Record<string, unknown>)) {
    if (!isPrimitive(value)) return { ok: false, error: "params values must be primitives" };
  }
  if (candidate.credentials !== undefined) {
    if (!candidate.credentials || typeof candidate.credentials !== "object" || Array.isArray(candidate.credentials)) return { ok: false, error: "credentials must be an object" };
    for (const value of Object.values(candidate.credentials as Record<string, unknown>)) {
      if (typeof value !== "string") return { ok: false, error: "credentials values must be strings" };
    }
  }
  if (candidate.timeoutMs !== undefined) {
    if (!Number.isFinite(candidate.timeoutMs) || !Number.isInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) <= 0 || (candidate.timeoutMs as number) > 300_000) {
      return { ok: false, error: "timeoutMs must be an integer between 1 and 300000" };
    }
  }
  return {
    ok: true,
    value: {
      endpointId: candidate.endpointId,
      params: candidate.params as Record<string, string | number | boolean>,
      credentials: candidate.credentials as Record<string, string> | undefined,
      timeoutMs: candidate.timeoutMs as number | undefined,
    },
  };
}

export function createCliPrintingPressRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/drafts",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const draft = request.body as ServiceDraft;
        const result = validateDraft(draft);
        if (!result.ok) return { status: 400, body: { error: Object.values(result.errors)[0] ?? "Validation failed", errors: result.errors } };
        const store = getStore(ctx);
        const createdService = await store.createService({
          slug: draft.slug,
          displayName: draft.name,
          description: draft.description,
          baseUrl: draft.baseUrl,
          sourceKind: "manual",
          sourceRef: undefined,
        });
        const createdSpec = await store.createSpec({
          serviceId: createdService.id,
          name: `${draft.slug}-cli`,
          version: "0.1.0",
          generatorVersion: "cli-printing-press",
          specJson: JSON.stringify(draft),
          status: "draft",
          generatedAt: undefined,
          lastGenerationError: undefined,
        });
        await store.setSetting({ serviceId: createdService.id, key: "endpoints", value: JSON.stringify(draft.endpoints), scope: "wizard" });
        const created = toDraft(createdService, createdSpec, draft.endpoints);
        return ok(created, 201);
      },
    },
    {
      method: "GET",
      path: "/drafts",
      handler: async (_req, ctx: PluginContext) => {
        const store = getStore(ctx);
        const drafts = (await store.listServices()).map((service) => ({
          id: service.id,
          name: service.displayName,
          slug: service.slug,
          updatedAt: service.updatedAt,
        }));
        return ok(drafts);
      },
    },
    {
      method: "GET",
      path: "/drafts/:id",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const store = getStore(ctx);
        const service = await store.getService(request.params.id);
        if (!service) return ok({ error: "Draft not found" }, 404);
        const spec = (await store.listSpecs(service.id))[0];
        const endpointsSetting = (await store.listSettings(service.id)).find((entry) => entry.key === "endpoints" && entry.scope === "wizard");
        const endpoints = endpointsSetting ? (JSON.parse(endpointsSetting.value) as ServiceDraft["endpoints"]) : [];
        return ok(toDraft(service, spec, endpoints));
      },
    },
    {
      method: "PUT",
      path: "/drafts/:id",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const draft = request.body as ServiceDraft;
        const result = validateDraft(draft);
        if (!result.ok) return { status: 400, body: { error: Object.values(result.errors)[0] ?? "Validation failed", errors: result.errors } };
        const store = getStore(ctx);
        const service = await store.getService(request.params.id);
        if (!service) return ok({ error: "Draft not found" }, 404);
        const updatedService = await store.updateService(service.id, {
          displayName: draft.name,
          description: draft.description,
          baseUrl: draft.baseUrl,
          sourceKind: "manual",
        });
        const existingSpec = (await store.listSpecs(service.id))[0];
        const updatedSpec = existingSpec
          ? await store.updateSpec(existingSpec.id, { specJson: JSON.stringify(draft), status: "draft", lastGenerationError: undefined })
          : await store.createSpec({
            serviceId: service.id,
            name: `${draft.slug}-cli`,
            version: "0.1.0",
            generatorVersion: "cli-printing-press",
            specJson: JSON.stringify(draft),
            status: "draft",
            generatedAt: undefined,
            lastGenerationError: undefined,
          });
        await store.setSetting({ serviceId: service.id, key: "endpoints", value: JSON.stringify(draft.endpoints), scope: "wizard" });
        return ok(toDraft(updatedService, updatedSpec, draft.endpoints));
      },
    },
    {
      method: "POST",
      path: "/drafts/:id/regenerate",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const projectRoot = ctx.taskStore.getRootDir();
        const store = getStore(ctx);
        const service = await store.getService(request.params.id);
        if (!service) return ok({ error: "Draft not found" }, 404);
        const spec = (await store.listSpecs(service.id))[0];
        if (!spec) return ok({ error: "Draft not found" }, 404);
        const draft = JSON.parse(spec.specJson) as ServiceDraft;
        const artifact = await generateCli({ draft, outDir: getArtifactDir(draft.id, projectRoot) });
        const updatedSpec = await store.updateSpec(spec.id, {
          specJson: JSON.stringify({ ...draft, regeneratedAt: artifact.generatedAt, generatedAt: artifact.generatedAt, artifactPath: artifact.binPath }),
          generatedAt: artifact.generatedAt,
          status: "generated",
          lastGenerationError: undefined,
        });
        await store.createArtifact({
          cliSpecId: spec.id,
          kind: "script",
          path: artifact.binPath.replace(`${projectRoot}/.fusion/`, ""),
          executable: true,
          checksum: undefined,
          sizeBytes: undefined,
        });
        return ok({ draft: JSON.parse(updatedSpec.specJson) as ServiceDraft, artifact });
      },
    },
    {
      method: "POST",
      path: "/drafts/:id/run",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const parsed = validateRunRequest(request.body);
        if (!parsed.ok) return ok({ error: parsed.error }, 400);

        const store = getStore(ctx);
        const service = await store.getService(request.params.id);
        if (!service) return ok({ error: "Draft not found" }, 404);
        const spec = (await store.listSpecs(service.id))[0];
        if (!spec) return ok({ error: "Draft not found" }, 404);
        const draft = JSON.parse(spec.specJson) as ServiceDraft;
        const artifact = asArtifact(draft);
        if (!artifact) return ok({ error: "Draft has not been generated yet" }, 409);

        const endpointExists = draft.endpoints.some((endpoint) => endpoint.id === parsed.value.endpointId);
        if (!endpointExists) return ok({ error: "Endpoint not found" }, 400);

        const result = await runGeneratedCli({
          artifact,
          endpointId: parsed.value.endpointId,
          params: parsed.value.params,
          credentials: parsed.value.credentials,
          timeoutMs: parsed.value.timeoutMs,
          cwd: ctx.taskStore.getRootDir(),
        });
        return ok(result, 200);
      },
    },
    {
      method: "GET",
      path: "/drafts/:id/artifact",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const store = getStore(ctx);
        const service = await store.getService(request.params.id);
        if (!service) return ok({ error: "Artifact not found" }, 404);
        const spec = (await store.listSpecs(service.id))[0];
        if (!spec) return ok({ error: "Artifact not found" }, 404);
        const draft = JSON.parse(spec.specJson) as ServiceDraft;
        const artifact = asArtifact(draft);
        return artifact ? ok({ artifact }) : ok({ error: "Artifact not found" }, 404);
      },
    },
    {
      method: "DELETE",
      path: "/drafts/:id",
      handler: async (req, ctx: PluginContext) => {
        const request = asRequest(req);
        const store = getStore(ctx);
        await store.deleteService(request.params.id);
        return { status: 204 };
      },
    },
  ];
}
