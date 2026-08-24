import { estimateChatTokens, type ChatTokenEstimateMessage } from "./estimateChatTokens";

export interface ChatContextUsageRecord {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type ChatContextUsageSource = "measured" | "pending" | "estimated";

export interface ChatContextUsageMessage extends ChatTokenEstimateMessage {
  metadata?: unknown;
}

export interface ResolvedChatContextUsage {
  source: ChatContextUsageSource;
  used: number | null;
  total: number;
  approximate: boolean;
  percent: number | null;
}

export function parseChatContextUsage(metadata: unknown): ChatContextUsageRecord | null {
  if (!metadata || typeof metadata !== "object") return null;
  const contextUsage = (metadata as Record<string, unknown>).contextUsage;
  if (!contextUsage || typeof contextUsage !== "object") return null;
  const { tokens, contextWindow, percent } = contextUsage as Record<string, unknown>;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  if (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens))) return null;
  return {
    tokens: tokens === null ? null : Math.max(0, Math.trunc(tokens)),
    contextWindow: Math.max(1, Math.trunc(contextWindow)),
    percent: typeof percent === "number" && Number.isFinite(percent) ? percent : null,
  };
}

export function resolveChatContextUsage({
  messages,
  streamingText,
  fallbackContextWindow,
}: {
  messages: ChatContextUsageMessage[];
  streamingText?: string | null;
  fallbackContextWindow: number | null | undefined;
}): ResolvedChatContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = parseChatContextUsage(messages[index].metadata);
    if (!record) continue;
    if (record.tokens === null) {
      return { source: "pending", used: null, total: record.contextWindow, approximate: false, percent: null };
    }
    const trailing = estimateChatTokens(messages.slice(index + 1), streamingText);
    const used = record.tokens + trailing;
    return {
      source: "measured",
      used,
      total: record.contextWindow,
      approximate: trailing > 0,
      percent: (used / record.contextWindow) * 100,
    };
  }

  if (typeof fallbackContextWindow !== "number" || !Number.isFinite(fallbackContextWindow) || fallbackContextWindow <= 0) {
    return null;
  }
  return {
    source: "estimated",
    used: estimateChatTokens(messages, streamingText),
    total: fallbackContextWindow,
    approximate: true,
    percent: null,
  };
}
