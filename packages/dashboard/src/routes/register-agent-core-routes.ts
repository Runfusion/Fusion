import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import type { Agent, AgentCapability, AgentUpdateInput, TaskStore, AgentPermissionPolicyRules, AgentPermissionPolicyDisposition } from "@fusion/core";
import {
  ApprovalRequestStore,
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  aggregateTaskTokenTotalsByAgentLink,
  getDefaultHeartbeatProcedurePath,
  isAgentPermissionPolicyPresetId,
  isEphemeralAgent,
  normalizeAgentPermissionPolicy,
  normalizeAgentPermissionPolicyFromPreset,
} from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import { ensureDefaultHeartbeatProcedureFile, HEARTBEAT_PROCEDURE } from "@fusion/engine";

interface AgentCoreRouteDeps {
  sanitizeAgentTaskLinks: (agents: Agent[], scopedStore: TaskStore) => Promise<Agent[]>;
  validateAgentInstructionsPayload: (instructionsPath: unknown, instructionsText: unknown) => boolean;
  upload: import("multer").Multer;
}

const AVATAR_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const VALID_POLICY_DISPOSITIONS: readonly AgentPermissionPolicyDisposition[] = ["allow", "block", "require-approval"] as const;

function parsePermissionPolicyInput(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw badRequest("permissionPolicy must be an object");
  }
  const policy = input as { presetId?: unknown; rules?: unknown };
  if (typeof policy.presetId !== "string" || !isAgentPermissionPolicyPresetId(policy.presetId)) {
    throw badRequest("permissionPolicy.presetId must be one of: unrestricted, approval-required, locked-down, custom");
  }

  if (policy.presetId !== "custom") {
    return normalizeAgentPermissionPolicyFromPreset(policy.presetId);
  }

  if (policy.rules !== undefined && (typeof policy.rules !== "object" || policy.rules === null || Array.isArray(policy.rules))) {
    throw badRequest("permissionPolicy.rules must be an object");
  }

  const customRules = (policy.rules ?? {}) as Record<string, unknown>;
  for (const category of Object.keys(customRules)) {
    if (!(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES as readonly string[]).includes(category)) {
      throw badRequest(`permissionPolicy.rules contains unknown category: ${category}`);
    }
    const disposition = customRules[category];
    if (typeof disposition !== "string" || !(VALID_POLICY_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw badRequest(`permissionPolicy.rules.${category} has invalid disposition: ${String(disposition)}`);
    }
  }

  return normalizeAgentPermissionPolicy({
    presetId: "custom",
    rules: customRules as Partial<AgentPermissionPolicyRules>,
  });
}

function isCompatibleDefaultHeartbeatPath(path: string | undefined, agent: Agent): boolean {
  const trimmed = path?.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === getDefaultHeartbeatProcedurePath(agent.id, agent.name)) {
    return true;
  }
  if (trimmed === getDefaultHeartbeatProcedurePath(agent.id)) {
    return true;
  }
  const safeId = (agent.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent");
  return new RegExp(`^\\.fusion/agents/[^/]+-${safeId}/HEARTBEAT\\.md$`).test(trimmed);
}

function withTaskDerivedTokenTotals<T extends Agent>(agents: T[], scopedStore: TaskStore): T[] {
  try {
    const tokenTotalsByAgentId = aggregateTaskTokenTotalsByAgentLink(scopedStore.getDatabase());

    return agents.map((agent) => {
      const storedInputTokens = agent.totalInputTokens ?? 0;
      const storedOutputTokens = agent.totalOutputTokens ?? 0;
      if (storedInputTokens > 0 || storedOutputTokens > 0) {
        return agent;
      }

      const taskTotals = tokenTotalsByAgentId.get(agent.id);
      if (!taskTotals || (taskTotals.inputTokens <= 0 && taskTotals.outputTokens <= 0)) {
        return agent;
      }

      /*
      FNXC:Agents 2026-06-27-19:16:
      The Agents listing derives zero/absent token totals from task links so ephemeral task-worker rows show real dashboard counts while durable agents keep their non-zero cumulative heartbeat totals.

      FNXC:Agents 2026-06-27-23:06:
      Use the shared assigned/source/checkout token attribution so list rows match Agent Detail for task-worker agents that only sourced or checked out a task.
      */
      return {
        ...agent,
        totalInputTokens: taskTotals.inputTokens,
        totalOutputTokens: taskTotals.outputTokens,
      };
    });
  } catch {
    return agents;
  }
}

