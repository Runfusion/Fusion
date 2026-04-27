/**
 * Paperclip Runtime Plugin - Local runtime interface types.
 */

export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

export interface PaperclipSession {
  apiUrl: string;
  apiKey: string | undefined;
  agentId: string;
  companyId: string;
  sessionId: string;
  systemPrompt: string;
  cwd: string;
  onText: ((text: string) => void) | undefined;
  onThinking: ((text: string) => void) | undefined;
  onToolStart: ((toolName: string, args?: unknown) => void) | undefined;
  onToolEnd: ((toolName: string, isError: boolean, result?: unknown) => void) | undefined;
  dispose?: () => void;
}

export interface AgentSessionResult {
  session: PaperclipSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: PaperclipSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: PaperclipSession): string;
  dispose?(session: PaperclipSession): Promise<void>;
}

export interface PaperclipRuntimeConfig {
  apiUrl: string;
  apiKey?: string;
  agentId?: string;
  companyId?: string;
}

export interface RuntimeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type {
  PluginRuntimeManifestMetadata,
  PluginRuntimeFactory,
  PluginRuntimeRegistration,
  FusionPlugin,
} from "@fusion/plugin-sdk";
