export type CursorStreamEvent =
  | { kind: "system-init"; sessionId?: string; cwd?: string; model?: string }
  | { kind: "thinking-delta"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-call-started" | "tool-call-completed"; callId?: string; name: string; args?: Record<string, unknown>; result?: unknown }
  | { kind: "result"; sessionId?: string; text?: string; isError: boolean; usage?: unknown }
  | { kind: "unknown" };

/*
FNXC:CursorCli 2026-08-15-15:16:
Cursor's verified stream-json fixture has one JSON object per line, but tool call ids
can contain newlines after parsing. Keep ids opaque and make malformed stream data a
non-fatal unknown event so a partial CLI line cannot crash the engine.
*/
export function parseCursorStreamLine(line: string): CursorStreamEvent {
  if (!line.trim()) return { kind: "unknown" };
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return { kind: "unknown" };
    value = parsed as Record<string, unknown>;
  } catch { return { kind: "unknown" }; }
  const type = value.type;
  const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
  if (type === "system" && value.subtype === "init") return { kind: "system-init", sessionId, cwd: typeof value.cwd === "string" ? value.cwd : undefined, model: typeof value.model === "string" ? value.model : undefined };
  if (type === "thinking" && value.subtype === "delta" && typeof value.text === "string") return { kind: "thinking-delta", text: value.text };
  if (type === "assistant") {
    const message = value.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content.filter((item): item is { text: string } => Boolean(item) && typeof item === "object" && typeof (item as { text?: unknown }).text === "string").map((item) => item.text).join("");
    return text ? { kind: "assistant-text", text } : { kind: "unknown" };
  }
  if (type === "tool_call" && (value.subtype === "started" || value.subtype === "completed")) {
    const call = value.tool_call as Record<string, unknown> | undefined;
    const key = call && Object.keys(call).find((name) => name.endsWith("ToolCall"));
    if (!key) return { kind: "unknown" };
    const details = call[key] as Record<string, unknown> | undefined;
    const name = key.slice(0, -"ToolCall".length) || "unknown";
    return { kind: value.subtype === "started" ? "tool-call-started" : "tool-call-completed", callId: typeof value.call_id === "string" ? value.call_id : undefined, name, args: details?.args && typeof details.args === "object" ? details.args as Record<string, unknown> : undefined, result: details?.result };
  }
  if (type === "result") return { kind: "result", sessionId, text: typeof value.result === "string" ? value.result : undefined, isError: value.is_error === true, usage: value.usage };
  return { kind: "unknown" };
}
