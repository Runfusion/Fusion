import { randomUUID } from "node:crypto";
import { launchCursorPrompt } from "./prompt-transport.js";
import { classifyCursorConfigTracking } from "./worktree-hygiene.js";
import { reconcileCursorWorktree, releaseHeldLeasesSync, stageCursorMcpLease } from "./cursor-mcp-config.js";
import { fromCursorToolName } from "./tool-mapping.js";
import { startCursorToolBridge } from "./tool-bridge.js";
import type { CursorToolBridge } from "./tool-bridge.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult, CursorStreamSession } from "./types.js";

/*
FNXC:CursorMcpBridge 2026-08-15-23:46:
A live Cursor session renews its lease below the 15-minute stale threshold so peer reconciliation cannot remove an active bridge during a long turn.
*/
const MCP_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
let exitHookInstalled = false;
function installExitHook() { if (!exitHookInstalled) { exitHookInstalled = true; process.once("exit", () => { try { releaseHeldLeasesSync(); } catch { /* exit hooks must not throw */ } }); } }
function context(options: AgentRuntimeOptions, names: string[] = []): string {
  const skills = Array.isArray(options.skills) ? options.skills.filter((value) => typeof value === "string" && value.trim()) : [];
  return ["Fusion runtime context:", `- Tool mode: ${options.tools ?? "readonly"}`, skills.length ? `- Requested skills: ${skills.join(", ")}` : "", names.length ? `- Fusion MCP tools: ${names.join(", ")}` : ""].filter(Boolean).join("\n");
}

/*
FNXC:CursorMcpBridge 2026-08-15-21:20:
Runtime setup reconciles previous crash residue before staging a tokenized bridge. Staging failure degrades only custom tools, never the Cursor turn.
The exit hook is a latency backstop; journaled reconciliation remains the correctness owner after hard process death.
*/
export class CursorRuntimeAdapter implements AgentRuntime {
  readonly id = "cursor";
  readonly name = "Cursor Runtime";
  constructor(private readonly settings?: Record<string, unknown>) {}
  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    await reconcileCursorWorktree(options.cwd);
    installExitHook();
    const messages: unknown[] = [];
    const session: CursorStreamSession = { model: options.defaultModelId?.replace(/^cursor-cli\//, "") ?? "auto", systemPrompt: options.systemPrompt, messages, state: { messages }, sessionId: "", cwd: options.cwd, tools: options.tools, callbacks: { onText: options.onText, onThinking: options.onThinking, onToolStart: options.onToolStart, onToolEnd: options.onToolEnd }, fusedSystemPrompt: [options.systemPrompt?.trim(), context(options)].filter(Boolean).join("\n\n"), disposed: false, dispose: async () => {
      if (session.disposed) return;
      session.disposed = true;
      session.activeAbortController?.abort();
      if (session.mcpHeartbeatTimer) clearInterval(session.mcpHeartbeatTimer);
      await session.mcpLease?.dispose().catch(() => undefined);
      await session.toolBridge?.dispose().catch(() => undefined);
    } };
    let startingBridge: CursorToolBridge | null = null;
    if (options.fusionTools?.length && classifyCursorConfigTracking(options.cwd) !== "tracked") {
      try {
        startingBridge = await startCursorToolBridge(options.fusionTools);
        if (startingBridge) {
          const serverKey = `fusion-custom-tools-${randomUUID()}`;
          const lease = await stageCursorMcpLease({ worktreePath: options.cwd, serverKey, serverEntry: startingBridge.serverEntry });
          session.toolBridge = startingBridge; session.mcpLease = lease; session.mcpServerKey = serverKey;
          session.mcpHeartbeatTimer = setInterval(() => { void lease.heartbeat().catch(() => undefined); }, MCP_HEARTBEAT_INTERVAL_MS);
          session.mcpHeartbeatTimer.unref?.();
          session.fusedSystemPrompt = [options.systemPrompt?.trim(), context(options, options.fusionTools.map((tool) => `${serverKey}-${tool.name}`))].filter(Boolean).join("\n\n");
          startingBridge = null;
        }
      } catch (error) {
        await startingBridge?.dispose().catch(() => undefined);
        session.fusionToolBridgeError = { reasonCode: (error as { code?: string }).code === "mcp-schema-server-missing" ? "mcp-schema-server-missing" : "bridge-start-failed" };
      }
    } else if (options.fusionTools?.length) session.fusionToolBridgeError = { reasonCode: "bridge-start-failed" };
    return { session, sessionFile: undefined };
  }
  async promptWithFallback(session: CursorStreamSession, prompt: string, _options?: unknown): Promise<void> {
    if (session.disposed) throw new Error("Cursor session is disposed.");
    const priorId = session.sessionId; const first = !priorId;
    const sent = first ? `${session.fusedSystemPrompt}\n\nUser request:\n${prompt}` : prompt;
    const emitted = new Set<string>(); const controller = new AbortController(); session.activeAbortController = controller;
    const map = (name: string) => session.mcpServerKey ? fromCursorToolName(name, session.mcpServerKey) : name;
    try {
      const outcome = await launchCursorPrompt({ binary: typeof this.settings?.cursorCliBinaryPath === "string" ? this.settings.cursorCliBinaryPath : undefined, model: session.model, cwd: session.cwd, tools: session.tools, prompt: sent, resumeId: priorId || undefined, signal: controller.signal, approveMcps: Boolean(session.mcpLease), onThinking: session.callbacks.onThinking, onToolStart: (name, args) => session.callbacks.onToolStart?.(map(name), args), onToolEnd: (name, isError, result) => session.callbacks.onToolEnd?.(map(name), isError, result), onText: (text) => { if (!emitted.has(text)) { emitted.add(text); session.callbacks.onText?.(text); } } });
      session.sessionId = outcome.sessionId ?? session.sessionId; session.messages.push({ role: "user", content: prompt }, { role: "assistant", content: outcome.text });
    } catch (error) { session.sessionId = priorId; throw error; } finally { if (session.activeAbortController === controller) session.activeAbortController = undefined; }
  }
  describeModel(session: CursorStreamSession): string { return `cursor-cli/${(session.model || "auto").replace(/^cursor-cli\//, "")}`; }
}
