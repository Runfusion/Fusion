/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@earendil-works/pi-ai";
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
} from "./src/mcp-config.js";

/**
 * Route A kill-switch (U11). When `FUSION_CLAUDE_ACP=1` AND a bridge binary path
 * is available (`FUSION_CLAUDE_ACP_BRIDGE`, injected by the engine seam per
 * KTD10), the provider drives Claude through the ACP bridge instead of
 * `claude -p`. OFF by default: the live `-p` path is untouched until soak.
 */
function resolveAcpBridgePath(): string | undefined {
  if (process.env.FUSION_CLAUDE_ACP !== "1") return undefined;
  const p = process.env.FUSION_CLAUDE_ACP_BRIDGE;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/** Resolve custom tool defs the same way ensureMcpConfig does (context → registry). */
function resolveToolDefs(
  pi: ExtensionAPI,
  contextTools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
): McpToolDef[] {
  let toolDefs = toolsFromContext(contextTools);
  if (toolDefs.length === 0 && Array.isArray(pi.getAllTools())) toolDefs = getCustomToolDefs(pi);
  return toolDefs;
}

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

/**
 * Run CLI presence + auth probes at most once per process, asynchronously.
 *
 * The factory below is invoked on every `createFnAgent` call (the dashboard
 * does this per chat message). Doing the probes synchronously with execSync
 * froze the entire Node event loop for a few seconds while `claude` cold-
 * started. Memoizing as a Promise + spawning the probes async means the
 * factory returns immediately and other requests keep flowing; the result
 * is logged once on first run and reused thereafter.
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

/**
 * Resolve the MCP config path for the current request, regenerating it when
 * the set of custom tools changes.
 *
 * Source of truth (in order of preference):
 * 1. `context.tools` — the per-session tool list pi-ai actually hands to
 *    `streamSimple`. This is what the session is asking the model to see, so
 *    it includes session-scoped registrations (e.g. `fn_review_spec` and
 *    `fn_review_step` injected by the engine's triage/executor sessions).
 * 2. `pi.getAllTools()` — fallback for older callers that don't supply
 *    `context.tools`.
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
  contextTools?: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>,
): string | undefined {
  try {
    let toolDefs: McpToolDef[] = toolsFromContext(contextTools);
    if (contextTools && contextTools.length > 0) {
      debugMcp(
        `MCP config from context.tools: ${contextTools.map((tool) => tool.name).join(", ")}`,
      );
    }

    // Fallback to the pi runtime registry if the context didn't carry tools.
    // (Older agent-loop versions don't populate Context.tools for streamSimple.)
    if (toolDefs.length === 0) {
      const allTools = pi.getAllTools();
      if (!Array.isArray(allTools)) {
        return cachedMcpConfig?.configPath;
      }
      toolDefs = getCustomToolDefs(pi);
    }

    if (toolDefs.length === 0) {
      cachedMcpConfig = undefined;
      return undefined;
    }

    const hash = createHash("sha1")
      .update(JSON.stringify(toolDefs))
      .digest("hex")
      .slice(0, 12);

    if (cachedMcpConfig?.hash === hash) {
      debugMcp(`MCP config cache hit (hash=${hash})`);
      return cachedMcpConfig.configPath;
    }

    const configPath = writeMcpConfig(toolDefs, hash);
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

    const catalogModels = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    // Newer models released after the pinned @earendil-works/pi-ai catalog
    // was generated. Dedupe by id so this list is harmless once the upstream
    // catalog catches up.
    // https://platform.claude.com/docs/en/about-claude/models/overview
    const extraModels: typeof catalogModels = [
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ];

    const seen = new Set(catalogModels.map((m) => m.id));
    const models = [
      ...catalogModels,
      ...extraModels.filter((m) => !seen.has(m.id)),
    ];

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
        const contextTools = (context as { tools?: ReadonlyArray<{
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        }> }).tools;

        // Route A (U11): drive Claude through the ACP bridge when the kill-switch
        // is on AND a bridge path is injected. OFF by default → `-p` path below.
        const bridgePath = resolveAcpBridgePath();
        if (bridgePath) {
          const toolDefs = resolveToolDefs(pi, contextTools);
          const hash = createHash("sha1").update(JSON.stringify(toolDefs)).digest("hex").slice(0, 12);
          return streamViaAcp(model, context, {
            ...options,
            bridgePath,
            mcpServers: buildAcpMcpServers(toolDefs, hash),
            // Forward only HOME/PATH so the bridged `claude` authenticates from the
            // login/keychain session (R17); never inherited process.env or API keys.
            bridgeEnv: { HOME: process.env.HOME, PATH: process.env.PATH },
          });
        }

        const configPath = ensureMcpConfig(pi, contextTools);
        return streamViaCli(model, context, {
          ...options,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
