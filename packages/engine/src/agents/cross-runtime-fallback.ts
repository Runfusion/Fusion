import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildRuntimeResolutionContext, resolveRuntime, type SessionPurpose } from "../execution/runtime-resolution.js";
import { createLogger } from "../logger.js";
import { isRetryableModelSelectionError, type FallbackModelUsedPayload } from "../pi.js";
import type { RunAuditor } from "../util/run-audit.js";
import { getCliProviderRouting, stripCliProviderPrefix } from "./cli-provider-routing.js";

const fallbackLog = createLogger("cross-runtime-fallback");

export interface DeferredCrossRuntimeFallback {
  providerId: string;
  runtimeId: string;
  modelId: string | undefined;
  thinkingLevel: AgentRuntimeOptions["fallbackThinkingLevel"];
}

export interface TransferableConversationLimits {
  maxTurns: number;
  maxCharsPerTurn: number;
  maxCharsTotal: number;
}

export const TRANSFERABLE_CONVERSATION_LIMITS: TransferableConversationLimits = {
  maxTurns: 10,
  maxCharsPerTurn: 2_000,
  maxCharsTotal: 12_000,
};

/*
FNXC:CliRuntimeRouting 2026-08-16-01:25:
Cross-runtime CLI fallbacks are census-driven because a primary runtime cannot safely interpret a
fallback owned by a different runtime. The routing census declares which fallback pairs may defer;
this seam only withholds and arms an available target, otherwise it preserves the established
warning/drop behavior rather than silently falling through to an unrelated runtime.
*/
export function deferCrossRuntimeCliFallback(
  runtimeOptions: AgentRuntimeOptions,
  pluginRunner: PluginRunner | undefined,
): { options: AgentRuntimeOptions; deferred?: DeferredCrossRuntimeFallback; dropped: boolean } {
  const entry = getCliProviderRouting(runtimeOptions.fallbackProvider);
  if (!entry || entry.fallbackPolicy !== "defer-cross-runtime" || runtimeOptions.defaultProvider === entry.providerId) {
    return { options: runtimeOptions, dropped: false };
  }
  const options: AgentRuntimeOptions = {
    ...runtimeOptions,
    fallbackProvider: undefined,
    fallbackModelId: undefined,
    fallbackThinkingLevel: undefined,
  };
  try {
    if (!entry.runtimeId || !pluginRunner?.getRuntimeById(entry.runtimeId)) {
      return { options, dropped: true };
    }
  } catch {
    return { options, dropped: true };
  }
  return {
    options,
    deferred: {
      providerId: entry.providerId,
      runtimeId: entry.runtimeId,
      modelId: stripCliProviderPrefix(entry.providerId, runtimeOptions.fallbackModelId),
      thinkingLevel: runtimeOptions.fallbackThinkingLevel,
    },
    dropped: false,
  };
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { content?: unknown; text?: unknown; role?: unknown };
  const text = extractTextContent(record.content) ?? (typeof record.text === "string" ? record.text.trim() : undefined);
  if (!text) return undefined;
  const role = typeof record.role === "string" && record.role.trim() ? record.role.trim() : "message";
  return `${role}: ${text}`;
}

/**
 * Capture only portable text from common pi/runtime conversation shapes. This never fabricates a
 * resume token or exports tool/thinking blocks, which are runtime-specific execution state.
 */
export function captureTransferableConversationContext(
  session: unknown,
  limits: TransferableConversationLimits = TRANSFERABLE_CONVERSATION_LIMITS,
): string | undefined {
  try {
    const candidate = session as {
      messages?: unknown;
      state?: { messages?: unknown };
      agent?: { state?: { messages?: unknown } };
      getMessages?: () => unknown;
    };
    const messages = [
      candidate?.messages,
      candidate?.state?.messages,
      candidate?.agent?.state?.messages,
      typeof candidate?.getMessages === "function" ? candidate.getMessages() : undefined,
    ].find(Array.isArray);
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const truncate = (text: string, maxChars: number): string => {
      const boundedMax = Math.max(0, Math.floor(maxChars));
      if (text.length <= boundedMax) return text;
      const marker = " [truncated]";
      if (boundedMax <= marker.length) return text.slice(0, boundedMax);
      return `${text.slice(0, boundedMax - marker.length)}${marker}`;
    };
    const turns = messages.slice(-Math.max(0, Math.floor(limits.maxTurns))).flatMap((message) => {
      const text = extractMessageText(message);
      if (!text) return [];
      return [truncate(text, limits.maxCharsPerTurn)];
    });
    if (turns.length === 0) return undefined;
    const maxCharsTotal = Math.max(0, Math.floor(limits.maxCharsTotal));
    let used = 0;
    const bounded: string[] = [];
    /*
    FNXC:CliRuntimeRouting 2026-08-16-02:05:
    The transferable-context total includes separators as well as turn text. Account for each newline
    before clipping so the serialized transcript never exceeds the documented total character cap.
    */
    for (const turn of turns) {
      const separatorLength = bounded.length > 0 ? 1 : 0;
      const available = maxCharsTotal - used - separatorLength;
      if (available <= 0) break;
      bounded.push(truncate(turn, available));
      used += separatorLength + bounded.at(-1)!.length;
    }
    return bounded.length > 0 ? bounded.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

function failureCategory(message: string): FallbackModelUsedPayload["failureCategory"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("auth") || normalized.includes("api key") || normalized.includes("credential") || normalized.includes("401") || normalized.includes("403")) return "authentication";
  if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("quota")) return "rate-limit";
  return "model-selection";
}

