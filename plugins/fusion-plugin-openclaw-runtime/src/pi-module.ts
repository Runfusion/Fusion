/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the OpenClawRuntimeAdapter.
 */

export interface PiAgentSession {
  dispose?: () => Promise<void> | void;
}

export interface PiAgentResult {
  session: PiAgentSession;
  sessionFile?: string;
}

export interface PiAgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _piModule = require("../../../packages/engine/src/pi.js") as {
  createFnAgent: (options: PiAgentOptions) => Promise<PiAgentResult>;
  promptWithFallback: (session: PiAgentSession, prompt: string, options?: unknown) => Promise<void>;
  describeModel: (session: PiAgentSession) => string;
};

export const createFnAgent = _piModule.createFnAgent;
export const promptWithFallback = _piModule.promptWithFallback;
export const describeModel = _piModule.describeModel;
