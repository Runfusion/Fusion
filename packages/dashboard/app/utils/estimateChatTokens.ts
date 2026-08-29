export interface ChatTokenEstimateToolCall {
  toolName?: string | null;
  args?: unknown;
  result?: unknown;
}

export interface ChatTokenEstimateMessage {
  content?: string | null;
  thinkingOutput?: string | null;
  toolCalls?: ChatTokenEstimateToolCall[] | null;
}

/*
FNXC:ChatContextWindow 2026-08-22-23:57:
pi-reported contextUsage is the Direct-chat source of truth. This conservative estimate remains the explicitly labelled fallback for sessions without pi usage and the trailing delta after a measured assistant reply, including live streaming text.
*/
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return "";
  }
}

function estimateMessageTokens(message: ChatTokenEstimateMessage): number {
  const toolCallChars = message.toolCalls?.reduce((total, toolCall) => (
    total + (toolCall.toolName?.length ?? 0) + safeStringify(toolCall.args).length + safeStringify(toolCall.result).length
  ), 0) ?? 0;
  const chars = (message.content?.length ?? 0) + (message.thinkingOutput?.length ?? 0) + toolCallChars;
  return Math.ceil(chars / 4);
}

export function estimateChatTokens(messages: ChatTokenEstimateMessage[], streamingText?: string | null): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
    + (streamingText ? Math.ceil(streamingText.length / 4) : 0);
}

export function formatTokenCount(n: number, options: { approximate?: boolean } = {}): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }

  if (n < 1000) {
    return String(Math.round(n));
  }

  const thousands = n / 1000;
  if (thousands < 10 || (options.approximate === false && thousands < 100)) {
    return `${options.approximate === false ? "" : "~"}${Number(thousands.toFixed(1))}k`;
  }

  return `${Math.round(thousands)}k`;
}
