import { probeClaudeBinary } from "./probe.js";
const KNOWN_CLAUDE_MODELS = ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-haiku-20241022"];
export async function discoverClaudeProviderModels(options?: unknown) {
 const settings=options && typeof options === "object" ? options as { binaryPath?: string; timeoutMs?: number } : {};
 const probe=await probeClaudeBinary(settings);
 if (!probe.available) return {models: [], source:"probe", fallbackUsed:true, reason:probe.reason ?? "Claude ACP bridge unavailable"};
 return {models: KNOWN_CLAUDE_MODELS.map((id)=>({id,label:id})), source:"known", fallbackUsed:false};
}
