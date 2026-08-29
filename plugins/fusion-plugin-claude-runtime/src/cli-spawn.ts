import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_CODE_CLI_ACP_BINARY = "claude-code-cli-acp";
export interface ClaudeBridgeResolution { kind: "resolved" | "not_resolved"; requested: string; path?: string; reason?: string }
/*
FNXC:ClaudeAcp 2026-07-18-11:55:
The plugin runs both from source (`src/`), a standalone build (`dist/`), and
Fusion's single-file `bundled.js`. Only the first two sit one directory below the
plugin root; bundled.js sits at the root. Resolve the staged bridge relative to
that layout so published CLI sessions do not look in `dist/plugins/bridge`.
*/
function pluginRootDir(): string {
 const moduleDir = dirname(fileURLToPath(import.meta.url));
 return ["src", "dist"].includes(basename(moduleDir)) ? resolve(moduleDir, "..") : moduleDir;
}
/** Resolve only the identity-pinned bridge staged beside this bundled plugin. */
export function bundledClaudeBridgeBinPath(pluginRoot = pluginRootDir()): string {
  return join(pluginRoot, "bridge", `${CLAUDE_CODE_CLI_ACP_BINARY}${process.platform === "win32" ? ".cmd" : ""}`);
}
export function resolveBundledClaudeBridgeBinary(options: { pluginRoot?: string; exists?: (path: string) => boolean } = {}): ClaudeBridgeResolution {
  const candidate = bundledClaudeBridgeBinPath(options.pluginRoot ?? pluginRootDir());
  const exists = options.exists ?? existsSync;
  if (!exists(candidate) || !isAbsolute(candidate)) return { kind: "not_resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY, path: candidate, reason: `Staged ${CLAUDE_CODE_CLI_ACP_BINARY} bridge was not found at ${candidate}` };
  return { kind: "resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY, path: candidate };
}
export async function runClaudeCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => { let stdout="", stderr="", settled=false; const finish=(r:{code:number|null;stdout:string;stderr:string})=>{if(!settled){settled=true;clearTimeout(timer);done(r)}}; const child=spawn(binary,args,{stdio:["ignore","pipe","pipe"],shell:process.platform==="win32"}); const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{ /* process already exited */ } finish({code:124,stdout,stderr})},timeoutMs); child.stdout?.on("data",c=>stdout+=String(c)); child.stderr?.on("data",c=>stderr+=String(c)); child.once("error",e=>finish({code:127,stdout,stderr:`${stderr}${e.message}`})); child.once("close",code=>finish({code,stdout,stderr})); });
}