function withTranscript(args: {
  prompt: string;
  transcript: string | undefined;
  primaryProvider: string | undefined;
  primaryModelId: string | undefined;
}): string {
  if (!args.transcript) return args.prompt;
  return `[Transferred prior conversation from ${args.primaryProvider ?? "unknown"}/${args.primaryModelId ?? "unknown"}; partial, text-only, and non-authoritative]\n${args.transcript}\n\n[Current prompt]\n${args.prompt}`;
}

export function armDeferredCrossRuntimeFallback(args: {
  session: AgentSession & { promptWithFallback?: unknown };
  sessionPurpose: SessionPurpose;
  pluginRunner: PluginRunner | undefined;
  runAuditor: RunAuditor | undefined;
  deferred: DeferredCrossRuntimeFallback;
  createOptions: AgentRuntimeOptions;
  primaryProvider: string | undefined;
  primaryModelId: string | undefined;
  onFallbackModelUsed: ((payload: FallbackModelUsedPayload) => Promise<void> | void) | undefined;
  taskId: string | undefined;
  taskTitle: string | undefined;
  auditEventType: "session:grok-cli-fallback-engaged" | "session:cross-runtime-fallback-engaged";
  preserveConversationContext: boolean;
  engagementLabel?: string;
}): void {
  const { session, sessionPurpose, pluginRunner, runAuditor, deferred, createOptions, primaryProvider, primaryModelId, onFallbackModelUsed, taskId, taskTitle, auditEventType, preserveConversationContext } = args;
  const original = session.promptWithFallback as (prompt: string, options?: unknown) => Promise<unknown>;
  const primaryDescription = `${primaryProvider ?? "unknown"}/${primaryModelId ?? "unknown"}`;
  const fallbackDescription = `${deferred.providerId}/${deferred.modelId ?? "unknown"}`;
  type Swap = {
    runtime: Awaited<ReturnType<typeof resolveRuntime>>["runtime"];
    session: AgentSession;
    transferredContext: string | undefined;
  };
  let swap: Swap | undefined;
  let swapPromise: Promise<Swap> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).promptWithFallback = async (prompt: string, promptOptions?: unknown) => {
    if (swap) return swap.runtime.promptWithFallback(swap.session, prompt, promptOptions);
    try {
      return await original(prompt, promptOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableModelSelectionError(message)) throw error;
      let initiatedSwap = false;
      if (!swapPromise) {
        initiatedSwap = true;
        fallbackLog.warn(`[${sessionPurpose}] primary "${primaryDescription}" failed retryably (${message}); engaging deferred ${args.engagementLabel ?? deferred.providerId} fallback "${fallbackDescription}"`);
        /*
        FNXC:CliRuntimeRouting 2026-08-16-02:05:
        A session owns one shared handoff attempt. Concurrent retryable primary failures await the same
        replacement creation, context capture, observer notification, and audit instead of leaking
        duplicate Cursor sessions. A failed attempt clears the fence so later prompts retry the primary;
        every waiter still receives its own original primary error when that handoff cannot be created.
        */
        const attempt = (async (): Promise<Swap> => {
          const resolved = await resolveRuntime(buildRuntimeResolutionContext(sessionPurpose, pluginRunner, deferred.runtimeId));
          if (resolved.runtimeId !== deferred.runtimeId) throw new Error(`${deferred.runtimeId} runtime unavailable at swap time`);
          const fallbackSession = (await resolved.runtime.createSession(createOptions)).session;
          const transferredContext = preserveConversationContext
            ? captureTransferableConversationContext(session)
            : undefined;
          const createdSwap = { runtime: resolved.runtime, session: fallbackSession, transferredContext };
          const disposable = session as unknown as { dispose?: () => Promise<void> | void };
          const originalDispose = typeof disposable.dispose === "function" ? disposable.dispose.bind(session) : undefined;
          disposable.dispose = async () => {
            try { await (fallbackSession as unknown as { dispose?: () => Promise<void> | void }).dispose?.(); } catch { /* best effort */ }
            return originalDispose?.();
          };
          const category = failureCategory(message);
          try {
            await onFallbackModelUsed?.({ primaryModel: primaryDescription, fallbackModel: fallbackDescription, triggerPoint: "prompt-time", taskId, taskTitle, timestamp: new Date().toISOString(), failureCategory: category });
          } catch { /* observer failures must not break the swapped prompt */ }
          try {
            await runAuditor?.database({
              type: auditEventType,
              target: deferred.runtimeId,
              metadata: {
                sessionPurpose,
                primaryProvider: primaryProvider ?? null,
                primaryModelId: primaryModelId ?? null,
                fallbackProvider: deferred.providerId,
                fallbackModelId: deferred.modelId ?? null,
                triggerPoint: "prompt-time",
                failureCategory: category,
                ...(auditEventType === "session:cross-runtime-fallback-engaged" ? { contextTransferred: Boolean(transferredContext) } : {}),
              },
            });
          } catch (auditError) {
            fallbackLog.warn(`[${sessionPurpose}] failed to record ${auditEventType} audit: ${String(auditError)}`);
          }
          swap = createdSwap;
          return createdSwap;
        })();
        swapPromise = attempt;
        void attempt.catch(() => {
          if (swapPromise === attempt) swapPromise = undefined;
        });
      }
      let engagedSwap: Swap;
      try {
        engagedSwap = await swapPromise;
      } catch (swapError) {
        fallbackLog.warn(`[${sessionPurpose}] deferred ${args.engagementLabel ?? deferred.providerId} fallback engagement failed (${String(swapError)}); propagating primary failure`);
        throw error;
      }
      return engagedSwap.runtime.promptWithFallback(
        engagedSwap.session,
        withTranscript({
          prompt,
          transcript: initiatedSwap ? engagedSwap.transferredContext : undefined,
          primaryProvider,
          primaryModelId,
        }),
        promptOptions,
      );
    }
  };
}
