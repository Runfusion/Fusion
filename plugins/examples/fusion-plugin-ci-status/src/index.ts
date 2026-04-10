import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginSettingSchema,
  PluginRouteDefinition,
} from "@fusion/plugin-sdk";

// ── Types ──────────────────────────────────────────────────────────────────────

interface BranchStatus {
  branch: string;
  status: string;
  lastChecked: string;
  url?: string;
}

// ── Settings Schema ─────────────────────────────────────────────────────────────

const settingsSchema: Record<string, PluginSettingSchema> = {
  ciUrl: {
    type: "string",
    label: "CI API URL",
    description: "Base URL for CI API",
    required: true,
  },
  pollIntervalMs: {
    type: "number",
    label: "Poll Interval (ms)",
    description: "How often to poll CI status",
    defaultValue: 30000,
  },
  branchPrefix: {
    type: "string",
    label: "Branch Prefix",
    description: "Only poll branches with this prefix",
    defaultValue: "fusion/",
  },
};

// ── Module-Level State ─────────────────────────────────────────────────────────

const branchStatuses = new Map<string, BranchStatus>();
let pollInterval: ReturnType<typeof setInterval> | null = null;

// ── CI Polling Logic ───────────────────────────────────────────────────────────

async function pollCIStatus(
  ciUrl: string,
  logger: PluginContext["logger"],
): Promise<void> {
  const branchesToPoll = Array.from(branchStatuses.keys());

  if (branchesToPoll.length === 0) {
    return;
  }

  logger.info(`Polling CI status for ${branchesToPoll.length} branches`);

  try {
    // Try to fetch from the configured CI URL
    const response = await fetch(`${ciUrl}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branches: branchesToPoll }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        statuses?: Array<{ branch: string; status: string; url?: string }>;
      };
      if (data.statuses) {
        for (const s of data.statuses) {
          branchStatuses.set(s.branch, {
            branch: s.branch,
            status: s.status,
            lastChecked: new Date().toISOString(),
            url: s.url,
          });
        }
      }
    }
  } catch (err) {
    // CI polling is best-effort; log and continue
    logger.warn(
      `CI polling failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Route Handlers ─────────────────────────────────────────────────────────────

interface MockRequest {
  params: Record<string, string>;
  method: string;
  url: string;
}

interface MockResponse {
  json: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function getStatusAllHandler(
  _req: MockRequest,
  _ctx: PluginContext,
): { branches: BranchStatus[] } {
  const branches = Array.from(branchStatuses.values());
  return { branches };
}

function getStatusBranchHandler(
  req: MockRequest,
  _ctx: PluginContext,
): { branch: string; status: string; lastChecked: string; url?: string } {
  const branch = req.params.branch;
  const status = branchStatuses.get(branch);

  if (!status) {
    const error = new Error("Branch not found");
    (error as any).statusCode = 404;
    throw error;
  }

  return status;
}

function postRefreshHandler(
  _req: MockRequest,
  ctx: PluginContext,
): { branches: BranchStatus[]; refreshed: boolean } {
  const ciUrl = ctx.settings.ciUrl as string;

  if (ciUrl) {
    // Trigger immediate poll
    pollCIStatus(ciUrl, ctx.logger).catch(() => {
      // Best-effort polling
    });
  }

  const branches = Array.from(branchStatuses.values());
  return { branches, refreshed: true };
}

// ── Plugin Routes ─────────────────────────────────────────────────────────────

const routes: PluginRouteDefinition[] = [
  {
    method: "GET",
    path: "/status",
    handler: getStatusAllHandler as any,
    description: "Get status of all tracked branches",
  },
  {
    method: "GET",
    path: "/status/:branch",
    handler: getStatusBranchHandler as any,
    description: "Get status of a specific branch",
  },
  {
    method: "POST",
    path: "/refresh",
    handler: postRefreshHandler as any,
    description: "Trigger an immediate CI status refresh",
  },
];

// ── Plugin Definition ───────────────────────────────────────────────────────────

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-ci-status",
    name: "CI Status Plugin",
    version: "0.1.0",
    description:
      "Polls CI status for branches and provides a custom API to query results",
    settingsSchema,
  },
  state: "installed",
  routes,
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info("CI Status plugin loaded");

      const pollIntervalMs = (ctx.settings.pollIntervalMs as number) || 30000;

      // Start polling
      pollInterval = setInterval(() => {
        const ciUrl = ctx.settings.ciUrl as string | undefined;
        if (ciUrl) {
          pollCIStatus(ciUrl, ctx.logger).catch(() => {
            // Best-effort polling
          });
        }
      }, pollIntervalMs);

      ctx.logger.info(
        `CI polling started with interval ${pollIntervalMs}ms`,
      );
    },

    onUnload: () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      // Clear branch statuses on unload
      branchStatuses.clear();
    },

    onTaskMoved: (task, fromColumn, toColumn, ctx) => {
      // Track branches for tasks that move to in-progress
      if (toColumn === "in-progress") {
        const branchPrefix = (ctx.settings.branchPrefix as string) || "fusion/";
        const branchName = `${branchPrefix}${task.id.toLowerCase()}`;

        if (!branchStatuses.has(branchName)) {
          branchStatuses.set(branchName, {
            branch: branchName,
            status: "pending",
            lastChecked: new Date().toISOString(),
          });
          ctx.logger.info(`Tracking branch for task ${task.id}: ${branchName}`);
        }
      }

      // Remove from tracking when task is done
      if (toColumn === "done" || toColumn === "archived") {
        const branchPrefix = (ctx.settings.branchPrefix as string) || "fusion/";
        const branchName = `${branchPrefix}${task.id.toLowerCase()}`;
        if (branchStatuses.has(branchName)) {
          branchStatuses.delete(branchName);
          ctx.logger.info(`Stopped tracking branch for task ${task.id}`);
        }
      }
    },
  },
});

export default plugin;
