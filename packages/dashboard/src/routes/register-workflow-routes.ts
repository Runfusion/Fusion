import type { WorkflowDefinition, WorkflowDefinitionKind, WorkflowIr, WorkflowIrNode, WorkflowSettingDefinition, TaskStore } from "@fusion/core";
import { ColumnTraitValidationError, OccupiedColumnsError, InvalidRehomeTargetError, WorkflowIrError, ColumnAgentBindingError, WorkflowSettingRejectionError, SCHEMA_VERSION, assertColumnTraitsValid, layoutForIr, listTraits, listStepParsers, parseWorkflowIr, resolvePlanningSettingsModel, stripApprovalBypassFlags, resolveWorkflowIrById, resolveEffectiveSettingValues, findOrphanedSettingValues, isBuiltinWorkflowId, getBuiltinWorkflow, BUILTIN_WORKFLOW_SETTINGS, AgentStore, validateColumnAgentBindings, resolveWorkflowOptionalSteps, enumeratePromptBearingWorkflowNodes, normalizeWorkflowIcon } from "@fusion/core";
import { buildSessionSkillContextSync, createFnAgent as engineCreateFnAgent, validateCodeNodeSources } from "@fusion/engine";
import { ApiError, badRequest, conflict, notFound, rateLimited } from "../api-error.js";
import { emitWorkflowSseEvent } from "../sse.js";
import type { ApiRoutesContext } from "./types.js";

type SkillPluginRunner = Parameters<typeof buildSessionSkillContextSync>[3];

// ── AI design route DI seam + rate limiter (U7/R11/KTD-6) ─────────────────────
//
// Test-injectable createFnAgent factory, co-located with the route per KTD-6's
// "module-level __setCreateFnAgentForDesign DI seam co-located with the route".
// Defaults to the statically imported engine binding; tests inject a fake that
// captures the prompt and returns canned IR text (no model calls in tests).
let createFnAgentForDesign: typeof engineCreateFnAgent = engineCreateFnAgent;

/** @internal Inject a mock createFnAgent for the workflow-design route tests. */
export function __setCreateFnAgentForDesign(mock: typeof engineCreateFnAgent): void {
  createFnAgentForDesign = mock;
}

/** @internal Reset the design route's createFnAgent to the real engine binding. */
export function __resetCreateFnAgentForDesign(): void {
  createFnAgentForDesign = engineCreateFnAgent;
}

/** Minimal session shape used by the one-shot design turn. Some agent backends
 *  stream text deltas, while CLI-agent-backed sessions only expose messages on
 *  state after prompt() resolves. */
interface DesignAgentSession {
  on?: (event: "text", listener: (delta: string) => void) => void;
  prompt(text: string): Promise<void>;
  dispose?: () => void;
  state?: { messages?: unknown };
}

/** Max design prompt length (chars). Over → 400 (mirrors the bounded prompts on
 *  the other AI routes; generous enough for an edit-with-context instruction). */
const MAX_DESIGN_PROMPT_LENGTH = 4000;

/** Rate limit: max design requests per IP per hour (mirrors /ai/refine-text). */
const MAX_DESIGN_REQUESTS_PER_HOUR = 10;
const DESIGN_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

interface DesignRateLimitEntry {
  count: number;
  firstRequestAt: number;
}

// Dedicated window so design and refine-text don't share a counter. Module-level
// (per-process) exactly like ai-refine's limiter.
const designRateLimits = new Map<string, DesignRateLimitEntry>();

/** Returns true when the IP may make a design request (and records it); false
 *  when the 10/hour window is exhausted. Same shape as ai-refine.checkRateLimit. */
function checkDesignRateLimit(ip: string): boolean {
  const now = Date.now();
  // Prune expired-window entries so the map can't grow unbounded across many
  // distinct IPs (each request triggers a cheap sweep of stale entries).
  for (const [key, value] of designRateLimits) {
    if (now - value.firstRequestAt > DESIGN_RATE_LIMIT_WINDOW_MS) {
      designRateLimits.delete(key);
    }
  }
  const entry = designRateLimits.get(ip);
  if (!entry || now - entry.firstRequestAt > DESIGN_RATE_LIMIT_WINDOW_MS) {
    designRateLimits.set(ip, { count: 1, firstRequestAt: now });
    return true;
  }
  if (entry.count >= MAX_DESIGN_REQUESTS_PER_HOUR) return false;
  entry.count++;
  return true;
}

/** @internal Reset the design rate-limit window (tests). */
export function __resetDesignRateLimit(): void {
  designRateLimits.clear();
}

/** Extract a JSON object from possibly-fenced / prose-wrapped model output.
 *  Mirrors the evaluator/agent-generation precedent (packages/engine
 *  evaluator.ts extractJson): strip a leading ```json fence, else slice from the
 *  first `{` to the last `}`. Kept local — engine helper is not exported and the
 *  constraint forbids engine changes. */
function extractJsonFromText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/** System prompt for the design agent. Describes the WorkflowIr vocabulary
 *  concisely (adapted from fn_workflow_create's tool description) and constrains
 *  the model to emit ONLY a WorkflowIr JSON object. */
