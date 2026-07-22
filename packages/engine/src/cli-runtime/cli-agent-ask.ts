import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime } from "../agents/agent-runtime.js";
import { extractJsonObjects } from "../cli-agent/one-shot-session.js";

export type AskAcpOnceFailureReason =
  | "create_session_failed"
  | "turn_failed"
  | "timeout"
  | "abnormal_stop"
  | "dispose_failed";

export type AskAcpOnceResult =
  | { ok: true; text: string; parsed?: Record<string, unknown>; stopReason?: string }
  | { ok: false; reason: AskAcpOnceFailureReason; message: string; text?: string; stopReason?: string };

export interface AskAcpOnceOptions {
  prompt: string;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  recoverJson?: boolean;
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recoverTrailingJson(text: string): Record<string, unknown> | undefined {
  const objects = extractJsonObjects(text);
  return objects.length > 0 ? objects[objects.length - 1] : undefined;
}

function isCleanStop(stopReason: string | undefined): boolean {
  return stopReason === undefined || stopReason === "end_turn";
}

async function disposeSession(
  runtime: AgentRuntime,
  session: AgentSession | undefined,
): Promise<void> {
  if (!session) return;
  const runtimeWithDispose = runtime as AgentRuntime & { dispose?: (session: AgentSession) => Promise<void> | void };
  if (typeof runtimeWithDispose.dispose === "function") {
    await runtimeWithDispose.dispose(session);
    return;
  }
  session.dispose();
}

export async function askAcpOnce(runtime: AgentRuntime, opts: AskAcpOnceOptions): Promise<AskAcpOnceResult> {
  /*
  FNXC:ACP-RouteB 2026-06-14-20:11:
  Planning and validator Route-B seams need a one-turn ACP runner that preserves the previous one-shot shape while using readonly tools only. Accumulate streamed prose, optionally recover a trailing JSON object, and always dispose the ACP session.
  */
  let text = "";
  let session: AgentSession | undefined;
  try {
    /*
     * FNXC:McpConfig 2026-06-26-00:00:
     * `askAcpOnce` is a direct Route-B runtime helper that receives an already-resolved runtime plus readonly prompt options, not a TaskStore or secrets reader. MCP-capable callers must resolve MCP before this seam if they need it.
     */
    const created = await runtime.createSession({
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt ?? "",
      tools: "readonly",
      defaultModelId: opts.model,
      runtimeContext: { sessionPurpose: "cli-agent-ask", toolMode: "readonly" },
      onText: (delta) => {
        text += delta;
      },
    });
    session = created.session;
  } catch (err) {
    return { ok: false, reason: "create_session_failed", message: messageFromError(err), text };
  }

  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const promptPromise = runtime.promptWithFallback(session, opts.prompt).catch((err: unknown) => {
      if (timedOut) return undefined;
      throw err;
    });
    const result = opts.timeoutMs && opts.timeoutMs > 0
      ? await Promise.race([
        promptPromise,
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        }),
      ])
      : await promptPromise;

    if (result === "timeout") {
      timedOut = true;
      return { ok: false, reason: "timeout", message: `ACP prompt timed out after ${opts.timeoutMs}ms`, text };
    }

    const stopReason = typeof result === "object" && result && "stopReason" in result
      ? String((result as { stopReason?: unknown }).stopReason ?? "") || undefined
      : undefined;
    if (!isCleanStop(stopReason)) {
      return {
        ok: false,
        reason: "abnormal_stop",
        message: `ACP prompt ended with stopReason=${stopReason}`,
        text,
        stopReason,
      };
    }

    const parsed = opts.recoverJson ? recoverTrailingJson(text) : undefined;
    return { ok: true, text, ...(parsed ? { parsed } : {}), ...(stopReason ? { stopReason } : {}) };
  } catch (err) {
    return { ok: false, reason: "turn_failed", message: messageFromError(err), text };
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await disposeSession(runtime, session);
    } catch {
      // The turn result is more useful than a best-effort disposal error. Runtimes also own process registries.
    }
  }
}
