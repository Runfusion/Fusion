import { definePlugin } from "@fusion/plugin-sdk";
import { COMPOUND_ENGINEERING_SKILLS } from "./skills.js";
import { installBundledCeSkills, resolveDefaultInstallTargetRoot } from "./skill-installation.js";
import {
  installBundledCeAgents,
  resolveDefaultAgentsInstallTargetRoot,
} from "./agent-installation.js";
import { ensureCeSchema } from "./schema.js";
import { createSessionRoutes } from "./routes/session-routes.js";
import { createArtifactRoutes } from "./routes/artifact-routes.js";
import { recoverStaleSessionsForContext } from "./session/session-recovery.js";
import { getCePipelineStore } from "./sync/pipeline-store.js";
import { reconcileCePipelines } from "./sync/reconciler.js";
import { settingsSchema } from "./settings.js";
import { getReconcileOnHooks } from "./settings.js";

export { COMPOUND_ENGINEERING_SKILLS } from "./skills.js";
export {
  installBundledCeSkills,
  resolveBundledSkillsRoot,
  resolveDefaultInstallTargetRoot,
  isPluginLocalPath,
} from "./skill-installation.js";
export {
  installBundledCeAgents,
  resolveBundledAgentsRoot,
  resolveDefaultAgentsInstallTargetRoot,
  isPluginLocalAgentsPath,
} from "./agent-installation.js";
export { ensureCeSchema } from "./schema.js";
export { CeSessionStore, getCeSessionStore } from "./session/session-store.js";
export { CePipelineStore, getCePipelineStore } from "./sync/pipeline-store.js";
export type {
  CePipelineLink,
  CreateCePipelineLinkInput,
  CePipelineState,
  CePipelineStatus,
  CeSyncQueueEntry,
  CeSyncReason,
} from "./sync/pipeline-store.js";
export { CeReconciler, reconcileCePipelines } from "./sync/reconciler.js";
export type { ReconcileResult } from "./sync/reconciler.js";
export {
  CeOrchestrator,
  WORK_STAGE_ID,
  CE_PLUGIN_ID,
  CE_WORK_SOURCE_TYPE,
} from "./session/orchestrator.js";
export { getStage, listPipelineStages, listStages, registerStage } from "./session/stage-registry.js";
export {
  settingsSchema,
  getDefaultProvider,
  getDefaultModelId,
  getDisabledStages,
  getEnabledStages,
  getReconcileOnHooks,
  getReconcileIntervalMinutes,
} from "./settings.js";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-compound-engineering",
    name: "Compound Engineering",
    version: "0.1.0",
    description: "A dedicated dashboard surface for compound-engineering artifacts and interactive ce-* sessions.",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    skills: COMPOUND_ENGINEERING_SKILLS.map((s) => ({ skillId: s.skillId, name: s.name })),
    settingsSchema,
  },
  state: "installed",
  skills: COMPOUND_ENGINEERING_SKILLS,
  hooks: {
    // Idempotent DDL for the plugin-local CE tables (ce_sessions). Runs against
    // the same DB route handlers reach via ctx.taskStore.getDatabase() (U5).
    onSchemaInit: ensureCeSchema,
    // INBOUND board→pipeline sync (U8 / FN-5719). The 5s hook budget
    // (plugin-runner invokeHookSafe) means these MUST be fast: resolve the link,
    // ENQUEUE a sync signal, and return. Heavy advancement (board reads, outbound
    // task creation) happens in the reconciler, NOT inline here. A reconcile
    // drain is fired-and-forgotten (never awaited) so a slow sweep cannot blow
    // the hook budget; correctness does not depend on it firing because the next
    // reconcile() sweep re-derives the transition from board truth.
    onTaskMoved: (task, fromColumn, toColumn, ctx) => {
      const store = getCePipelineStore(ctx);
      const link = store.findByTaskId(task.id);
      if (!link) return; // not a CE-linked task → ignore fast.
      store.enqueueSync({
        cePipelineId: link.cePipelineId,
        taskId: task.id,
        reason: "task_moved",
        fromColumn,
        toColumn,
      });
      // Setting-gated auto-drain (U9): when disabled, the enqueue still happens
      // so an on-demand reconcile (route/refresh) converges later; we just skip
      // the inline sweep.
      if (!getReconcileOnHooks(ctx.settings)) return;
      void Promise.resolve()
        .then(() => reconcileCePipelines(ctx))
        .catch((err) => ctx.logger.warn(`CE reconcile (onTaskMoved) failed: ${String(err)}`));
    },
    onTaskCompleted: (task, ctx) => {
      const store = getCePipelineStore(ctx);
      const link = store.findByTaskId(task.id);
      if (!link) return;
      store.enqueueSync({
        cePipelineId: link.cePipelineId,
        taskId: task.id,
        reason: "task_completed",
        toColumn: "done",
      });
      if (!getReconcileOnHooks(ctx.settings)) return;
      void Promise.resolve()
        .then(() => reconcileCePipelines(ctx))
        .catch((err) => ctx.logger.warn(`CE reconcile (onTaskCompleted) failed: ${String(err)}`));
    },
    // Install the bundled, pinned ce-* SKILL.md files into a plugin-local,
    // discoverable directory on load. The engine ingests
    // PluginSkillContribution only as a name; physical discovery requires the
    // files to exist on a path it scans (U2 finding). Install is provenance-aware:
    // current plugin-local copies are skipped, stale/unmarked copies are refreshed,
    // and global ~/.claude/skills is never touched.
    onLoad: async (ctx) => {
      try {
        const { targetRoot, results } = installBundledCeSkills();
        const installed = results.filter((r) => r.outcome === "installed").length;
        const refreshed = results.filter((r) => r.outcome === "refreshed").length;
        const errored = results.filter((r) => r.outcome === "error");
        if (errored.length > 0) {
          ctx.logger.warn(
            `Compound Engineering: ${errored.length} skill(s) failed to install: ${errored
              .map((e) => `${e.skillId} (${e.reason})`)
              .join(", ")}`,
          );
        }
        ctx.logger.info(
          `Compound Engineering skills ready — installed=${installed} refreshed=${refreshed} target=${targetRoot}`,
        );
        ctx.emitEvent("compound-engineering:skills-installed", { targetRoot, results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error(`Compound Engineering skill install failed: ${message}`);
      }

      // Install the bundled ce-* persona definitions (same posture as skills:
      // pinned, plugin-local, provenance-refreshed, never a global ~/.claude/agents).
      // The CE skills read these and pass them to fn_spawn_agent.systemPromptOverride.
      try {
        const { targetRoot, results } = installBundledCeAgents();
        const installed = results.filter((r) => r.outcome === "installed").length;
        const refreshed = results.filter((r) => r.outcome === "refreshed").length;
        const errored = results.filter((r) => r.outcome === "error");
        if (errored.length > 0) {
          ctx.logger.warn(
            `Compound Engineering: ${errored.length} agent def(s) failed to install: ${errored
              .map((e) => `${e.agentId} (${e.reason})`)
              .join(", ")}`,
          );
        }
        ctx.logger.info(
          `Compound Engineering agent personas ready — installed=${installed} refreshed=${refreshed} target=${targetRoot}`,
        );
        ctx.emitEvent("compound-engineering:agents-installed", { targetRoot, results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error(`Compound Engineering agent install failed: ${message}`);
      }

      recoverStaleSessionsForContext(ctx, { reason: "load", force: true, emitEvent: true });
    },
  },
  // Expose the plugin-local ce-* persona-definition directory to executor /
  // workflow-step sessions via FUSION_CE_AGENTS_DIR. The CE skills read a persona
  // def from here and pass its body to fn_spawn_agent's systemPromptOverride —
  // the lightweight subagent path (no plugin agent-contribution channel exists).
  // Defs are installed in onLoad.
  executorRuntimeEnv: () => ({
    env: {
      FUSION_CE_AGENTS_DIR: resolveDefaultAgentsInstallTargetRoot(),
      // Step sessions run with cwd=projectRoot, so a CE skill can't reach its
      // bundled scripts via a relative `scripts/...` path. Expose the installed
      // skills root so skill docs can invoke scripts by absolute path
      // (`"$FUSION_CE_SKILLS_DIR/<skill-id>/scripts/<name>"`).
      FUSION_CE_SKILLS_DIR: resolveDefaultInstallTargetRoot(),
    },
    description: "compound-engineering ce-* persona definitions and bundled skills directories",
  }),
  routes: [...createSessionRoutes(), ...createArtifactRoutes()],
  dashboardViews: [
    {
      viewId: "compound-engineering",
      label: "Compound Engineering",
      componentPath: "./dashboard-view",
      icon: "Boxes",
      placement: "primary",
      order: 36,
    },
  ],
});

export default plugin;
