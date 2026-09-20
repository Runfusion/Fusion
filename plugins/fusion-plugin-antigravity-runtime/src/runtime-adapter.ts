import { runAntigravityCliCommand } from "./cli-spawn.js";
import { AntigravityMcpConfigTransaction } from "./mcp-config-transaction.js";
import { launchAntigravityPrompt } from "./prompt-transport.js";
import { startAntigravityToolBridge } from "./tool-bridge.js";
import type { AgentRuntime, AgentRuntimeOptions, AntigravitySession } from "./types.js";

type RuntimeDependencies = {
  startToolBridge?: typeof startAntigravityToolBridge;
  createMcpTransaction?: (binary: string) => Pick<AntigravityMcpConfigTransaction, "stage">;
};

/** FNXC:AntigravityRuntime 2026-09-20-18:32: MCP staging is optional for turn availability, but failed state proof disables only Fusion tools and never risks operator configuration. */
export class AntigravityRuntimeAdapter implements AgentRuntime {
  readonly id = "antigravity";
  readonly name = "Google Antigravity Runtime";
  constructor(private readonly settings?: Record<string, unknown>, private readonly dependencies: RuntimeDependencies = {}) {}
  async createSession(options: AgentRuntimeOptions) {
    const binary = typeof this.settings?.antigravityCliBinaryPath === "string" && this.settings.antigravityCliBinaryPath.trim() ? this.settings.antigravityCliBinaryPath.trim() : "agy";
    const session: AntigravitySession = { model: (options.defaultModelId?.replace(/^antigravity-cli\//, "") || "auto"), cwd: options.cwd, systemPrompt: options.systemPrompt, callbacks: { onText: options.onText, onThinking: options.onThinking, onToolStart: options.onToolStart, onToolEnd: options.onToolEnd }, messages: [], disposed: false, dispose: async () => { if (session.disposed) return; session.disposed = true; session.activeAbortController?.abort(); await session.mcpLease?.dispose().catch(() => undefined); await session.toolBridge?.dispose().catch(() => undefined); } };
    if (options.fusionTools?.length) {
      let toolBridge: Awaited<ReturnType<typeof startAntigravityToolBridge>> = null;
      try {
        toolBridge = await (this.dependencies.startToolBridge ?? startAntigravityToolBridge)(options.fusionTools);
        if (toolBridge) {
          const transaction = this.dependencies.createMcpTransaction?.(binary) ?? new AntigravityMcpConfigTransaction((args) => runAntigravityCliCommand(binary, args));
          session.mcpLease = await transaction.stage(toolBridge.serverEntry);
          session.toolBridge = toolBridge;
        }
      } catch (error) {
        /**
         * FNXC:AntigravityBridgeStagingCleanup 2026-09-20-19:37:
         * The bridge is live before MCP staging proves the entry usable. Dispose
         * the local bridge on any staging failure because it is not yet owned by
         * the session and later session disposal cannot reach it.
         */
        await toolBridge?.dispose().catch(() => undefined);
        session.fusionToolBridgeError = { reasonCode: (error as { code?: string }).code ?? "bridge-start-failed" };
      }
    }
    return { session, sessionFile: undefined };
  }
  async promptWithFallback(session: AntigravitySession, prompt: string): Promise<void> {
    if (session.disposed) throw new Error("Antigravity session is disposed.");
    const controller = new AbortController(); session.activeAbortController = controller;
    try { const result = await launchAntigravityPrompt({ binary: typeof this.settings?.antigravityCliBinaryPath === "string" ? this.settings.antigravityCliBinaryPath : undefined, model: session.model, cwd: session.cwd, prompt: `${session.systemPrompt}\n\nUser request:\n${prompt}`, signal: controller.signal, ...session.callbacks }); session.messages.push({ role: "user", content: prompt }, { role: "assistant", content: result.text }); } finally { if (session.activeAbortController === controller) session.activeAbortController = undefined; }
  }
  describeModel(session: AntigravitySession): string { return `antigravity-cli/${session.model}`; }
}
