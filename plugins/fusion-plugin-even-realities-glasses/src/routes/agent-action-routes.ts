import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import {
  acceptReview,
  approvePlan,
  requestReview,
  retryTask,
  returnToAgent,
  startWork,
} from "../agent-actions.js";
import { GlassesInputError } from "../quick-capture.js";
import { agentActionsEnabled } from "../settings.js";
import { requireApiKey } from "./quick-capture-routes.js";

type ActionOrchestrator = typeof startWork;

type HandlerOptions = {
  verb: string;
};

function makeAgentActionHandler(orchestrator: ActionOrchestrator, options: HandlerOptions) {
  return async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
    const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
    if (!auth.ok) return auth.response;

    if (!agentActionsEnabled(ctx.settings)) {
      ctx.logger?.warn?.(`agent action rejected (${options.verb}): enableAgentActions is false`);
      return { status: 403, body: { error: "agent actions are disabled" } };
    }

    const body = (req as { body?: { taskId?: unknown } }).body ?? {};

    try {
      const result = await orchestrator(
        { taskId: body.taskId },
        { taskStore: ctx.taskStore, pluginId: ctx.pluginId },
      );
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof GlassesInputError) {
        return { status: error.status, body: { error: error.message } };
      }
      ctx.logger?.error?.(`${options.verb} failed`, error);
      return { status: 500, body: { error: `${options.verb} failed` } };
    }
  };
}

export const agentActionRoutes: PluginRouteDefinition[] = [
  { method: "POST", path: "/actions/start-work", handler: makeAgentActionHandler(startWork, { verb: "start-work" }) },
  {
    method: "POST",
    path: "/actions/request-review",
    handler: makeAgentActionHandler(requestReview, { verb: "request-review" }),
  },
  { method: "POST", path: "/actions/approve-plan", handler: makeAgentActionHandler(approvePlan, { verb: "approve-plan" }) },
  {
    method: "POST",
    path: "/actions/accept-review",
    handler: makeAgentActionHandler(acceptReview, { verb: "accept-review" }),
  },
  {
    method: "POST",
    path: "/actions/return-to-agent",
    handler: makeAgentActionHandler(returnToAgent, { verb: "return-to-agent" }),
  },
  { method: "POST", path: "/actions/retry", handler: makeAgentActionHandler(retryTask, { verb: "retry" }) },
];
