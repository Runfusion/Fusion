/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

/*
 * FNXC:ModelCatalog 2026-07-01-17:30:
 * pi-ai 0.80 restructured its static catalog API: the top-level `getModels`
 * export moved to the deprecated `/compat` shim, and the canonical accessor is
 * `getBuiltinModels` from `@earendil-works/pi-ai/providers/all`. pi-claude-cli
 * now pins `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to
 * `^0.80.3` (matching cli/engine) so the whole extension resolves one pi-ai
 * version and the ExtensionAPI stream types stay compatible.
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import { streamViaAcp } from "./src/acp-driver.js";
import {
  validateCliPresenceAsync,
  validateCliAuthAsync,
  killAllProcesses,
} from "./src/process-manager.js";
import { createHash } from "node:crypto";
import {
  getCustomToolDefs,
  toolsFromContext,
  writeMcpConfig,
  buildAcpMcpServers,
  type McpToolDef,
  type UserMcpServerSpec,
} from "./src/mcp-config.js";

/**
 * FNXC:pi-claude-cli 2026-06-27-06:39:
 * Route A drives Claude through the ACP bridge only when `FUSION_CLAUDE_ACP=1`
 * AND a bridge binary path is injected via `FUSION_CLAUDE_ACP_BRIDGE`.
 * OFF by default: the live `claude -p` path stays untouched until soak.
 */
function resolveAcpBridgePath(): string | undefined {
  if (process.env.FUSION_CLAUDE_ACP !== "1") return undefined;
  const p = process.env.FUSION_CLAUDE_ACP_BRIDGE;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/** Resolve custom tool defs the same way ensureMcpConfig does (context → registry). */
function normalizeTranscriptTools(tools: ReturnType<typeof getCurrentTools>): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: Object.fromEntries(Object.entries(tool.parameters)),
  }));
}

function resolveToolDefs(
  pi: ExtensionAPI,
  contextTools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
): McpToolDef[] {
  let toolDefs = toolsFromContext(contextTools);
  if (toolDefs.length === 0 && Array.isArray(pi.getAllTools())) toolDefs = getCustomToolDefs(pi);
  return toolDefs;
}

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

/**
 * FNXC:pi-claude-cli 2026-06-27-06:39:
 * The factory runs per `createFnAgent` call, which the dashboard does for each
 * chat message. Synchronous `execSync` presence + auth probes froze the Node
 * event loop while `claude` cold-started, so memoize the probes as an async
 * Promise: the factory returns immediately, the result logs once, and later
 * calls reuse it.
 */
let cliValidationPromise: Promise<void> | undefined;

function runCliValidationOnce(): Promise<void> {
  if (cliValidationPromise) return cliValidationPromise;
  cliValidationPromise = (async () => {
    const presence = await validateCliPresenceAsync();
    if (!presence.ok) {
      console.warn(`[pi-claude-cli] ${presence.error.message}`);
      return;
    }
    await validateCliAuthAsync();
  })();
  return cliValidationPromise;
}

let cachedMcpConfig: { hash: string; configPath: string } | undefined;
const DEBUG_MCP = process.env.PI_CLAUDE_CLI_DEBUG === "1";

function debugMcp(message: string): void {
  if (!DEBUG_MCP) return;
  console.error(`[pi-claude-cli] ${message}`);
}

function getUserMcpServers(options: unknown): UserMcpServerSpec[] {
  const servers = (options as { mcpServers?: unknown } | undefined)?.mcpServers;
  return Array.isArray(servers) ? servers.filter((server): server is UserMcpServerSpec => Boolean(server && typeof server === "object" && "name" in server)) : [];
}

/**
 * Resolve the MCP config path for the current request, regenerating it when
 * the set of custom tools changes.
 *
 * Source of truth (in order of preference):
 * 1. Pi 0.86 transcript tool declarations, replayed through
 *    `getCurrentTools(context.messages)` so mid-conversation updates survive.
 * 2. `pi.getAllTools()` — fallback when the current transcript has no tools.
 *
 * Why not a single once-and-lock cache:
 * - The engine spawns triage/executor sessions with session-scoped tools.
 *   A locked-on-first-call cache silently drops them and the Claude CLI
 *   subprocess refuses with "unknown tool fn_review_spec".
 * - Hashing the tool defs lets us reuse temp files when the tool set is
 *   unchanged across calls and produce fresh files (with the hash in the
 *   filename to avoid races) when it changes.
 *
 * Uses warn-don't-block: failure logs a warning but does not prevent the
 * provider from functioning (built-ins still work).
 */
