import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import { notificationCard } from "../cards.js";
import { GlassesInputError } from "../quick-capture.js";
import type { Notifier } from "../notifier.js";
import { requireApiKey } from "./quick-capture-routes.js";

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  const fallback = Number.isFinite(parsed) ? parsed : 25;
  return Math.max(1, Math.min(100, Math.floor(fallback)));
}

function parseDrain(raw: unknown): boolean {
  return typeof raw === "string" ? raw.toLowerCase() === "true" : false;
}

export function createNotificationRoutes(
  getNotifier: (ctx: PluginContext) => Notifier | undefined,
): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/notifications",
      handler: async (req, ctx) => {
        try {
          const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
          if (!auth.ok) return auth.response;

          const notifier = getNotifier(ctx);
          if (!notifier) return { status: 503, body: { error: "notifier not running" } };

          const query = ((req as { query?: unknown }).query ?? {}) as Record<string, unknown>;
          const limit = parseLimit(query.limit);
          const drain = parseDrain(query.drain);
          const events = drain ? notifier.drainPending(limit) : notifier.peekPending(limit);

          const cards = [];
          for (const event of events) {
            const task = await ctx.taskStore.getTask(event.taskId);
            if (task) cards.push(notificationCard(task as never, event.reason));
          }

          return { status: 200, body: { events, cards, lastPolledAt: notifier.lastPolledAt() } };
        } catch (error) {
          if (error instanceof GlassesInputError) {
            return { status: error.status, body: { error: error.message } };
          }
          ctx.logger?.error?.("notifications failed", error);
          return { status: 500, body: { error: "notifications failed" } };
        }
      },
    },
    {
      method: "POST",
      path: "/notifications/ack",
      handler: async (req, ctx) => {
        try {
          const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
          if (!auth.ok) return auth.response;

          const notifier = getNotifier(ctx);
          if (!notifier) return { status: 503, body: { error: "notifier not running" } };

          const body = ((req as { body?: unknown }).body ?? {}) as { taskIds?: unknown };
          if (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== "string")) {
            return { status: 400, body: { error: "taskIds must be string[]" } };
          }

          const acked = notifier.ack(new Set(body.taskIds));
          return { status: 200, body: { acked } };
        } catch (error) {
          if (error instanceof GlassesInputError) {
            return { status: error.status, body: { error: error.message } };
          }
          ctx.logger?.error?.("notifications failed", error);
          return { status: 500, body: { error: "notifications failed" } };
        }
      },
    },
    {
      method: "POST",
      path: "/notifications/poll-now",
      handler: async (req, ctx) => {
        try {
          const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
          if (!auth.ok) return auth.response;

          const notifier = getNotifier(ctx);
          if (!notifier) return { status: 503, body: { error: "notifier not running" } };

          const events = await notifier.pollOnce();
          return { status: 200, body: { events, polledAt: notifier.lastPolledAt() } };
        } catch (error) {
          if (error instanceof GlassesInputError) {
            return { status: error.status, body: { error: error.message } };
          }
          ctx.logger?.error?.("notifications failed", error);
          return { status: 500, body: { error: "notifications failed" } };
        }
      },
    },
  ];
}