const WORKFLOW_DESIGN_SYSTEM_PROMPT = `You are a Fusion workflow architect. Given a description (and optionally a base graph to modify), output a single WorkflowIr JSON object that defines a board workflow.

OUTPUT CONTRACT
- Respond with ONLY the WorkflowIr JSON object. No prose, no explanation, no markdown fences.

WorkflowIr SHAPE
{ "version": "v1", "name": string, "nodes": Node[], "edges": Edge[] }
- Node: { "id": string (unique), "kind": NodeKind, "config"?: object }
- Edge: { "from": nodeId, "to": nodeId, "condition"?: "success" | "failure" }

NODE KINDS (v1)
- "start" — exactly one; the entry node. REQUIRED.
- "end" — exactly one; the terminal node. REQUIRED.
- "prompt" — an agent task. config: { "name": string, "prompt": string }. Encode the
  workflow seam via config.seam = "execute" | "review" | "merge":
  "execute" is the coding/work seam, "review" verifies, "merge" integrates.
- "script" — runs a configured project script. config: { "name": string, "scriptName": string }.
- "gate" — a manual/automatic checkpoint.

EDGES & SEAMS
- Every edge from a prompt seam node should carry a condition: "success" continues
  the happy path; "failure" routes to "end".
- A standard linear coding workflow is: start → execute → review → merge → end, with
  each seam's "success" advancing to the next and its "failure" going to "end".
- Keep it LINEAR unless the description clearly requires branching. The legacy engine
  only runs linear graphs; branches are valid but flagged interpreter-only.

NEVER include "cliSkipApproval" or "autoApprove" in any node config — they are stripped
at this boundary regardless.`;

/**
 * Routes for named workflow definitions, IR compilation preview, per-task
 * workflow selection, and the project default workflow. All state changes flow
 * through @fusion/core's TaskStore; none touch the engine's scheduler/executor.
 */
