/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the HermesRuntimeAdapter.
 * Tests intercept this module via `vi.mock("../pi-module.js", ...)`. The runtime
 * implementations come from @fusion/engine; the local types provide a loose
 * surface so the adapter doesn't have to depend on @fusion/engine's full types.
 */
import {
  createFnAgent as _createFnAgent,
  promptWithFallback as _promptWithFallback,
  describeModel as _describeModel,
} from "@fusion/engine";

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
  tools?: "coding" | "readonly";
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: Record<string, unknown>) => void;
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

export const createFnAgent = _createFnAgent as unknown as (
  options: PiAgentOptions,
) => Promise<PiAgentResult>;

export const promptWithFallback = _promptWithFallback as unknown as (
  session: PiAgentSession,
  prompt: string,
  options?: unknown,
) => Promise<void>;

export const describeModel = _describeModel as unknown as (session: PiAgentSession) => string;
