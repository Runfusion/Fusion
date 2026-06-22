/**
 * Shared chat type definitions used by `useChat` and the
 * `createChatStreamHandlers` factory. Keeping the types here lets the
 * streaming-handler factory live in its own file without re-importing from the
 * hook (which would create an awkward parent→sibling dependency cycle).
 */

export interface ToolCallInfo {
  toolName: string;
  args?: Record<string, unknown>;
  isError: boolean;
  result?: unknown;
  status: "running" | "completed";
}

export interface FallbackInfo {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
}

export interface FailureReferenceInfo {
  kind: string;
  id: string;
  label?: string;
}

export interface FailureInfo {
  summary: string;
  errorClass?: string;
  code?: string;
  detail?: string;
  reference?: FailureReferenceInfo;
}

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  roomId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  toolCalls?: ToolCallInfo[];
  fallbackInfo?: FallbackInfo;
  failureInfo?: FailureInfo;
  attachments?: Array<{
    id: string;
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    createdAt: string;
  }>;
  createdAt: string;
}