export function registerWorkflowRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError, options } = ctx;

  function requireIr(body: unknown): WorkflowIr {
    const ir = (body as { ir?: unknown })?.ir;
    if (!ir || typeof ir !== "object") {
      throw badRequest("ir is required and must be a workflow graph object");
    }
    return ir as WorkflowIr;
  }

  /**
   * Save-time `code` node compile validation (KTD-15 handoff). Runs the engine's
   * esbuild transform over every `code` node's source (including nodes nested in
   * foreach templates) and throws a 400 listing the failing nodes BEFORE the IR is
   * persisted, so a workflow with an uncompilable code node can never be saved and
   * deferred to an execution-time failure. A null/non-object IR is left to the
   * store's own validator (this only inspects node arrays it can read).
   */
  async function assertCodeNodesCompile(ir: unknown): Promise<void> {
    const nodes = (ir as { nodes?: unknown })?.nodes;
    if (!Array.isArray(nodes)) return;
    const failures = await validateCodeNodeSources({ nodes: nodes as WorkflowIrNode[] });
    if (failures.length > 0) {
      throw badRequest(
        `Workflow has ${failures.length} code node(s) that failed to compile`,
        { codeNodeErrors: failures },
      );
    }
  }

  /**
   * Resolve the setting DECLARATIONS for a workflow (U6). Mirrors the store's
   * private `resolveWorkflowSettingDeclarations`: the resolved IR's `settings`
   * when present, else the built-in catalog for built-in ids (the defensive belt
   * for graphs that predate the embedded declarations).
   */
  async function resolveSettingDeclarations(
    store: TaskStore,
    workflowId: string,
  ): Promise<WorkflowSettingDefinition[] | undefined> {
    const ir = await resolveWorkflowIrById(store, workflowId);
    const declared = ir.version === "v2" ? ir.settings : undefined;
    if (declared && declared.length > 0) return declared;
    if (isBuiltinWorkflowId(workflowId)) return BUILTIN_WORKFLOW_SETTINGS;
    return declared;
  }

  /**
   * 404 guard for the setting-values routes (consistent with GET /workflows/:id).
   * `resolveWorkflowIrById` / the store value methods silently degrade to the
   * built-in default for an unknown id (so the route would otherwise 200 with
   * empty/built-in data), and `updateWorkflowSettingValues` likewise resolves
   * declarations gracefully — neither throws "not found". Mirror the sibling
   * handlers: an id that is neither a built-in nor an existing custom workflow
   * must surface as `notFound` rather than a silent success.
   */
  async function assertWorkflowExists(store: TaskStore, workflowId: string): Promise<void> {
    if (isBuiltinWorkflowId(workflowId)) return;
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) throw notFound(`Workflow '${workflowId}' not found`);
  }

  async function resolvePromptOverrideDefaults(store: TaskStore, workflowId: string): Promise<Record<string, string>> {
    const builtin = isBuiltinWorkflowId(workflowId) ? getBuiltinWorkflow(workflowId) : undefined;
    const ir = builtin?.ir ?? (await store.getWorkflowDefinition(workflowId))?.ir;
    if (!ir) return {};
    const defaults: Record<string, string> = {};
    for (const entry of enumeratePromptBearingWorkflowNodes(ir)) {
      defaults[entry.nodeId] = entry.prompt;
    }
    return defaults;
  }

  function resolveEffectivePromptOverrides(defaults: Record<string, string>, stored: Record<string, string>): Record<string, string> {
    const effective: Record<string, string> = {};
    for (const [nodeId, prompt] of Object.entries(defaults)) {
      effective[nodeId] = stored[nodeId] ?? prompt;
    }
    return effective;
  }

  /**
   * Write-time column-agent validation (U6, R11/R13). Delegates to the shared
   * `validateColumnAgentBindings` helper in @fusion/core (the SAME gate the
   * `fn_workflow_*` agent tools run), then maps its typed
   * {@link ColumnAgentBindingError} onto an HTTP 400 carrying the structured
   * fields the client UI consumes. Inspects columns BEFORE persisting and never
   * mutates the IR.
   */
  async function assertColumnAgentsExist(
    ir: unknown,
    store: TaskStore,
    confirmPolicyEscalation: boolean,
  ): Promise<void> {
    // Skip store/agent-registry I/O entirely when no column carries a binding.
    const columns = (ir as { columns?: unknown })?.columns;
    if (!Array.isArray(columns) || !columns.some((c) => c?.agent?.agentId)) return;

    const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
    await agentStore.init();
    const settings = await store.getSettings();
    try {
      await validateColumnAgentBindings({ ir, agentStore, settings, confirmPolicyEscalation });
    } catch (err: unknown) {
      if (err instanceof ColumnAgentBindingError) {
        throw badRequest(err.message, {
          columnId: err.columnId,
          agentId: err.agentId,
          ...(err.reason === "policy-escalation" ? { policyEscalation: true } : {}),
        });
      }
      throw err;
    }
  }

  // GET /api/traits — trait catalog for the node editor's trait picker (U10).
  // Returns the registry's listTraits() (built-ins + any registered plugin
  // traits): id, name, description, flags, hook descriptors, and config schema.
  // Session-scoped via getProjectContext exactly like the other workflow routes;
  // no new auth surface. The catalog is registry-backed and read-only, so it
  // does not depend on the project store beyond confirming the session.
  router.get("/traits", async (req, res) => {
    try {
      await getProjectContext(req);
      res.json({
        traits: listTraits().map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          builtin: t.builtin === true,
          flags: t.flags,
          hooks: t.hooks,
          configSchema: t.configSchema,
        })),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/step-parsers — step-parser catalog for the parse-steps node
  // inspector (KTD-12). Returns the registry's listStepParsers() ids (built-ins
  // plus any registered plugin parsers), mirroring GET /api/traits: registry-
  // backed, read-only, and session-scoped via getProjectContext. The editor
  // falls back to the built-in pair if this fetch fails, so it adds no hard
  // dependency on the project store beyond confirming the session.
  router.get("/step-parsers", async (req, res) => {
    try {
      await getProjectContext(req);
      res.json({
        parsers: listStepParsers().map((p) => ({ id: p.id })),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/workflows — list all workflow definitions for the project.
  router.get("/workflows", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      res.json(
        await store.listWorkflowDefinitions({
          includeDisabledBuiltins: req.query.includeDisabledBuiltins === "true",
        }),
      );
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/workflows — create a workflow. Body: { name, description?, ir, layout? }
  router.post("/workflows", async (req, res) => {
    try {
      const { store, projectId } = await getProjectContext(req);
      const { name, description, icon: rawIcon, layout, confirmPolicyEscalation } = req.body ?? {};
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      let icon: string | undefined;
      try {
        icon = normalizeWorkflowIcon(rawIcon);
      } catch (iconErr: unknown) {
        throw badRequest(iconErr instanceof Error ? iconErr.message : "Invalid workflow icon");
      }
      const ir = requireIr(req.body);
      await assertCodeNodesCompile(ir);
      await assertColumnAgentsExist(ir, store, confirmPolicyEscalation === true);
      const created = await store.createWorkflowDefinition({ name, description, icon, ir, layout });
      emitWorkflowSseEvent("workflow:created", created, projectId);
      res.status(201).json(created);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof WorkflowIrError) throw badRequest(err.message);
      // Residual A: server-side trait composition conflict → 400 with the
      // structured violations (consistent with the IR-error 4xx mapping).
      if (err instanceof ColumnTraitValidationError) {
        throw badRequest(err.message, { violations: err.violations });
      }
      rethrowAsApiError(err);
    }
  });

  // GET /api/workflows/:id/optional-steps — resolved optional step metadata.
  router.get("/workflows/:id/optional-steps", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = req.params.id;
      await assertWorkflowExists(store, workflowId);
      const ir = await resolveWorkflowIrById(store, workflowId);
      res.json(resolveWorkflowOptionalSteps(ir));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/workflows/:id
  router.get("/workflows/:id", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const def = await store.getWorkflowDefinition(req.params.id);
      if (!def) throw notFound(`Workflow '${req.params.id}' not found`);
      res.json(def);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PATCH /api/workflows/:id — partial update. Body: { name?, description?, ir?, layout? }
  router.patch("/workflows/:id", async (req, res) => {
    try {
      const { store, projectId } = await getProjectContext(req);
      const { name, description, icon: rawIcon, ir, layout, rehomeTo, confirmPolicyEscalation } = req.body ?? {};
      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        throw badRequest("name must be a non-empty string");
      }
      if (ir !== undefined && (typeof ir !== "object" || ir === null)) {
        throw badRequest("ir must be a workflow graph object");
      }
      if (rehomeTo !== undefined && typeof rehomeTo !== "string") {
        throw badRequest("rehomeTo must be a string column id");
      }
      let icon: string | null | undefined;
      if (rawIcon !== undefined) {
        try {
          icon = normalizeWorkflowIcon(rawIcon) ?? null;
        } catch (iconErr: unknown) {
          throw badRequest(iconErr instanceof Error ? iconErr.message : "Invalid workflow icon");
        }
      }
      if (ir !== undefined) {
        await assertCodeNodesCompile(ir);
        await assertColumnAgentsExist(ir, store, confirmPolicyEscalation === true);
      }
      const updated = await store.updateWorkflowDefinition(req.params.id, {
        name,
        description,
        ir,
        layout,
        ...(rawIcon !== undefined ? { icon } : {}),
        ...(rehomeTo !== undefined ? { rehomeTo } : {}),
      });
      emitWorkflowSseEvent("workflow:updated", updated, projectId);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      // U5 (R20): a flag-ON edit removing an occupied column blocks with a typed
      // error. Surface it as a structured 409 carrying the per-column occupant
      // counts so the client can prompt for a `rehomeTo` target and retry.
      if (err instanceof OccupiedColumnsError) {
        throw conflict(err.message, { workflowId: err.workflowId, occupancies: err.occupancies });
      }
      // A supplied rehomeTo naming a non-existent column is a bad request (400),
      // not a 409 conflict.
      if (err instanceof InvalidRehomeTargetError) {
        throw badRequest(err.message, { workflowId: err.workflowId, rehomeTo: err.rehomeTo });
      }
      if (err instanceof WorkflowIrError) throw badRequest(err.message);
      if (err instanceof ColumnTraitValidationError) {
        throw badRequest(err.message, { violations: err.violations });
      }
      if (err instanceof Error && /not found/i.test(err.message)) throw notFound(err.message);
      rethrowAsApiError(err);
    }
  });

  // DELETE /api/workflows/:id
  router.delete("/workflows/:id", async (req, res) => {
    try {
      const { store, projectId } = await getProjectContext(req);
      await store.deleteWorkflowDefinition(req.params.id);
      emitWorkflowSseEvent("workflow:deleted", { id: req.params.id }, projectId);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && /not found/i.test(err.message)) throw notFound(err.message);
      rethrowAsApiError(err);
    }
  });

  // GET /api/workflows/:id/setting-values — read the per-`(workflowId, project)`
  // setting values for the workflow node editor's Values tab (U6, R5). Returns
  // the raw `stored` map, the `effective` map (stored ?? declaration default,
  // drop-on-orphan KTD-6), and the `orphaned` entries (stored values that no
  // longer validate against the current declarations) for the disclosure.
  router.get("/workflows/:id/setting-values", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = req.params.id;
      await assertWorkflowExists(store, workflowId);
      const projectId = store.getWorkflowSettingsProjectId();
      const declarations = await resolveSettingDeclarations(store, workflowId);
      const stored = store.getWorkflowSettingValues(workflowId, projectId);
      res.json({
        stored,
        effective: resolveEffectiveSettingValues(declarations, stored),
        orphaned: findOrphanedSettingValues(declarations, stored),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PATCH /api/workflows/:id/setting-values — write the per-`(workflowId,
  // project)` setting values (U6, R5). Body: { values: Record<string, unknown> }
  // where a `null` value deletes that key. The store authority validates the
  // patch against the NAMED workflow's declarations; on rejection it throws a
  // typed WorkflowSettingRejectionError → 400 carrying the structured
  // rejections array so the client renders per-field errors. This write path is
  // SEPARATE from the IR save (PATCH /workflows/:id): declarations and values
  // are two distinct authorities (KTD-2).
  router.patch("/workflows/:id/setting-values", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = req.params.id;
      const values = (req.body ?? {}).values;
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw badRequest("values is required and must be an object map of setting id → value (null to delete)");
      }
      await assertWorkflowExists(store, workflowId);
      const projectId = store.getWorkflowSettingsProjectId();
      try {
        const before = store.getWorkflowSettingValues(workflowId, projectId);
        const stored = await store.updateWorkflowSettingValues(
          workflowId,
          projectId,
          values as Record<string, unknown>,
        );
        const declarations = await resolveSettingDeclarations(store, workflowId);
        // Model-lane drift: tasks already pinned to the value being replaced
        // are never auto-resynced (see getModelLaneDrift), so surface them
        // here rather than let the change silently orphan those tasks.
        const modelDrift = store.getModelLaneDrift(workflowId, before, stored).filter((d) => d.taskIds.length > 0);
        res.json({
          stored,
          effective: resolveEffectiveSettingValues(declarations, stored),
          orphaned: findOrphanedSettingValues(declarations, stored),
          ...(modelDrift.length > 0 ? { modelDrift } : {}),
        });
      } catch (writeErr: unknown) {
        // Typed rejection → 400 with the structured rejections so the client can
        // render per-field errors and keep the accepted edits applied.
        if (writeErr instanceof WorkflowSettingRejectionError) {
          throw badRequest(writeErr.message, { rejections: writeErr.rejections });
        }
        throw writeErr;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/workflows/:id/prompt-overrides — read per-project prompt overrides
  // for prompt/gate nodes. Defaults are the shipped/custom IR prompt text, while
  // effective applies the stored nodeId → prompt override map.
  // FNXC:CustomWorkflows 2026-06-21-19:24:
  // The dashboard needs a separate prompt-override route so built-in workflow prompt edits do not pass through the graph-edit PATCH route that remains read-only for built-ins.
  router.get("/workflows/:id/prompt-overrides", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = req.params.id;
      await assertWorkflowExists(store, workflowId);
      const projectId = store.getWorkflowSettingsProjectId();
      const defaults = await resolvePromptOverrideDefaults(store, workflowId);
      const stored = store.getWorkflowPromptOverrides(workflowId, projectId);
      res.json({
        stored,
        effective: resolveEffectivePromptOverrides(defaults, stored),
        defaults,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PATCH /api/workflows/:id/prompt-overrides — merge prompt overrides for a
  // workflow. Body: { overrides: Record<nodeId, string | null> }. Null, empty,
  // and whitespace values reset a node back to its default prompt.
  router.patch("/workflows/:id/prompt-overrides", async (req, res) => {
    try {
      const { store, projectId: sseProjectId } = await getProjectContext(req);
      const workflowId = req.params.id;
      const overrides = (req.body ?? {}).overrides;
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw badRequest("overrides is required and must be an object map of node id → prompt (null to reset)");
      }
      await assertWorkflowExists(store, workflowId);
      const defaults = await resolvePromptOverrideDefaults(store, workflowId);
      const promptNodeIds = new Set(Object.keys(defaults));
      for (const [nodeId, value] of Object.entries(overrides as Record<string, unknown>)) {
        if (!promptNodeIds.has(nodeId)) {
          throw badRequest(`Node '${nodeId}' is not a prompt-bearing node in workflow '${workflowId}'`, { nodeId });
        }
        if (value !== null && typeof value !== "string") {
          throw badRequest(`Override for node '${nodeId}' must be a string or null`, { nodeId });
        }
      }
      const projectId = store.getWorkflowSettingsProjectId();
      const stored = store.updateWorkflowPromptOverrides(
        workflowId,
        projectId,
        overrides as Record<string, string | null>,
      );
      const payload = {
        stored,
        effective: resolveEffectivePromptOverrides(defaults, stored),
        defaults,
      };
      emitWorkflowSseEvent("workflow:updated", (await store.getWorkflowDefinition(workflowId)) ?? { id: workflowId }, sseProjectId);
      res.json(payload);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/tasks/:taskId/workflow — current selection for a task.
  router.get("/tasks/:taskId/workflow", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const selection = store.getTaskWorkflowSelection(req.params.taskId);
      res.json({
        workflowId: selection?.workflowId ?? null,
        enabledWorkflowSteps: selection ? selection.stepIds : null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PUT /api/tasks/:taskId/workflow — select (or clear) a workflow for a task.
  // Body: { workflowId: string | null }
  router.put("/tasks/:taskId/workflow", async (req, res) => {
    try {
      const { store, projectId } = await getProjectContext(req);
      const workflowId = (req.body ?? {}).workflowId;
      // Only an explicit null clears the selection. An omitted field
      // (e.g. a malformed `{}` body) must fail validation rather than
      // silently wiping the task's workflow.
      if (workflowId === undefined) {
        throw badRequest("workflowId is required (string to select, null to clear)");
      }
      if (workflowId === null) {
        await store.clearTaskWorkflowSelection(req.params.taskId);
        /*
        FNXC:CustomWorkflows 2026-06-17-07:21:
        A task-workflow selection or clear changes board lane membership even when the task column is unchanged, because workflow boards group cards by the board-workflows `taskWorkflowIds` mapping. Emit the existing workflow update invalidation after successful mutations so open Board and ListView surfaces refetch that mapping and re-home the card immediately.
        */
        emitWorkflowSseEvent("workflow:updated", { taskId: req.params.taskId, workflowId: null }, projectId);
        res.json({ workflowId: null, enabledWorkflowSteps: [] });
        return;
      }
      if (typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }
      let enabledWorkflowSteps: string[] = [];
      // U5 (R20) switch reconciliation: when the workflowColumns flag is ON, the
      // store re-homes the card to the new workflow's entry column (aborting
      // in-flight work first) unless the new workflow defines its current column.
      // The re-home outcome rides on the response so the UI can reflect the move.
      let reconciliation: { preserved: boolean; fromColumn: string; toColumn: string } | undefined;
      try {
        const result = await store.selectTaskWorkflowAndReconcile(req.params.taskId, workflowId);
        enabledWorkflowSteps = result.enabledWorkflowSteps;
        reconciliation = result.reconciliation;
      } catch (selectErr: unknown) {
        if (selectErr instanceof WorkflowIrError) {
          throw new ApiError(422, selectErr.message);
        }
        if (selectErr instanceof Error && /not found/i.test(selectErr.message)) {
          throw notFound(selectErr.message);
        }
        throw selectErr;
      }
      emitWorkflowSseEvent("workflow:updated", { taskId: req.params.taskId, workflowId }, projectId);
      res.json({ workflowId, enabledWorkflowSteps, ...(reconciliation ? { reconciliation } : {}) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/tasks/:taskId/workflow/approve-cli — approve the raw CLI command
  // the task is currently paused on (trust-on-first-use) and resume the run.
  router.post("/tasks/:taskId/workflow/approve-cli", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const task = await store.getTask(req.params.taskId);
      const reason = task.pausedReason ?? "";
      const match = /^workflow-cli-approval:[^:]+:\s*(.*)$/s.exec(reason);
      // Derive the approved command exclusively from the task's pausedReason.
      // A caller-supplied body.command must never be trusted — accepting it
      // would let any client approve an arbitrary command the task is not
      // actually paused on, bypassing trust-on-first-use entirely.
      const command = match ? match[1].trim() : "";
      // Require an active CLI-approval pause: a non-empty command parsed from
      // pausedReason AND the task actually paused. This rejects approvals
      // against a stale reason string on an already-resumed task.
      if (!task.paused || !command) {
        throw badRequest("No pending CLI command to approve for this task");
      }
      await store.approveWorkflowCliCommand(command);
      await store.updateTask(req.params.taskId, { status: null, paused: false, pausedReason: null });
      res.json({ approved: command });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/tasks/:taskId/workflow/input — submit the user's answer to an
  // await-input node (records a steering comment and resumes the task).
  router.post("/tasks/:taskId/workflow/input", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const text = (req.body?.text as string | undefined)?.trim();
      if (!text) throw badRequest("Input text is required");
      await store.addSteeringComment(req.params.taskId, text);
      // Do NOT clear pausedReason here: runAwaitInputNode checks
      // (live.pausedReason ?? "").startsWith(marker) to confirm this specific
      // node previously paused the task. Clearing it would make every re-run
      // re-pause without ever consuming the answer. The node clears the marker
      // itself once it consumes the input.
      await store.updateTask(req.params.taskId, { status: null, paused: false });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/project/default-workflow
  router.get("/project/default-workflow", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      res.json({ workflowId: (await store.getDefaultWorkflowId()) ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PUT /api/project/default-workflow — Body: { workflowId: string | null }
  router.put("/project/default-workflow", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = (req.body ?? {}).workflowId;
      if (workflowId !== null && typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }
      try {
        await store.setDefaultWorkflowId(workflowId);
      } catch (setErr: unknown) {
        if (setErr instanceof Error && /not found/i.test(setErr.message)) {
          throw notFound(setErr.message);
        }
        throw setErr;
      }
      res.json({ workflowId: workflowId ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c removed POST
  // /api/workflows/migrate-legacy-steps along with the legacy workflow_steps table and its
  // store-level migrator. Workflow steps run graph-native; there is no legacy table to
  // migrate from.

  // GET /api/workflows/:id/export — emit a portable, versioned JSON envelope for
  // a single workflow or fragment (U5/R9/KTD-5). Built-ins are exportable too —
  // the lookup mirrors GET /workflows/:id (built-ins resolved by
  // getWorkflowDefinition). The envelope carries the server's SCHEMA_VERSION so
  // import can version-gate it; the client triggers a file download.
  //
  // FNXC:WorkflowPortability 2026-06-30-00:00:
  // Workflow exports are the operator's portability boundary; include project-scoped setting values and prompt overrides with the graph definition so imports do not silently reset tuned runtime policy or prompt text.
  router.get("/workflows/:id/export", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const def = await store.getWorkflowDefinition(req.params.id);
      if (!def) throw notFound(`Workflow '${req.params.id}' not found`);
      const projectId = store.getWorkflowSettingsProjectId();
      res.json({
        fusionWorkflowExport: 1,
        schemaVersion: SCHEMA_VERSION,
        kind: def.kind,
        name: def.name,
        description: def.description,
        ir: def.ir,
        layout: def.layout,
        ...(def.icon ? { icon: def.icon } : {}),
        settingValues: store.getWorkflowSettingValues(def.id, projectId),
        promptOverrides: store.getWorkflowPromptOverrides(def.id, projectId),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/workflows/import — validate a workflow export envelope at the write
  // boundary and create a fresh definition (U5/R10/KTD-5). Validation order is
  // strict: ANY failure short-circuits with a 4xx and ZERO writes.
  //   1. envelope marker            → 400
  //   2. schemaVersion > server's   → 409 (forward-incompatible)
  //   3. parseWorkflowIr            → 422 (parser message)
  //   4. trait availability         → 422 (names the missing trait)
  //   5. strip cliSkipApproval/autoApprove from every node config (incl. foreach
  //      template nodes) — trust boundary; flagged in the response.
  //   6. setting/prompt restore maps → 400 before or compensating delete after create
  //   7. scriptName existence       → non-blocking WARNINGS
  //   8. fresh id + name collision suffix → store.createWorkflowDefinition
  router.post("/workflows/import", async (req, res) => {
    try {
      const { store, projectId } = await getProjectContext(req);
      const envelope = (req.body ?? {}) as Record<string, unknown>;

      // 1. Envelope marker.
      if (envelope.fusionWorkflowExport !== 1) {
        throw badRequest(
          "Not a Fusion workflow export file (missing or invalid fusionWorkflowExport marker)",
        );
      }

      // 2. Schema version gate: equal/older accepted, newer rejected.
      const schemaVersion = envelope.schemaVersion;
      if (typeof schemaVersion === "number" && schemaVersion > SCHEMA_VERSION) {
        throw conflict(
          `This file was exported from a newer Fusion (schema version ${schemaVersion}); this server supports up to ${SCHEMA_VERSION}. Update Fusion to import it.`,
        );
      }

      // 3. Parse/validate the IR (parser message surfaced as 422).
      let ir: WorkflowIr;
      try {
        ir = parseWorkflowIr(envelope.ir as WorkflowIr);
      } catch (parseErr: unknown) {
        if (parseErr instanceof WorkflowIrError) {
          throw new ApiError(422, parseErr.message);
        }
        throw new ApiError(
          422,
          parseErr instanceof Error ? parseErr.message : "Invalid workflow IR",
        );
      }

      // 4. Trait availability (v2 columns) — names the missing/unknown trait.
      try {
        assertImportTraitsValid(ir);
      } catch (traitErr: unknown) {
        if (traitErr instanceof ColumnTraitValidationError) {
          throw new ApiError(422, traitErr.message);
        }
        throw traitErr;
      }

      // 5. Strip trust-escalating flags from every node config (incl. foreach
      // templates). Operates on the parsed IR so the stored definition can never
      // carry an approval bypass smuggled through an untrusted file.
      const strippedApprovalFlags = stripApprovalFlags(ir);

      // 6. Restore-map trust boundary. Older export envelopes omit these fields;
      // present fields must be object maps and prompt override keys must target
      // prompt-bearing nodes in the imported graph before any definition is written.
      //
      // FNXC:WorkflowPortability 2026-06-30-00:00:
      // Imported setting values and prompt overrides must use the same validation authorities as interactive edits; never trust envelope maps enough to bypass declarations or prompt-bearing node checks.
      const importedSettingValues = readOptionalObjectMap(envelope.settingValues, "settingValues");
      const importedPromptOverrides = readOptionalStringMap(envelope.promptOverrides, "promptOverrides");
      const promptNodeIds = new Set(enumeratePromptBearingWorkflowNodes(ir).map((entry) => entry.nodeId));
      for (const nodeId of Object.keys(importedPromptOverrides)) {
        if (!promptNodeIds.has(nodeId)) {
          throw badRequest(`Node '${nodeId}' is not a prompt-bearing node in imported workflow`, { nodeId });
        }
      }

      // 7. scriptName warnings (non-blocking): a script node referencing a name
      // absent from the project's configured scripts is importable, but flagged.
      const settings = await store.getSettingsFast();
      const knownScripts = new Set(Object.keys(settings.scripts ?? {}));
      const warnings = collectScriptNameWarnings(ir, knownScripts);

      // 8. Fresh id is server-minted by createWorkflowDefinition; resolve a
      // collision-free name (case-sensitive exact match across the merged set,
      // built-ins included).
      const existingNames = new Set(
        (await store.listWorkflowDefinitions()).map((w) => w.name),
      );
      const rawName =
        typeof envelope.name === "string" && envelope.name.trim()
          ? envelope.name.trim()
          : "Imported workflow";
      const name = resolveImportName(rawName, existingNames);

      let icon: string | undefined;
      try {
        icon = normalizeWorkflowIcon(envelope.icon);
      } catch (iconErr: unknown) {
        throw badRequest(iconErr instanceof Error ? iconErr.message : "Invalid workflow icon");
      }

      const kind: WorkflowDefinitionKind =
        envelope.kind === "fragment" ? "fragment" : "workflow";
      const layout =
        envelope.layout && typeof envelope.layout === "object"
          ? (envelope.layout as WorkflowDefinition["layout"])
          : {};

      let workflow: WorkflowDefinition;
      try {
        workflow = await store.createWorkflowDefinition({
          name,
          description:
            typeof envelope.description === "string" ? envelope.description : "",
          icon,
          kind,
          ir,
          layout,
        });
      } catch (createErr: unknown) {
        // The store re-validates IR/traits; surface those as 422 (the envelope is
        // the untrusted input) rather than a 500.
        if (createErr instanceof WorkflowIrError) throw new ApiError(422, createErr.message);
        if (createErr instanceof ColumnTraitValidationError) {
          throw new ApiError(422, createErr.message);
        }
        throw createErr;
      }

      let restoredSettingValues: Record<string, unknown> = {};
      let restoredPromptOverrides: Record<string, string> = {};
      try {
        const workflowProjectId = store.getWorkflowSettingsProjectId();
        if (Object.keys(importedSettingValues).length > 0) {
          restoredSettingValues = await store.updateWorkflowSettingValues(
            workflow.id,
            workflowProjectId,
            importedSettingValues,
          );
        }
        if (Object.keys(importedPromptOverrides).length > 0) {
          restoredPromptOverrides = store.updateWorkflowPromptOverrides(
            workflow.id,
            workflowProjectId,
            importedPromptOverrides,
          );
        }
      } catch (restoreErr: unknown) {
        await store.deleteWorkflowDefinition(workflow.id);
        if (restoreErr instanceof WorkflowSettingRejectionError) {
          throw badRequest(restoreErr.message, { rejections: restoreErr.rejections });
        }
        throw restoreErr;
      }

      emitWorkflowSseEvent("workflow:created", workflow, projectId);
      res.status(201).json({
        workflow,
        strippedApprovalFlags,
        warnings,
        settingValues: restoredSettingValues,
        promptOverrides: restoredPromptOverrides,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/workflows/design — prompt → server-validated WorkflowIr (U7/R11/
  // KTD-6). One-shot, tool-less agent on the planning lane; output is JSON-
  // extracted, parsed, compile-triaged, and approval-flag-stripped. Persists
  // NOTHING — the route returns the IR and the client decides. For the edit flow
  // the client passes `workflowId` (never IR); the persisted base graph is read
  // server-side and folded into the prompt. Rate-limited 10/hour/IP.
  //   prompt empty / > cap              → 400
  //   rate limit exhausted              → 429
  //   unknown workflowId                → 404
  //   invalid JSON / parseWorkflowIr    → 422 (parser message)
  router.post("/workflows/design", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const body = (req.body ?? {}) as { prompt?: unknown; workflowId?: unknown };

      // Validate prompt (bounded length; non-empty).
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        throw badRequest("prompt is required and must be a non-empty string");
      }
      const prompt = body.prompt;
      if (prompt.length > MAX_DESIGN_PROMPT_LENGTH) {
        throw badRequest(`prompt must not exceed ${MAX_DESIGN_PROMPT_LENGTH} characters`);
      }
      if (body.workflowId !== undefined && typeof body.workflowId !== "string") {
        throw badRequest("workflowId must be a string when provided");
      }

      // Rate limit (mirrors /ai/refine-text: 10/hour/IP).
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      if (!checkDesignRateLimit(ip)) {
        throw rateLimited(
          `Rate limit exceeded. Maximum ${MAX_DESIGN_REQUESTS_PER_HOUR} workflow design requests per hour.`,
        );
      }

      // Edit flow: read the persisted base IR server-side (client never posts IR).
      let baseIrJson: string | undefined;
      if (typeof body.workflowId === "string") {
        const baseDef = await store.getWorkflowDefinition(body.workflowId);
        if (!baseDef) throw notFound(`Workflow '${body.workflowId}' not found`);
        baseIrJson = JSON.stringify(baseDef.ir, null, 2);
      }

      // One-shot, tool-less design turn on the planning lane.
      const settings = await store.getSettings();
      const planningModel = resolvePlanningSettingsModel(settings);
      const rootDir = store.getRootDir();
      const skillContext = buildSessionSkillContextSync(null, "executor", rootDir, options?.pluginRunner as SkillPluginRunner);

      /*
      FNXC:WorkflowDesignSkills 2026-06-17-19:33:
      Workflow design is an agent-acting planning lane, so it requests executor fallback skills plus enabled plugin skills when creating the design session.
      */
      const { session } = await createFnAgentForDesign({
        cwd: rootDir,
        systemPrompt: WORKFLOW_DESIGN_SYSTEM_PROMPT,
        tools: "readonly",
        ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
        defaultProvider: planningModel.provider,
        defaultModelId: planningModel.modelId,
        defaultThinkingLevel: settings.defaultThinkingLevel,
      });

      const designSession = session as unknown as DesignAgentSession;
      let output = "";
      designSession.on?.("text", (delta: string) => {
        output += delta;
      });

      const userPrompt = baseIrJson
        ? `Modify the following base workflow per the request below. Output the full updated WorkflowIr.\n\nBASE WORKFLOW IR:\n${baseIrJson}\n\nREQUEST:\n${prompt}`
        : `Design a workflow for the following request:\n\n${prompt}`;
      try {
        await designSession.prompt(userPrompt);
      } finally {
        designSession.dispose?.();
      }

      if (!output.trim()) {
        output = extractLastAssistantText(designSession.state?.messages);
      }

      // Extract JSON (handles fences/prose) → JSON.parse → parseWorkflowIr.
      const candidate = extractJsonFromText(output);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(candidate);
      } catch {
        throw new ApiError(422, "The AI response was not valid JSON.");
      }

      let ir: WorkflowIr;
      try {
        ir = parseWorkflowIr(parsedJson as WorkflowIr);
      } catch (parseErr: unknown) {
        if (parseErr instanceof WorkflowIrError) throw new ApiError(422, parseErr.message);
        throw new ApiError(
          422,
          parseErr instanceof Error ? parseErr.message : "Invalid workflow IR",
        );
      }

      // FNXC:WorkflowDesign 2026-07-01-00:00: parseWorkflowIr (above) is the sole
      // validity gate. The linear WorkflowStep compiler was removed and the graph
      // interpreter runs branching graphs directly, so there is no interpreter-only
      // triage — any structurally valid IR is accepted.

      // Strip trust-escalating flags (shared helper; R11 trust boundary).
      const strippedApprovalFlags = stripApprovalFlags(ir);

      // Deterministic layout for the returned IR (server-side value import).
      const layout = layoutForIr(ir);

      res.json({ ir, layout, strippedApprovalFlags });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
}

function extractLastAssistantText(messages: unknown): string {
  interface AgentMessage {
    role?: unknown;
    type?: unknown;
    content?: unknown;
  }

  const lastMessage = (Array.isArray(messages) ? messages : [])
    .filter((message): message is AgentMessage => Boolean(message) && typeof message === "object")
    .filter((message) => message.role === "assistant" || message.type === "assistant")
    .pop();

  const content = lastMessage?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => (
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ))
      .map((part) => part.text)
      .join("")
      .trim();
  }

  return "";
}

/** Validate trait availability for an imported IR exactly as the store does on
 *  create (v1 IRs with no columns are a no-op). Kept local to the import route so
 *  the 422 fires BEFORE any write — the store would also reject, but importing
 *  must short-circuit on the untrusted envelope, not after a partial write. */
function assertImportTraitsValid(ir: WorkflowIr): void {
  const columns = (ir as { columns?: Parameters<typeof assertColumnTraitsValid>[0] }).columns;
  if (Array.isArray(columns) && columns.length > 0) {
    // Throws ColumnTraitValidationError naming the unknown trait.
    assertColumnTraitsValid(columns);
  }
}

/** Strip `cliSkipApproval`/`autoApprove` from every node config in the IR,
 *  including configs nested inside foreach `template.nodes` (any depth). Returns
 *  true when anything was removed so the response can flag it (R10 trust
 *  boundary). Delegates to the shared @fusion/core helper so the route and the
 *  chat/planning authoring tools cannot diverge. */
function stripApprovalFlags(ir: WorkflowIr): boolean {
  return stripApprovalBypassFlags(ir).stripped;
}

/** Collect non-blocking warnings for script nodes (and any config carrying a
 *  `scriptName`) whose script is absent from the project's configured scripts.
 *  Recurses into foreach templates so nested script nodes are covered too. */
function collectScriptNameWarnings(ir: WorkflowIr, knownScripts: Set<string>): string[] {
  const nodes = (ir as { nodes?: WorkflowIrNode[] }).nodes;
  if (!Array.isArray(nodes)) return [];
  const warnings: string[] = [];
  const visit = (node: WorkflowIrNode): void => {
    const cfg = node.config as Record<string, unknown> | undefined;
    if (cfg && typeof cfg === "object") {
      const scriptName = cfg.scriptName;
      if (typeof scriptName === "string" && scriptName.trim() && !knownScripts.has(scriptName)) {
        warnings.push(
          `Node '${node.id}' references script '${scriptName}', which is not configured in this project. Add it under Settings → Scripts before running this workflow.`,
        );
      }
      const template = (cfg as { template?: { nodes?: unknown } }).template;
      if (template && Array.isArray(template.nodes)) {
        for (const inner of template.nodes as WorkflowIrNode[]) visit(inner);
      }
    }
  };
  for (const node of nodes) visit(node);
  return warnings;
}

/** Case-sensitive exact-match collision policy (R10/KTD-5): append " (imported)"
 *  then " (imported 2)", " (imported 3)" … until the name is unique. */
function resolveImportName(baseName: string, existing: Set<string>): string {
  if (!existing.has(baseName)) return baseName;
  let candidate = `${baseName} (imported)`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${baseName} (imported ${n})`;
    n += 1;
  }
  return candidate;
}

/** Optional workflow-export map parser. Undefined preserves backward compatibility
 *  with older envelopes; any present non-object value is malformed untrusted input. */
function readOptionalObjectMap(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${fieldName} must be an object map when present`);
  }
  return value as Record<string, unknown>;
}

/** Prompt override maps are stricter than generic setting maps because every
 *  override must be runnable prompt text before it can be restored. */
function readOptionalStringMap(value: unknown, fieldName: string): Record<string, string> {
  const map = readOptionalObjectMap(value, fieldName);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string") {
      throw badRequest(`${fieldName}.${key} must be a string prompt override`, { nodeId: key });
    }
  }
  return map as Record<string, string>;
}
