import type { McpServerDefinition, TaskStore } from "@fusion/core";
import { validateMcpServerDefinitionDetailed } from "@fusion/core";
import {
  discoverMcpServers,
  resolveMcpServersForRuntime,
  resolveMcpServersForStore,
  validateMcpServer,
} from "@fusion/engine";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

/*
FNXC:RouteModularity 2026-07-19-14:30:
The FN-8365 modular-routing ratchet requires configuration, MCP, and Pi-settings
endpoints to leave routes.ts while retaining their historical mount precedence.
*/

interface McpValidateRequestBody {
  name?: unknown;
  server?: unknown;
  definition?: unknown;
  timeoutMs?: unknown;
}

function parseMcpValidationTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest("timeoutMs must be a positive number when provided");
  }
  return Math.min(value, 30_000);
}

function parseMcpValidationBody(body: unknown): { name?: string; definition?: McpServerDefinition; timeoutMs?: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be an object");
  }

  const input = body as McpValidateRequestBody;
  const name = typeof input.name === "string" ? input.name.trim() : undefined;
  const rawDefinition = input.server ?? input.definition;
  if (!name && rawDefinition === undefined) {
    throw badRequest("Provide either name or server");
  }
  if (input.name !== undefined && !name) {
    throw badRequest("name must be a non-empty string when provided");
  }

  let definition: McpServerDefinition | undefined;
  if (rawDefinition !== undefined) {
    const parsed = validateMcpServerDefinitionDetailed(rawDefinition, "server");
    if (!parsed.value) {
      throw badRequest("Invalid MCP server definition", { errors: parsed.errors.map((error) => error.message) });
    }
    definition = parsed.value;
  }

  return { name, definition, timeoutMs: parseMcpValidationTimeout(input.timeoutMs) };
}

function parseMcpDiscoveryScope(value: unknown): "global" | "project" {
  if (value === undefined) return "project";
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "global" || raw === "project") return raw;
  throw badRequest("scope must be either global or project");
}

function stripMcpSecretDescriptor(secret: { field: "env" | "headers" | "token"; key: string; suggestedKey: string; scope: "global" | "project" }) {
  return {
    field: secret.field,
    key: secret.key,
    suggestedKey: secret.suggestedKey,
    scope: secret.scope,
  };
}

async function resolveMcpServerForValidation(
  scopedStore: TaskStore,
  request: { name?: string; definition?: McpServerDefinition },
) {
  if (request.definition) {
    const secrets = await scopedStore.getSecretsStore();
    const resolved = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [request.definition] } },
      projectSettings: undefined,
      secrets,
      reader: {},
    });
    if (resolved.errors.length > 0 || resolved.servers.length === 0) {
      throw badRequest("Unable to resolve MCP server secrets", { errors: resolved.errors.map((error) => ({ serverName: error.serverName, path: error.path, message: error.message })) });
    }
    return resolved.servers[0];
  }

  const resolved = await resolveMcpServersForStore(scopedStore);
  const server = resolved.servers.find((candidate) => candidate.name === request.name);
  if (!server) {
    throw badRequest("MCP server was not found or could not be resolved");
  }
  return server;
}

export const registerConfigMcpPiSettingsRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext, options, rethrowAsApiError } = ctx;

  router.get("/config", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      res.json({
        maxConcurrent: settings.maxConcurrent ?? options?.maxConcurrent ?? 2,
        maxTriageConcurrent: settings.maxTriageConcurrent ?? settings.maxConcurrent ?? 2,
        maxWorktrees: settings.maxWorktrees ?? 4,
        rootDir: scopedStore.getRootDir(),
      });
    } catch {
      const { store: scopedStore } = await getProjectContext(req);
      res.json({ maxConcurrent: options?.maxConcurrent ?? 2, maxTriageConcurrent: options?.maxConcurrent ?? 2, maxWorktrees: 4, rootDir: scopedStore.getRootDir() });
    }
  });

  router.get("/mcp/discovered", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scope = parseMcpDiscoveryScope(req.query.scope);
      const [discovered, settingsByScope] = await Promise.all([
        discoverMcpServers({ scope, projectRootDir: scopedStore.getRootDir() }),
        scopedStore.getSettingsByScopeFast(),
      ]);
      const configured = new Set((scope === "global" ? settingsByScope.global.mcpServers?.servers : settingsByScope.project.mcpServers?.servers)?.map((server) => server.name) ?? []);
      /*
       * FNXC:McpConfig 2026-06-26-10:31:
       * The discovery API is read-only: it reports inert third-party MCP definitions for explicit user opt-in and strips plaintextValue before crossing the wire. The dashboard can create Fusion-managed secret references from these descriptors, but API clients never receive raw env/header/token material.
       */
      res.json({
        sources: discovered.sources,
        servers: discovered.servers.map((server) => ({
          source: server.source,
          definition: server.definition,
          alreadyConfigured: configured.has(server.definition.name),
          hasPlaintextSecrets: server.secretsToCreate.length > 0,
          secretDescriptors: server.secretsToCreate.map(stripMcpSecretDescriptor),
        })),
        errors: discovered.errors,
      });
    } catch (error) {
      rethrowAsApiError(error, "Failed to discover MCP servers");
    }
  });

  router.post("/mcp/validate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const request = parseMcpValidationBody(req.body);
      const server = await resolveMcpServerForValidation(scopedStore, request);
      // FNXC:McpConfig 2026-06-25-23:38: The validation API materializes MCP secrets only for the bounded probe and returns only status metadata, never resolved env/header values.
      const result = await validateMcpServer(server, {
        timeoutMs: request.timeoutMs,
        cwd: scopedStore.getRootDir(),
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to validate MCP server");
    }
  });

  router.get("/pi-settings", async (_req, res) => {
    try {
      const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packages = settingsManager.getPackages();
      const extensions = settingsManager.getExtensionPaths();
      const skills = settingsManager.getSkillPaths();
      const prompts = settingsManager.getPromptTemplatePaths();
      const themes = settingsManager.getThemePaths();
      res.json({ packages, extensions, skills, prompts, themes });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.put("/pi-settings", async (req, res) => {
    try {
      const { packages, extensions, skills, prompts, themes } = req.body as {
        packages?: unknown;
        extensions?: unknown;
        skills?: unknown;
        prompts?: unknown;
        themes?: unknown;
      };

      if (packages === undefined && extensions === undefined && skills === undefined && prompts === undefined && themes === undefined) {
        throw badRequest("At least one setting field must be provided (packages, extensions, skills, prompts, or themes)");
      }

      const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);

      if (packages !== undefined) {
        if (!Array.isArray(packages)) throw badRequest("packages must be an array");
        settingsManager.setPackages(packages as string[]);
      }
      if (extensions !== undefined) {
        if (!Array.isArray(extensions)) throw badRequest("extensions must be an array of strings");
        settingsManager.setExtensionPaths(extensions as string[]);
      }
      if (skills !== undefined) {
        if (!Array.isArray(skills)) throw badRequest("skills must be an array of strings");
        settingsManager.setSkillPaths(skills as string[]);
      }
      if (prompts !== undefined) {
        if (!Array.isArray(prompts)) throw badRequest("prompts must be an array of strings");
        settingsManager.setPromptTemplatePaths(prompts as string[]);
      }
      if (themes !== undefined) {
        if (!Array.isArray(themes)) throw badRequest("themes must be an array of strings");
        settingsManager.setThemePaths(themes as string[]);
      }

      await settingsManager.flush();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/pi-settings/packages", async (req, res) => {
    try {
      const { source } = req.body as { source?: unknown };
      if (typeof source !== "string" || !source.trim()) throw badRequest("source must be a non-empty string");

      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const agentDir = getAgentDir();
      const cwd = process.cwd();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

      await packageManager.install(source.trim());
      const added = packageManager.addSourceToSettings(source.trim());
      if (!added) {
        res.json({ success: true });
        return;
      }

      await settingsManager.flush();
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/pi-settings/reinstall-fusion", async (_req, res) => {
    try {
      const source = "npm:@runfusion/fusion";
      const { SettingsManager, DefaultPackageManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const agentDir = getAgentDir();
      const cwd = process.cwd();
      const settingsManager = SettingsManager.create(process.cwd(), agentDir);
      const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

      await packageManager.install(source);
      const added = packageManager.addSourceToSettings(source);
      if (added) await settingsManager.flush();

      res.json({ success: true, source });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
};
