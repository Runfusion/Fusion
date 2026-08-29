import { resolveBundledClaudeBridgeBinary, runClaudeCommand } from "./cli-spawn.js";
import type { ClaudeBinaryStatus } from "./types.js";
/** Claude auth belongs to its CLI/ACP bridge; availability never requires a Fusion-visible API key. */
export async function probeClaudeBinary(options?: { timeoutMs?: number; binaryPath?: string }): Promise<ClaudeBinaryStatus> {
 const startedAt=Date.now(); const bridge=resolveBundledClaudeBridgeBinary(); const binary=options?.binaryPath?.trim() || "claude"; const result=await runClaudeCommand(binary,["--version"],options?.timeoutMs ?? 3000);
 if (result.code===0 && bridge.kind==="resolved") return {available:true,authenticated:true,binaryName:binary,binaryPath:bridge.path,version:result.stdout.trim()||undefined,probeDurationMs:Date.now()-startedAt};
 return {available:false,authenticated:false,binaryName:binary,binaryPath:bridge.path,reason:bridge.reason ?? (result.stderr.trim() || "Claude CLI unavailable"),probeDurationMs:Date.now()-startedAt};
}
