import type { WorkflowIr } from "@fusion/core";
import { WorkflowCompileError, WorkflowIrError, compileWorkflowToSteps } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

/**
 * Routes for named workflow definitions, IR compilation preview, per-task
 * workflow selection, and the project default workflow. All state changes flow
 * through @fusion/core's TaskStore; none touch the engine's scheduler/executor.
 */
export function registerWorkflowRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  function requireIr(body: unknown): WorkflowIr {
    const ir = (body as { ir?: unknown })?.ir;
    if (!ir || typeof ir !== "object") {
      throw badRequest("ir is required and must be a workflow graph object");
    }
    return ir as WorkflowIr;
  }

  // GET /api/workflows — list all workflow definitions for the project.
  router.get("/workflows", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      res.json(await store.listWorkflowDefinitions());
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/workflows — create a workflow. Body: { name, description?, ir, layout? }
  router.post("/workflows", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const { name, description, layout } = req.body ?? {};
      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      const ir = requireIr(req.body);
      const created = await store.createWorkflowDefinition({ name, description, ir, layout });
      res.status(201).json(created);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof WorkflowIrError) throw badRequest(err.message);
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
      const { store } = await getProjectContext(req);
      const { name, description, ir, layout } = req.body ?? {};
      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        throw badRequest("name must be a non-empty string");
      }
      if (ir !== undefined && (typeof ir !== "object" || ir === null)) {
        throw badRequest("ir must be a workflow graph object");
      }
      const updated = await store.updateWorkflowDefinition(req.params.id, { name, description, ir, layout });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof WorkflowIrError) throw badRequest(err.message);
      if (err instanceof Error && /not found/i.test(err.message)) throw notFound(err.message);
      rethrowAsApiError(err);
    }
  });

  // DELETE /api/workflows/:id
  router.delete("/workflows/:id", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      await store.deleteWorkflowDefinition(req.params.id);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && /not found/i.test(err.message)) throw notFound(err.message);
      rethrowAsApiError(err);
    }
  });

  // POST /api/workflows/:id/compile — preview the compiled WorkflowSteps.
  // 200 with the step set, or 422 when the graph requires the deferred interpreter.
  router.post("/workflows/:id/compile", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const def = await store.getWorkflowDefinition(req.params.id);
      if (!def) throw notFound(`Workflow '${req.params.id}' not found`);
      try {
        res.json({ steps: compileWorkflowToSteps(def.ir) });
      } catch (compileErr: unknown) {
        if (compileErr instanceof WorkflowCompileError || compileErr instanceof WorkflowIrError) {
          throw new ApiError(422, compileErr.message);
        }
        throw compileErr;
      }
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
      res.json({ workflowId: selection?.workflowId ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PUT /api/tasks/:taskId/workflow — select (or clear) a workflow for a task.
  // Body: { workflowId: string | null }
  router.put("/tasks/:taskId/workflow", async (req, res) => {
    try {
      const { store } = await getProjectContext(req);
      const workflowId = (req.body ?? {}).workflowId;
      if (workflowId === null || workflowId === undefined) {
        await store.clearTaskWorkflowSelection(req.params.taskId);
        res.json({ workflowId: null, enabledWorkflowSteps: [] });
        return;
      }
      if (typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }
      let enabledWorkflowSteps: string[] = [];
      try {
        enabledWorkflowSteps = await store.selectTaskWorkflow(req.params.taskId, workflowId);
      } catch (selectErr: unknown) {
        if (selectErr instanceof WorkflowCompileError || selectErr instanceof WorkflowIrError) {
          throw new ApiError(422, selectErr.message);
        }
        if (selectErr instanceof Error && /not found/i.test(selectErr.message)) {
          throw notFound(selectErr.message);
        }
        throw selectErr;
      }
      res.json({ workflowId, enabledWorkflowSteps });
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
      if (!command) throw badRequest("No pending CLI command to approve for this task");
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
      await store.updateTask(req.params.taskId, { status: null, paused: false, pausedReason: null });
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
}