function ensureMcpConfig(
  pi: ExtensionAPI,
  contextTools: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>,
  userMcpServers: UserMcpServerSpec[] = [],
): string | undefined {
  try {
    let toolDefs: McpToolDef[] = toolsFromContext(contextTools);
    if (contextTools && contextTools.length > 0) {
      debugMcp(
        `MCP config from current transcript: ${contextTools.map((tool) => tool.name).join(", ")}`,
      );
    }

    // Fallback to the pi runtime registry when the transcript has no current tools.
    if (toolDefs.length === 0) {
      const allTools = pi.getAllTools();
      if (!Array.isArray(allTools)) {
        return cachedMcpConfig?.configPath;
      }
      toolDefs = getCustomToolDefs(pi);
    }

    if (toolDefs.length === 0 && userMcpServers.length === 0) {
      cachedMcpConfig = undefined;
      return undefined;
    }

    const hash = createHash("sha1")
      .update(JSON.stringify({ toolDefs, userMcpServerNames: userMcpServers.map((server) => server.name) }))
      .digest("hex")
      .slice(0, 12);

    if (cachedMcpConfig?.hash === hash) {
      debugMcp(`MCP config cache hit (hash=${hash})`);
      return cachedMcpConfig.configPath;
    }

    const configPath = writeMcpConfig(toolDefs, hash, userMcpServers);
    cachedMcpConfig = { hash, configPath };
    const toolNames = toolDefs.map((t) => t.name).join(", ");
    debugMcp(
      `MCP config refreshed with ${toolDefs.length} custom tool(s) [${toolNames}] (hash=${hash})`,
    );
    return configPath;
  } catch (err) {
    console.warn(
      "[pi-claude-cli] MCP config generation failed, custom tools unavailable:",
      err,
    );
    return cachedMcpConfig?.configPath;
  }
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation: kick off async, memoized presence + auth probes
    // without blocking the factory. Failures surface via warnings; the actual
    // `claude` subprocess in streamViaCli still reports hard errors on send.
    void runCliValidationOnce();

    const catalogModels = getBuiltinModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    /*
    FNXC:ModelCatalog 2026-10-01-02:51:
    Pi 0.86.1 predates the two Claude 5.5 aliases. Add only those local-CLI compatibility rows,
    then dedupe by ID so an upstream catalog row remains authoritative and singular after Pi updates.
    */
    const extraModels: typeof catalogModels = [
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    ];
    const seen = new Set(catalogModels.map((model) => model.id));
    const models = [...catalogModels, ...extraModels.filter((model) => !seen.has(model.id))];

    // Ensure all registered tools are active so pi can execute them.
    // Some tools (find, grep, ls) are registered but not activated by default.
    pi.on("session_start", async () => {
      const allTools = pi.getAllTools();
      if (Array.isArray(allTools)) {
        pi.setActiveTools(allTools.map((t: { name: string }) => t.name));
      }
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: (model, context, options) => {
        /*
        FNXC:PiTranscriptBridge 2026-09-20-16:20:
        Pi 0.86 replaces the retired Context.tools field with transcript system-message deltas. Replay the current prompt and tool declarations before building either local CLI bridge so resumed and branched sessions retain their latest instructions and MCP schemas.
        */
        const contextTools = normalizeTranscriptTools(getCurrentTools(context.messages));
        // FNXC:PiTranscriptBridge 2026-09-20-17:02: Prompt adapters still consume Context.tools for MCP tool-name instructions, so forward Pi's normalized current transcript tools after replacing its retired source field.
        const cliContext = { ...context, systemPrompt: getCurrentSystemPrompt(context.messages), tools: contextTools };

        // FNXC:pi-claude-cli 2026-06-27-06:39: Route A drives Claude through the ACP bridge only when the kill-switch is on AND a bridge path is injected. OFF by default → `-p` path below.
        const bridgePath = resolveAcpBridgePath();
        if (bridgePath) {
          const toolDefs = resolveToolDefs(pi, contextTools);
          const userMcpServers = getUserMcpServers(options);
          const hash = createHash("sha1").update(JSON.stringify({ toolDefs, userMcpServerNames: userMcpServers.map((server) => server.name) })).digest("hex").slice(0, 12);
          return streamViaAcp(model, cliContext as never, {
            ...options,
            bridgePath,
            mcpServers: buildAcpMcpServers(toolDefs, hash, userMcpServers),
            // FNXC:pi-claude-cli 2026-06-27-06:39: Forward only HOME/PATH so the bridged `claude` authenticates from the login/keychain session (R17); never inherited process.env or API keys.
            bridgeEnv: { HOME: process.env.HOME, PATH: process.env.PATH },
          });
        }

        const configPath = ensureMcpConfig(pi, contextTools, getUserMcpServers(options));
        return streamViaCli(model, cliContext as never, {
          ...options,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