async function withPendingApprovalCounts<T extends Agent>(agents: T[], scopedStore: TaskStore): Promise<Array<T & { pendingApprovalCount: number }>> {
  try {
    const layer = scopedStore.getAsyncLayer();
    const approvalStore = new ApprovalRequestStore(layer ? null : scopedStore.getDatabase(), { asyncLayer: layer });
    const counts = await approvalStore.getPendingCountsByActor();

    return agents.map((agent) => ({
      ...agent,
      pendingApprovalCount: counts.get(agent.id) ?? 0,
    }));
  } catch {
    return agents.map((agent) => ({
      ...agent,
      pendingApprovalCount: 0,
    }));
  }
}

export function registerAgentCoreListCreateRoutes(ctx: ApiRoutesContext, deps: AgentCoreRouteDeps): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const { sanitizeAgentTaskLinks, validateAgentInstructionsPayload } = deps;

  /**
   * GET /api/agents
   * List all agents with optional filtering.
   * Query params: state, role, includeEphemeral
   */
  router.get("/agents", async (req, res) => {
    try {
      const filter: { state?: string; role?: string; includeEphemeral?: boolean } = {};
      if (req.query.state && typeof req.query.state === "string") {
        filter.state = req.query.state;
      }
      if (req.query.role && typeof req.query.role === "string") {
        filter.role = req.query.role;
      }
      if (req.query.includeEphemeral === "true") {
        filter.includeEphemeral = true;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agents = await agentStore.listAgents(filter as { state?: "idle" | "active" | "running" | "paused" | "error"; role?: AgentCapability; includeEphemeral?: boolean });
      const sanitizedAgents = await sanitizeAgentTaskLinks(agents, scopedStore);
      const agentsWithTokenTotals = withTaskDerivedTokenTotals(sanitizedAgents, scopedStore);
      res.json(await withPendingApprovalCounts(agentsWithTokenTotals, scopedStore));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents
   * Create a new agent.
   */
  router.post("/agents", async (req, res) => {
    try {
      const {
        name,
        role,
        metadata,
        title,
        icon,
        reportsTo,
        runtimeConfig,
        permissions,
        permissionPolicy,
        instructionsPath,
        instructionsText,
        soul,
        memory,
        bundleConfig,
        heartbeatProcedurePath,
      } = req.body ?? {};

      if (!name || typeof name !== "string") {
        throw badRequest("name is required");
      }
      if (!role || typeof role !== "string") {
        throw badRequest("role is required");
      }
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }
      if (title !== undefined && title !== null && typeof title !== "string") {
        throw badRequest("title must be a string");
      }
      if (icon !== undefined && icon !== null && typeof icon !== "string") {
        throw badRequest("icon must be a string");
      }
      if (reportsTo !== undefined && reportsTo !== null && typeof reportsTo !== "string") {
        throw badRequest("reportsTo must be a string");
      }
      if (runtimeConfig !== undefined && (typeof runtimeConfig !== "object" || runtimeConfig === null || Array.isArray(runtimeConfig))) {
        throw badRequest("runtimeConfig must be an object");
      }
      if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
        throw badRequest("permissions must be an object");
      }
      let normalizedPermissionPolicy;
      if (permissionPolicy !== undefined && permissionPolicy !== null) {
        normalizedPermissionPolicy = parsePermissionPolicyInput(permissionPolicy);
      }
      if (!validateAgentInstructionsPayload(instructionsPath, instructionsText)) {
        return;
      }
      if (soul !== undefined && soul !== null && typeof soul !== "string") {
        throw badRequest("soul must be a string");
      }
      if (typeof soul === "string" && soul.length > 10000) {
        throw badRequest("soul must be at most 10,000 characters");
      }
      if (memory !== undefined && memory !== null && typeof memory !== "string") {
        throw badRequest("memory must be a string");
      }
      if (typeof memory === "string" && memory.length > 50000) {
        throw badRequest("memory must be at most 50,000 characters");
      }
      if (heartbeatProcedurePath !== undefined && heartbeatProcedurePath !== null && typeof heartbeatProcedurePath !== "string") {
        throw badRequest("heartbeatProcedurePath must be a string");
      }
      if (typeof heartbeatProcedurePath === "string" && heartbeatProcedurePath.length > 500) {
        throw badRequest("heartbeatProcedurePath must be at most 500 characters");
      }
      if (bundleConfig !== undefined && bundleConfig !== null) {
        if (typeof bundleConfig !== "object" || Array.isArray(bundleConfig)) {
          throw badRequest("bundleConfig must be an object");
        }
        if (typeof bundleConfig.mode !== "string" || !["managed", "external"].includes(bundleConfig.mode)) {
          throw badRequest("bundleConfig.mode must be 'managed' or 'external'");
        }
        if (typeof bundleConfig.entryFile !== "string") {
          throw badRequest("bundleConfig.entryFile must be a string");
        }
        if (!Array.isArray(bundleConfig.files)) {
          throw badRequest("bundleConfig.files must be an array");
        }
        if (bundleConfig.externalPath !== undefined && typeof bundleConfig.externalPath !== "string") {
          throw badRequest("bundleConfig.externalPath must be a string");
        }
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      let agent: Agent;
      try {
        agent = await agentStore.createAgent({
          name,
          role: role as AgentCapability,
          metadata,
          title: title ?? undefined,
          icon: icon ?? undefined,
          reportsTo: reportsTo ?? undefined,
          runtimeConfig,
          permissions,
          permissionPolicy: normalizedPermissionPolicy,
          instructionsPath: instructionsPath ?? undefined,
          instructionsText: instructionsText ?? undefined,
          soul: soul ?? undefined,
          memory: memory ?? undefined,
          bundleConfig: bundleConfig ?? undefined,
          heartbeatProcedurePath: heartbeatProcedurePath ?? undefined,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Agent with name")) {
          res.status(409).json({ error: "Agent with this name already exists", name });
          return;
        }
        throw err;
      }

      // Seed the default heartbeat procedure file if the new agent landed on
      // the per-agent default path (which createAgent fills in for
      // non-ephemeral agents when no override is provided). Idempotent —
      // operator edits are kept.
      const expectedDefaultPath = getDefaultHeartbeatProcedurePath(agent.id, agent.name);
      if (agent.heartbeatProcedurePath === expectedDefaultPath) {
        try {
          await ensureDefaultHeartbeatProcedureFile(scopedStore.getRootDir(), expectedDefaultPath, HEARTBEAT_PROCEDURE);
        } catch {
          // Non-fatal — the heartbeat resolver falls back to the in-memory constant.
        }
      }

      res.status(201).json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("required") || (err instanceof Error ? err.message : String(err)).includes("cannot be empty")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });
}

export function registerAgentCoreRoutes(ctx: ApiRoutesContext, deps: AgentCoreRouteDeps): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const { sanitizeAgentTaskLinks, validateAgentInstructionsPayload, upload } = deps;

  /**
   * GET /api/agents/stats
   * Return aggregate stats across all agents.
   * Must be registered before /agents/:id to avoid "stats" matching :id.
   * Note: assignedTaskCount excludes agents whose linked task is in a terminal state.
   * Includes idleNonEphemeralCount and todoTaskCount to back capacity-risk signaling.
   */
  router.get("/agents/stats", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agents = await agentStore.listAgents();
      const activeCount = agents.filter((a) => a.state === "active" || a.state === "running").length;
      const idleNonEphemeralCount = agents.filter((a) => a.state === "idle" && !isEphemeralAgent(a)).length;

      // Count only agents with non-terminal linked tasks
      const sanitizedAgents = await sanitizeAgentTaskLinks(agents, scopedStore);
      const assignedTaskCount = sanitizedAgents.filter((a) => a.taskId).length;

      const { completedRuns, failedRuns } = await agentStore.getRunStatusCounts();

      const total = completedRuns + failedRuns;
      const successRate = total > 0 ? completedRuns / total : 0;
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const todoTaskCount = tasks.filter((task) => task.column === "todo").length;
      res.json({
        activeCount,
        assignedTaskCount,
        completedRuns,
        failedRuns,
        successRate,
        idleNonEphemeralCount,
        todoTaskCount,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/org-tree
   * Return full agent org chart tree.
   * Must be registered before /agents/:id to avoid "org-tree" matching :id.
   */
  router.get("/agents/org-tree", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const includeEphemeral = req.query.includeEphemeral === "true";
      const tree = await agentStore.getOrgTree({ includeEphemeral });
      res.json(tree);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/resolve/:shortname
   * Resolve an agent by shortname or ID.
   * Must be registered before /agents/:id to avoid "resolve" matching :id.
   */
  router.get("/agents/resolve/:shortname", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agent = await agentStore.resolveAgent(req.params.shortname);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ agent });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id
   * Get agent by ID with heartbeat history.
   * taskId is omitted from response if the linked task is in a terminal state.
   */
  router.get("/agents/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agent = await agentStore.getAgentDetail(req.params.id, 50);
      if (!agent) {
        throw notFound("Agent not found");
      }
      // Sanitize taskId for single-agent responses (omit if linked task is terminal)
      const [sanitizedAgent] = await sanitizeAgentTaskLinks([agent], scopedStore);
      const [agentWithPendingApprovals] = await withPendingApprovalCounts([sanitizedAgent], scopedStore);
      res.json(agentWithPendingApprovals);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/avatar
   * Upload agent avatar image.
   */
  router.post("/agents/:id/avatar", upload.single("file") as import("express").RequestHandler, async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }
      if (!req.file) {
        throw badRequest("No file provided");
      }
      if (req.file.size > MAX_AVATAR_BYTES) {
        throw badRequest("File too large (max 2MB)");
      }
      const ext = AVATAR_MIME_TO_EXT[req.file.mimetype];
      if (!ext) {
        throw badRequest("Invalid mime type");
      }

      const agentDir = path.join(scopedStore.getFusionDir(), "agents", agent.id);
      await mkdir(agentDir, { recursive: true });
      const entries = await readdir(agentDir);
      await Promise.all(entries.filter((entry) => entry.startsWith("avatar.")).map((entry) => rm(path.join(agentDir, entry), { force: true })));
      await writeFile(path.join(agentDir, `avatar.${ext}`), req.file.buffer);

      const updated = await agentStore.updateAgent(agent.id, { imageUrl: `/api/agents/${agent.id}/avatar` });
      res.setHeader("Cache-Control", "no-store");
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/avatar
   * Serve agent avatar image.
   */
  router.get("/agents/:id/avatar", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const agentDir = path.join(scopedStore.getFusionDir(), "agents", agent.id);
      const entries = await readdir(agentDir).catch(() => [] as string[]);
      const avatarFile = entries.find((entry) => entry.startsWith("avatar."));
      if (!avatarFile) {
        throw notFound("Avatar not found");
      }

      const ext = avatarFile.split(".").pop() ?? "";
      const mimeType = Object.entries(AVATAR_MIME_TO_EXT).find(([, value]) => value === ext)?.[0];
      if (!mimeType) {
        throw notFound("Avatar not found");
      }

      const fileBuffer = await readFile(path.join(agentDir, avatarFile));
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(fileBuffer);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/agents/:id/avatar
   * Remove agent avatar image.
   */
  router.delete("/agents/:id/avatar", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const agentDir = path.join(scopedStore.getFusionDir(), "agents", agent.id);
      const entries = await readdir(agentDir).catch(() => [] as string[]);
      await Promise.all(entries.filter((entry) => entry.startsWith("avatar.")).map((entry) => rm(path.join(agentDir, entry), { force: true })));

      const updated = await agentStore.updateAgent(agent.id, { imageUrl: undefined });
      res.setHeader("Cache-Control", "no-store");
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id
   * Update agent fields.
   */
  router.patch("/agents/:id", async (req, res) => {
    try {
      const body = req.body ?? {};
      const updates: AgentUpdateInput = {};

      if ("name" in body) {
        if (body.name !== null && typeof body.name !== "string") {
          throw badRequest("name must be a string");
        }
        updates.name = body.name ?? undefined;
      }

      if ("role" in body) {
        if (body.role !== null && typeof body.role !== "string") {
          throw badRequest("role must be a string");
        }
        updates.role = body.role ?? undefined;
      }

      if ("metadata" in body) {
        if (body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
          throw badRequest("metadata must be an object");
        }
        updates.metadata = body.metadata ?? undefined;
      }

      if ("title" in body) {
        if (body.title !== null && typeof body.title !== "string") {
          throw badRequest("title must be a string");
        }
        updates.title = body.title ?? undefined;
      }

      if ("icon" in body) {
        if (body.icon !== null && typeof body.icon !== "string") {
          throw badRequest("icon must be a string");
        }
        updates.icon = body.icon ?? undefined;
      }

      if ("imageUrl" in body) {
        if (body.imageUrl !== null && typeof body.imageUrl !== "string") {
          throw badRequest("imageUrl must be a string");
        }
        updates.imageUrl = body.imageUrl ?? undefined;
      }

      if ("reportsTo" in body) {
        if (body.reportsTo !== null && typeof body.reportsTo !== "string") {
          throw badRequest("reportsTo must be a string");
        }
        updates.reportsTo = body.reportsTo ?? undefined;
      }

      if ("pauseReason" in body) {
        if (body.pauseReason !== null && typeof body.pauseReason !== "string") {
          throw badRequest("pauseReason must be a string");
        }
        updates.pauseReason = body.pauseReason ?? undefined;
      }

      if ("runtimeConfig" in body) {
        if (body.runtimeConfig !== null && (typeof body.runtimeConfig !== "object" || Array.isArray(body.runtimeConfig))) {
          throw badRequest("runtimeConfig must be an object");
        }
        updates.runtimeConfig = body.runtimeConfig ?? undefined;
      }

      if ("permissions" in body) {
        if (body.permissions !== null && (typeof body.permissions !== "object" || Array.isArray(body.permissions))) {
          throw badRequest("permissions must be an object");
        }
        updates.permissions = body.permissions ?? undefined;
      }

      if ("permissionPolicy" in body) {
        if (body.permissionPolicy !== null) {
          updates.permissionPolicy = parsePermissionPolicyInput(body.permissionPolicy);
        } else {
          updates.permissionPolicy = undefined;
        }
      }

      if ("totalInputTokens" in body) {
        if (body.totalInputTokens !== null && typeof body.totalInputTokens !== "number") {
          throw badRequest("totalInputTokens must be a number");
        }
        updates.totalInputTokens = body.totalInputTokens ?? undefined;
      }

      if ("totalOutputTokens" in body) {
        if (body.totalOutputTokens !== null && typeof body.totalOutputTokens !== "number") {
          throw badRequest("totalOutputTokens must be a number");
        }
        updates.totalOutputTokens = body.totalOutputTokens ?? undefined;
      }

      if (!validateAgentInstructionsPayload(body.instructionsPath, body.instructionsText)) {
        return;
      }
      if ("instructionsPath" in body) {
        updates.instructionsPath = body.instructionsPath ?? undefined;
      }
      if ("instructionsText" in body) {
        updates.instructionsText = body.instructionsText ?? undefined;
      }

      if ("soul" in body) {
        if (body.soul !== null && typeof body.soul !== "string") {
          throw badRequest("soul must be a string");
        }
        if (typeof body.soul === "string" && body.soul.length > 10000) {
          throw badRequest("soul must be at most 10,000 characters");
        }
        updates.soul = body.soul ?? undefined;
      }

      if ("memory" in body) {
        if (body.memory !== null && typeof body.memory !== "string") {
          throw badRequest("memory must be a string");
        }
        if (typeof body.memory === "string" && body.memory.length > 50000) {
          throw badRequest("memory must be at most 50,000 characters");
        }
        updates.memory = body.memory ?? undefined;
      }

      if ("heartbeatProcedurePath" in body) {
        if (body.heartbeatProcedurePath !== null && typeof body.heartbeatProcedurePath !== "string") {
          throw badRequest("heartbeatProcedurePath must be a string");
        }
        if (typeof body.heartbeatProcedurePath === "string" && body.heartbeatProcedurePath.length > 500) {
          throw badRequest("heartbeatProcedurePath must be at most 500 characters");
        }
        updates.heartbeatProcedurePath = body.heartbeatProcedurePath ?? undefined;
      }

      if ("bundleConfig" in body) {
        if (body.bundleConfig !== null) {
          if (typeof body.bundleConfig !== "object" || Array.isArray(body.bundleConfig)) {
            throw badRequest("bundleConfig must be an object");
          }
          if (typeof body.bundleConfig.mode !== "string" || !["managed", "external"].includes(body.bundleConfig.mode)) {
            throw badRequest("bundleConfig.mode must be 'managed' or 'external'");
          }
          if (typeof body.bundleConfig.entryFile !== "string") {
            throw badRequest("bundleConfig.entryFile must be a string");
          }
          if (!Array.isArray(body.bundleConfig.files)) {
            throw badRequest("bundleConfig.files must be an array");
          }
          if (body.bundleConfig.externalPath !== undefined && typeof body.bundleConfig.externalPath !== "string") {
            throw badRequest("bundleConfig.externalPath must be a string");
          }
        }
        updates.bundleConfig = body.bundleConfig ?? undefined;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, updates);
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("cannot be empty")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/upgrade-heartbeat-procedure
   * Backfill an existing agent onto the per-agent default heartbeat
   * procedure file. Sets `heartbeatProcedurePath` to the agent's own
   * `.fusion/agents/<id>/HEARTBEAT.md` and seeds the file with the
   * built-in HEARTBEAT_PROCEDURE if it doesn't exist. Idempotent: existing
   * operator edits to the file are preserved.
   */
  router.post("/agents/:id/upgrade-heartbeat-procedure", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const existing = await agentStore.getAgent(req.params.id);
      if (!existing) {
        throw notFound(`agent ${req.params.id} not found`);
      }

      const targetPath = isCompatibleDefaultHeartbeatPath(existing.heartbeatProcedurePath, existing)
        ? existing.heartbeatProcedurePath!
        : getDefaultHeartbeatProcedurePath(existing.id, existing.name);
      const filePath = await ensureDefaultHeartbeatProcedureFile(
        scopedStore.getRootDir(),
        targetPath,
        HEARTBEAT_PROCEDURE,
      );

      const updated = await agentStore.updateAgent(req.params.id, {
        heartbeatProcedurePath: targetPath,
      });

      res.json({
        agent: updated,
        heartbeatProcedurePath: targetPath,
        procedureFileSeeded: filePath !== null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/agents/:id
   * Delete an agent.
   */
  router.delete("/agents/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      await agentStore.deleteAgent(req.params.id);
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

  /**
   * GET /api/agents/:id/chain-of-command
   * Fetch agent reporting chain from self to top-most manager.
   * Response 200: Agent[] — [self, manager, grand-manager, ...]
   * Response 404: { error: "Agent not found" } — When target agent doesn't exist
   */
  router.get("/agents/:id/chain-of-command", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const chain = await agentStore.getChainOfCommand(req.params.id);
      res.json(chain);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/children
   * Fetch agents that report to a given agent (parent-child hierarchy).
   * Response 200: Agent[] — Array of agents where reportsTo equals :id
   * Response 404: { error: "Agent not found" } — When parent agent doesn't exist
   */
  const getAgentEmployeesHandler = async (req: Request, res: Response) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!agentId) {
        throw badRequest("Agent id is required");
      }

      // Validate the parent agent exists
      const parent = await agentStore.getAgent(agentId);
      if (!parent) {
        throw notFound("Agent not found");
      }

      const children = await agentStore.getAgentsByReportsTo(agentId);
      res.json(children);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  };

  router.get("/agents/:id/children", getAgentEmployeesHandler);

  /**
   * GET /api/agents/:id/employees
   * Alias for /api/agents/:id/children.
   */
  router.get("/agents/:id/employees", getAgentEmployeesHandler);
}
