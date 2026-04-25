/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import { createHash } from "node:crypto";
import { getCustomToolDefs, writeMcpConfig } from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-cli";

let cachedMcpConfig: { hash: string; configPath: string } | undefined;

/**
 * Resolve the MCP config path for the current request, regenerating it when
 * the set of custom tools changes.
 *
 * Why per-call instead of once-and-lock:
 * - The engine registers session-scoped custom tools (e.g. `fn_review_spec`,
 *   `fn_review_step`) when it spawns triage/executor sessions. These appear
 *   in `pi.getAllTools()` only while that session is active.
 * - A locked-on-first-call cache would freeze in the global tool set and
 *   silently drop session tools, so the Claude CLI subprocess would refuse
 *   to call them ("unknown tool fn_review_spec").
 * - Hashing the tool defs lets us reuse the same temp files when the tool
 *   set is unchanged across calls, and produce fresh files (with the hash
 *   in the filename to avoid races) when it changes.
 *
 * Uses warn-don't-block: failure logs a warning but does not prevent the
 * provider from functioning (built-ins still work).
 */
function ensureMcpConfig(pi: ExtensionAPI): string | undefined {
  try {
    const allTools = pi.getAllTools();

    // Registry not ready yet — fall back to whatever we last computed (if any)
    if (!Array.isArray(allTools)) {
      return cachedMcpConfig?.configPath;
    }

    const toolDefs = getCustomToolDefs(pi);
    if (toolDefs.length === 0) {
      cachedMcpConfig = undefined;
      return undefined;
    }

    const hash = createHash("sha1")
      .update(JSON.stringify(toolDefs))
      .digest("hex")
      .slice(0, 12);

    if (cachedMcpConfig?.hash === hash) {
      return cachedMcpConfig.configPath;
    }

    const configPath = writeMcpConfig(toolDefs, hash);
    cachedMcpConfig = { hash, configPath };
    console.error(
      `[pi-claude-cli] MCP config refreshed with ${toolDefs.length} custom tool(s) (hash=${hash})`,
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
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const catalogModels = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

    // Newer models released after the pinned @mariozechner/pi-ai catalog
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
        const configPath = ensureMcpConfig(pi);
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
