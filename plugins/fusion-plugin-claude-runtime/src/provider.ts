import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { probeClaudeBinary } from "./probe.js";

/*
FNXC:ModelCatalog 2026-10-12-15:26:
FN-9525 makes the installed Pi Anthropic catalog the sole Claude CLI picker source. The binary
probe remains an availability gate only: discovery neither reads credentials nor runs a model-list command.
*/
export type ClaudeProviderModel = {
  id: string;
  label: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: unknown;
  cost: unknown;
};

export type ClaudeProviderDiscovery = {
  models: ClaudeProviderModel[];
  source: string;
  fallbackUsed: boolean;
  reason?: string;
};

export async function discoverClaudeProviderModels(options?: unknown): Promise<ClaudeProviderDiscovery> {
 const settings=options && typeof options === "object" ? options as { binaryPath?: string; timeoutMs?: number } : {};
 const probe=await probeClaudeBinary(settings);
 if (!probe.available) return {models: [], source:"probe", fallbackUsed:true, reason:probe.reason ?? "Claude ACP bridge unavailable"};
 const models = getBuiltinModels("anthropic").map((model) => ({
   id: model.id,
   label: model.name,
   reasoning: model.reasoning,
   contextWindow: model.contextWindow,
   maxTokens: model.maxTokens,
   input: model.input,
   cost: model.cost,
 }));
 return {models, source:"pi-catalog", fallbackUsed:false};
}
