// Wire protocol types for Droid CLI stream-json NDJSON communication

// NDJSON message types from Droid CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
  /** Present on sub-agent stream events; null/undefined for top-level events. */
  parent_tool_use_id?: string | null;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
  session_id?: string;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  tools?: unknown[];
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index: number; // Claude's content_block index
}

export interface DroidCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface DroidSession {
  model: unknown;
  systemPrompt: string;
  messages: unknown[];
  apiKey: string | undefined;
  thinkingLevel: string | undefined;
  sessionId: string;
  lastModelDescription: string;
  callbacks: DroidCallbacks;
  dispose(): void;
}

export type AgentSession = DroidSession;

export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}
