import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  streamViaCli,
  discoverDroidModels,
  validateCliPresenceAsync,
  validateCliAuthAsync,
  killAllProcesses,
  getCustomToolDefs,
  toolsFromContext,
  writeMcpConfig,
  type McpToolDef,
} from "@fusion-plugin-examples/droid-runtime";
import { createHash } from "node:crypto";

process.on("exit", killAllProcesses);

const PROVIDER_ID = "droid-cli";

let cliValidationPromise: Promise<void> | undefined;
type DiscoveredModel = { id: string; name: string; reasoning: boolean; input: Array<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
let discoveredModelsPromise: Promise<DiscoveredModel[]> | undefined;
type StreamSimpleHandler = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]>;

function runCliValidationOnce(): Promise<void> {
  if (cliValidationPromise) return cliValidationPromise;
  cliValidationPromise = (async () => {
    try {
      const presence = await validateCliPresenceAsync();
      if (!presence.ok) {
        console.warn(`[droid-cli] ${presence.error.message}`);
        return;
      }
      await validateCliAuthAsync();
    } catch (error) {
      console.warn("[droid-cli] CLI validation failed; continuing without blocking the session", error);
    }
  })();
  return cliValidationPromise;
}

export async function discoverDroidProviderModels() {
  if (!discoveredModelsPromise) {
    discoveredModelsPromise = (async () => {
      try {
        const ids = Array.from(new Set(await discoverDroidModels()));
        if (ids.length === 0) return [];
        return toProviderModels(ids);
      } catch (error) {
        console.warn("[droid-cli] model auto-discovery failed; registering provider with empty model list", error);
        return [];
      }
    })();
  }
  return discoveredModelsPromise;
}

let cachedMcpConfig: { hash: string; configPath: string } | undefined;

function toProviderModels(ids: string[]): DiscoveredModel[] {
  return ids.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  }));
}

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

    if (toolDefs.length === 0) {
      const allTools = pi.getAllTools();
      if (!Array.isArray(allTools)) return cachedMcpConfig?.configPath;
      toolDefs = getCustomToolDefs(pi);
    }

    if (toolDefs.length === 0) {
      cachedMcpConfig = undefined;
      return undefined;
    }

    const hash = createHash("sha1").update(JSON.stringify(toolDefs)).digest("hex").slice(0, 12);
    if (cachedMcpConfig?.hash === hash) return cachedMcpConfig.configPath;

    const configPath = writeMcpConfig(toolDefs, hash);
    cachedMcpConfig = { hash, configPath };
    return configPath;
  } catch {
    return cachedMcpConfig?.configPath;
  }
}

function registerDroidProvider(pi: ExtensionAPI, models: DiscoveredModel[]) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "droid-cli",
    apiKey: "unused",
    api: "droid-cli",
    models,
    streamSimple: ((model, context, options) => {
      void runCliValidationOnce();
      const configPath = ensureMcpConfig(
        pi,
        (context as { tools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> }).tools,
      );
      return streamViaCli(
        model,
        context as never,
        { ...(options ?? {}), mcpConfigPath: configPath } as never,
      ) as unknown as ReturnType<StreamSimpleHandler>;
    }) as StreamSimpleHandler,
  });
}

export default function (pi: ExtensionAPI) {
  /*
  FNXC:CliRuntime 2026-06-21-18:43:
  Engine and dashboard startup must not start the local Droid CLI merely because the optional extension loaded. Register the provider synchronously with an empty model list, defer validation until an actual droid stream starts, and leave model discovery to explicit picker/status callers so boot with `useDroidCli` enabled still performs zero `droid` spawns.

  FNXC:CliRuntime 2026-06-21-12:00:
  Engine and dashboard startup must not wait for local Droid CLI probes. Every surviving validation/discovery helper remains fire-and-forget, bounded, non-interactive, and resolve-only so a missing or wedged `droid` binary cannot stall extension loading or a session start.
  */

  pi.on("session_start", async () => {
    const allTools = pi.getAllTools();
    if (Array.isArray(allTools)) {
      pi.setActiveTools(allTools.map((t: { name: string }) => t.name));
    }
  });

  try {
    registerDroidProvider(pi, []);
  } catch (err) {
    console.error("[droid-cli] Failed to register provider:", err);
  }
}
