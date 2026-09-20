export type AntigravityStreamEvent =
  | { kind: "assistant-text" | "thinking-delta"; text: string }
  | { kind: "tool-call-started" | "tool-call-completed"; callId?: string; name: string; args?: Record<string, unknown>; result?: unknown; isError?: boolean }
  | { kind: "result"; sessionId?: string; text?: string; isError: boolean }
  | { kind: "unknown" };

/**
 * FNXC:AntigravityStreaming 2026-09-20-18:32:
 * The non-ACP agy stream is an untrusted NDJSON boundary. Malformed and future
 * event shapes must remain local to one line so a provider update cannot crash
 * an unrelated Fusion model session or discard already streamed assistant text.
 */
export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent {
  if (!line.trim()) return { kind: "unknown" };
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return { kind: "unknown" };
    event = parsed as Record<string, unknown>;
  } catch {
    return { kind: "unknown" };
  }
  const type = event.type;
  const text = typeof event.text === "string" ? event.text : undefined;
  if (type === "assistant.delta" && text !== undefined) return { kind: "assistant-text", text };
  if (type === "thinking.delta" && text !== undefined) return { kind: "thinking-delta", text };
  if ((type === "tool.call.start" || type === "tool.call.result" || type === "tool.call.error") && typeof event.name === "string") {
    return {
      kind: type === "tool.call.start" ? "tool-call-started" : "tool-call-completed",
      callId: typeof event.id === "string" ? event.id : undefined,
      name: event.name,
      args: event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : undefined,
      result: event.result,
      isError: type === "tool.call.error",
    };
  }
  if ((type === "result" || type === "error") && (typeof event.is_error === "boolean" || type === "error")) {
    return { kind: "result", sessionId: typeof event.session_id === "string" ? event.session_id : undefined, text, isError: type === "error" || event.is_error === true };
  }
  return { kind: "unknown" };
}
