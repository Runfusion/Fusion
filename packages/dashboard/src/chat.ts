/**
 * Chat System — Dashboard AI Integration
 *
 * Manages AI agent chat sessions with SSE streaming for real-time responses.
 * Follows the PlanningStreamManager pattern for SSE broadcast.
 *
 * Features:
 * - AI agent integration via createFnAgent for real-time chat responses
 * - Streaming via SSE (sendMessage) with thinking/text/done/error events
 * - Rate limiting per IP (30 messages per minute)
 * - Message persistence through ChatStore
 * - Session management for conversation history
 */

import type {
  Agent,
  AgentStore,
  ChatMention,
  ChatStore,
  ChatSession,
  ChatSessionCreateInput,
} from "@fusion/core";
import { summarizeTitle } from "@fusion/core";
import { EventEmitter } from "node:events";
import { join, resolve, relative } from "node:path";
import { SessionEventBuffer } from "./sse-buffer.js";

import { createFnAgent as engineCreateFnAgent } from "@fusion/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = engine.createFnAgent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildAgentChatPromptFn: any;

/**
 * Diagnostics logger for the chat module.
 * Provides consistent [chat] prefixed output with test-injectable handlers.
 * Mirrors the pattern established in planning.ts (FN-2225).
 */
interface DiagnosticsLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const defaultDiagnostics: DiagnosticsLogger = {
  log(message: string, ...args: unknown[]) {
    console.log(`[chat] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    console.warn(`[chat] ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]) {
    console.error(`[chat] ${message}`, ...args);
  },
};

let _diagnostics: DiagnosticsLogger = defaultDiagnostics;

/**
 * Get the current diagnostics logger.
 * @internal - exposed for test hook
 */
export function __getChatDiagnostics(): DiagnosticsLogger {
  return _diagnostics;
}

/**
 * Inject a diagnostics logger (test-only).
 * When a logger is injected, all chat module diagnostics route through it.
 * This allows tests to assert on diagnostics without global console spies.
 * @internal - exposed for test hook
 */
export function __setChatDiagnostics(diagnostics: DiagnosticsLogger | null): void {
  _diagnostics = diagnostics ?? defaultDiagnostics;
}

/**
 * Shared diagnostics helper used throughout the chat module.
 * Routes all informational, warning, and error diagnostics through the current logger.
 * Mirrors the pattern from planning.ts (FN-2225).
 */
const diagnostics: DiagnosticsLogger = {
  log(message: string, ...args: unknown[]) {
    _diagnostics.log(message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    _diagnostics.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    _diagnostics.error(message, ...args);
  },
};

async function ensureEngineReady(): Promise<void> {
  if (buildAgentChatPromptFn) {
    return;
  }

  try {
    const engine = await import("@fusion/engine");
    if ("buildAgentChatPrompt" in engine && typeof engine.buildAgentChatPrompt === "function") {
      buildAgentChatPromptFn = engine.buildAgentChatPrompt;
    }
  } catch {
    // Optional helper unavailable in mocked/test contexts.
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Chat system prompt for the AI agent */
const CHAT_SYSTEM_PROMPT = `You are a helpful AI assistant integrated into the fn task board system. You help users with questions about their project, code, architecture, and tasks. You have access to project files and can read them to provide informed responses. Be concise, accurate, and helpful. When referencing files or code, provide specific paths and line numbers when possible.`;

/** Rate limiting window in milliseconds (1 minute) */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Max messages per IP per minute */
const MAX_MESSAGES_PER_IP_PER_MINUTE = 30;

/** Maximum file size for # mentions (50KB). Files larger than this are skipped. */
const MAX_REFERENCED_FILE_SIZE = 50 * 1024;

// ── Types ───────────────────────────────────────────────────────────────────

/** SSE event types for chat streaming */
export type ChatStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "text"; data: string }
  | { type: "tool_start"; data: { toolName: string; args?: Record<string, unknown> } }
  | { type: "tool_end"; data: { toolName: string; isError: boolean; result?: unknown } }
  | { type: "done"; data: { messageId: string } }
  | { type: "error"; data: string };

/** Callback function for streaming events */
export type ChatStreamCallback = (event: ChatStreamEvent, eventId?: number) => void;

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

// ── File Reference Resolution ───────────────────────────────────────────────

/**
 * Validate that a resolved path stays within the base directory.
 * Prevents path traversal attacks (e.g., ../../../etc/passwd).
 * Mirrors the logic from file-service.ts validatePath().
 */
function validateFilePath(basePath: string, filePath: string): string {
  // Reject paths with null bytes
  if (filePath.includes("\0")) {
    throw new Error(`Access denied: Invalid characters in path`);
  }

  // Decode URL-encoded characters for security check
  const decodedPath = decodeURIComponent(filePath);

  // Reject absolute paths
  if (decodedPath.startsWith("/") || decodedPath.match(/^[a-zA-Z]:/)) {
    throw new Error(`Access denied: Absolute paths not allowed`);
  }

  // Resolve the path against base path
  const resolvedBase = resolve(basePath);
  const resolvedPath = resolve(join(resolvedBase, decodedPath));

  // Ensure the resolved path is within the base path
  const relativePath = relative(resolvedBase, resolvedPath);

  if (relativePath.startsWith("..") || relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`Access denied: Path traversal detected`);
  }

  // Additional check: ensure resolved path actually starts with base
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error(`Access denied: Path outside allowed directory`);
  }

  return resolvedPath;
}

/**
 * Resolve #file references from a message and inject their contents.
 *
 * Parses #path/to/file.ext patterns and reads matching file contents.
 * Files larger than MAX_REFERENCED_FILE_SIZE are skipped.
 * Invalid paths (traversal attempts) are silently skipped.
 *
 * @param content - The user message content
 * @param rootDir - The project root directory
 * @returns The content with file context blocks appended
 */
export async function resolveFileReferences(content: string, rootDir: string): Promise<string> {
  // Regex to match #path/to/file.ext patterns (files must have an extension)
  const fileMentionRegex = /#([a-zA-Z0-9._\-/]+\.[a-zA-Z0-9]+)/g;

  // Find all unique file mentions
  const matches = Array.from(content.matchAll(fileMentionRegex), (match) => match[1] ?? "");
  const uniquePaths = [...new Set(matches)];

  if (uniquePaths.length === 0) {
    return content;
  }

  const resolvedFiles: Array<{ path: string; content: string }> = [];
  const fsPromises = await import("node:fs/promises");

  for (const filePath of uniquePaths) {
    try {
      const fullPath = validateFilePath(rootDir, filePath);

      // Check file size before reading
      const stats = await fsPromises.stat(fullPath);
      if (!stats.isFile()) {
        continue;
      }
      if (stats.size > MAX_REFERENCED_FILE_SIZE) {
        continue;
      }

      const fileContent = await fsPromises.readFile(fullPath, "utf-8");
      resolvedFiles.push({ path: filePath, content: fileContent });
    } catch {
      // Skip files that don't exist or have invalid paths
      continue;
    }
  }

  if (resolvedFiles.length === 0) {
    return content;
  }

  // Build the augmented content with file context blocks
  const fileContextBlocks = resolvedFiles
    .map((file) => `[Referenced File: ${file.path}]\n${file.content}\n\n[/Referenced File: ${file.path}]`)
    .join("\n\n");

  return `${content}\n\n${fileContextBlocks}`;
}

// ── Chat Stream Manager ─────────────────────────────────────────────────────

/**
 * Manages SSE connections for active chat sessions.
 * Each session can have multiple connected clients receiving streaming updates.
 * Follows the PlanningStreamManager pattern.
 */
export class ChatStreamManager extends EventEmitter {
  private readonly sessions = new Map<string, Set<ChatStreamCallback>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  /**
   * Register a client callback for a chat session.
   * Returns a function to unsubscribe.
   */
  subscribe(sessionId: string, callback: ChatStreamCallback): () => void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }

    const callbacks = this.sessions.get(sessionId)!;
    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.sessions.delete(sessionId);
      }
    };
  }

  private getBuffer(sessionId: string): SessionEventBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionEventBuffer(this.bufferSize);
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  /**
   * Broadcast an event to all clients subscribed to a session.
   * Every event is buffered and assigned a monotonically increasing id.
   */
  broadcast(sessionId: string, event: ChatStreamEvent): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const callbacks = this.sessions.get(sessionId);
    if (!callbacks) return eventId;

    for (const callback of callbacks) {
      try {
        callback(event, eventId);
      } catch (err) {
        diagnostics.error(`Error broadcasting to client for session ${sessionId}:`, err);
      }
    }

    return eventId;
  }

  /**
   * Get buffered events with id > sinceId for the session.
   */
  getBufferedEvents(sessionId: string, sinceId: number): Array<{ id: number; event: string; data: string }> {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return [];
    return buffer.getEventsSince(sinceId);
  }

  /**
   * Check if a session has active subscribers.
   */
  hasSubscribers(sessionId: string): boolean {
    const callbacks = this.sessions.get(sessionId);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Get the number of subscribers for a session.
   */
  getSubscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * Clean up all subscriptions and buffered events for a session.
   */
  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
  }

  /**
   * Reset all subscriptions and buffers (test helper).
   */
  reset(): void {
    this.sessions.clear();
    this.buffers.clear();
    this.removeAllListeners();
  }
}

/** Singleton instance of the chat stream manager */
export const chatStreamManager = new ChatStreamManager();

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check if IP can send a new message.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    // First request from this IP
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Check if window has expired
  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Within window - check limit
  if (entry.count >= MAX_MESSAGES_PER_IP_PER_MINUTE) {
    return false;
  }

  // Increment count
  entry.count++;
  return true;
}

/**
 * Get rate limit reset time for an IP.
 * Returns null if no rate limit entry exists.
 */
export function getRateLimitResetTime(ip: string): Date | null {
  const entry = rateLimits.get(ip);
  if (!entry) return null;

  return new Date(entry.firstRequestAt.getTime() + RATE_LIMIT_WINDOW_MS);
}

// ── Chat Manager ────────────────────────────────────────────────────────────

/**
 * Manages AI agent chat sessions.
 * Creates sessions, sends messages, and streams AI responses via SSE.
 */
export class ChatManager {
  private agentStoreReady?: Promise<void>;
  private activeGenerations = new Map<string, {
    abortController: AbortController;
    agentResult?: AgentResult;
  }>();

  constructor(
    private chatStore: ChatStore,
    private rootDir: string,
    private agentStore?: AgentStore,
  ) {}

  private async listAgentsForMentions(): Promise<Agent[]> {
    if (!this.agentStore) {
      return [];
    }

    try {
      this.agentStoreReady ??= this.agentStore.init();
      await this.agentStoreReady;
      return await this.agentStore.listAgents();
    } catch (agentListError) {
      const message = agentListError instanceof Error ? agentListError.message : String(agentListError);
      diagnostics.warn(`Failed to list agents for mention parsing: ${message}`);
      return [];
    }
  }

  /** A parsed @ mention of an agent in a chat message */
  private async parseMentions(content: string, agents?: Agent[]): Promise<ChatMention[]> {
    if (!this.agentStore) {
      return [];
    }

    const candidates = Array.from(content.matchAll(/@([\w-]+)/g), (match) => match[1] ?? "");
    if (candidates.length === 0) {
      return [];
    }

    const availableAgents = agents ?? (await this.listAgentsForMentions());
    if (availableAgents.length === 0) {
      return [];
    }

    const agentsByName = new Map<string, Agent>();
    for (const agent of availableAgents) {
      agentsByName.set(agent.name.toLowerCase(), agent);
    }

    const mentions: ChatMention[] = [];
    const seenAgentIds = new Set<string>();

    for (const candidate of candidates) {
      const normalizedName = candidate.replace(/_/g, " ").toLowerCase();
      const matchedAgent = agentsByName.get(normalizedName);
      if (!matchedAgent || seenAgentIds.has(matchedAgent.id)) {
        continue;
      }

      mentions.push({
        agentId: matchedAgent.id,
        agentName: matchedAgent.name,
      });
      seenAgentIds.add(matchedAgent.id);
    }

    return mentions;
  }

  private async buildMentionContext(mentions: ChatMention[], agents?: Agent[]): Promise<string> {
    if (!this.agentStore || mentions.length === 0) {
      return "";
    }

    const availableAgents = agents ?? (await this.listAgentsForMentions());
    if (availableAgents.length === 0) {
      return "";
    }

    const agentsById = new Map<string, Agent>();
    for (const agent of availableAgents) {
      agentsById.set(agent.id, agent);
    }

    const lines: string[] = [];
    for (const mention of mentions) {
      const matchedAgent = agentsById.get(mention.agentId);
      if (!matchedAgent) {
        continue;
      }

      const taskAssignment = matchedAgent.taskId?.trim() ? matchedAgent.taskId.trim() : "none";
      const soulOrInstructions = (matchedAgent.soul?.trim() || matchedAgent.instructionsText?.trim() || "")
        .replace(/\s+/g, " ");
      const description = soulOrInstructions.length > 200
        ? `${soulOrInstructions.slice(0, 200)}…`
        : soulOrInstructions;

      const base = `- @${mention.agentName.replace(/\s+/g, "_")} (role: ${matchedAgent.role}, currently working on: ${taskAssignment})`;
      lines.push(description ? `${base}: ${description}` : base);
    }

    if (lines.length === 0) {
      return "";
    }

    return [
      "The user mentioned the following agents in their message:",
      ...lines,
    ].join("\n");
  }

  /**
   * Create a new chat session.
   */
  createSession(input: ChatSessionCreateInput): ChatSession {
    return this.chatStore.createSession(input);
  }

  /**
   * Send a message and stream AI response via SSE.
   *
   * This method:
   * 1. Validates session exists
   * 2. Persists user message
   * 3. Creates AI agent session
   * 4. Streams thinking/text via chatStreamManager
   * 5. Persists assistant response
   * 6. Broadcasts done/error event
   *
   * @param sessionId - The chat session ID
   * @param content - User message content
   * @param modelProvider - Optional model provider override
   * @param modelId - Optional model ID override
   */
  async sendMessage(
    sessionId: string,
    content: string,
    modelProvider?: string,
    modelId?: string,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeGenerations.set(sessionId, { abortController });

    const session = this.chatStore.getSession(sessionId);
    let agentResult: AgentResult | undefined;
    let accumulatedThinking = "";
    let accumulatedText = "";
    type ToolCallRecord = {
      toolName: string;
      args?: Record<string, unknown>;
      isError: boolean;
      result?: unknown;
    };
    const toolCallsAccum: ToolCallRecord[] = [];
    const pendingToolStarts = new Map<string, Array<{ toolName: string; args?: Record<string, unknown> }>>();

    try {
      // Validate session exists
      if (!session) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Chat session ${sessionId} not found`,
        });
        return;
      }

      const hasMentionCandidates = /@[\w-]+/.test(content);
      const mentionAgents = hasMentionCandidates ? await this.listAgentsForMentions() : [];
      const mentions = hasMentionCandidates ? await this.parseMentions(content, mentionAgents) : [];

      // Persist user message
      try {
        this.chatStore.addMessage(sessionId, {
          role: "user",
          content,
          metadata: mentions.length > 0 ? { mentions } : undefined,
        });
      } catch (err) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Failed to save message: ${err instanceof Error ? err.message : "Unknown error"}`,
        });
        return;
      }

      // Use model from session if not overridden (needed for both AI response and title generation)
      const effectiveModelProvider = modelProvider ?? session.modelProvider ?? undefined;
      const effectiveModelId = modelId ?? session.modelId ?? undefined;

      // Auto-generate chat title on first message if session has no title
      const needsTitle = session.title === null || session.title === undefined || session.title.trim() === "";
      if (needsTitle) {
        // Fire-and-forget title generation (non-blocking)
        (async () => {
          try {
            const generated = await summarizeTitle(
              content.trim(),
              this.rootDir,
              effectiveModelProvider,
              effectiveModelId,
            );
            const title = generated ?? content.trim().slice(0, 60).trim();
            if (title) {
              this.chatStore.updateSession(sessionId, { title });
            }
          } catch {
            // Fallback on any error
            const fallback = content.trim().slice(0, 60).trim();
            if (fallback) {
              this.chatStore.updateSession(sessionId, { title: fallback });
            }
          }
        })();
      }

      // Ensure engine is loaded
      await ensureEngineReady();

      if (!createFnAgent) {
        throw new Error("AI agent not available");
      }

      let systemPrompt = CHAT_SYSTEM_PROMPT;
      let agent: Agent | null = null;

      if (this.agentStore && session.agentId) {
        try {
          this.agentStoreReady ??= this.agentStore.init();
          await this.agentStoreReady;
          agent = await this.agentStore.getAgent(session.agentId);
        } catch (agentLoadError) {
          const message = agentLoadError instanceof Error ? agentLoadError.message : String(agentLoadError);
          diagnostics.warn(`Failed to load agent context for ${session.agentId}: ${message}`);
        }
      }

      if (agent && buildAgentChatPromptFn) {
        try {
          systemPrompt = await buildAgentChatPromptFn({
            agent,
            rootDir: this.rootDir,
            agentStore: this.agentStore,
            basePrompt: CHAT_SYSTEM_PROMPT,
            includeProjectMemory: true,
          });
        } catch (promptBuildError) {
          const message = promptBuildError instanceof Error ? promptBuildError.message : String(promptBuildError);
          diagnostics.warn(`Failed to build enriched system prompt for ${agent.id}: ${message}`);
        }
      }

      if (mentions.length > 0) {
        const mentionContext = await this.buildMentionContext(mentions, mentionAgents);
        if (mentionContext) {
          systemPrompt = `${systemPrompt}\n\n${mentionContext}`;
        }
      }

      const allMessages = this.chatStore.getMessages(sessionId, { limit: 10000 }) ?? [];
      const previousMessages = allMessages.slice(-51, -1);
      const conversationMessages = previousMessages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      );

      // Resolve #file references in the current message before sending to AI
      const resolvedContent = await resolveFileReferences(content, this.rootDir);

      const promptContent = conversationMessages.length > 0
        ? [
            "## Previous Conversation",
            "",
            ...conversationMessages.map((message) => {
              const speaker = message.role === "user" ? "User" : "Assistant";
              return `[${speaker}]: ${message.content}`;
            }),
            "",
            "## Current Message",
            "",
            resolvedContent,
          ].join("\n")
        : resolvedContent;

      // Create AI agent session
      agentResult = await createFnAgent({
        cwd: this.rootDir,
        systemPrompt,
        tools: "coding",
        ...(effectiveModelProvider && effectiveModelId
          ? {
              defaultProvider: effectiveModelProvider,
              defaultModelId: effectiveModelId,
            }
          : {}),
        onThinking: (delta: string) => {
          accumulatedThinking += delta;
          chatStreamManager.broadcast(sessionId, {
            type: "thinking",
            data: delta,
          });
        },
        onText: (delta: string) => {
          accumulatedText += delta;
          chatStreamManager.broadcast(sessionId, {
            type: "text",
            data: delta,
          });
        },
        onToolStart: (name: string, args?: Record<string, unknown>) => {
          const pendingForTool = pendingToolStarts.get(name) ?? [];
          pendingForTool.push({ toolName: name, args });
          pendingToolStarts.set(name, pendingForTool);

          chatStreamManager.broadcast(sessionId, {
            type: "tool_start",
            data: { toolName: name, args },
          });
        },
        onToolEnd: (name: string, isError: boolean, result?: unknown) => {
          const pendingForTool = pendingToolStarts.get(name);
          const pendingStart = pendingForTool?.pop();
          if (pendingForTool && pendingForTool.length === 0) {
            pendingToolStarts.delete(name);
          }

          toolCallsAccum.push({
            toolName: name,
            args: pendingStart?.args,
            isError,
            result,
          });

          chatStreamManager.broadcast(sessionId, {
            type: "tool_end",
            data: { toolName: name, isError, result },
          });
        },
      });
      this.activeGenerations.set(sessionId, { abortController, agentResult });

      if (abortController.signal.aborted) {
        agentResult.session.dispose?.();
        return;
      }

      // Send user message and get response
      await agentResult.session.prompt(promptContent);

      if (abortController.signal.aborted) {
        return;
      }

      // Extract response text from agent state
      let responseText = "";
      interface AgentMessage {
        role: string;
        content?: string | Array<{ type: string; text: string }>;
      }
      const lastMessage = (agentResult.session.state.messages as AgentMessage[])
        .filter((m: AgentMessage) => m.role === "assistant")
        .pop();

      if (lastMessage?.content) {
        if (typeof lastMessage.content === "string") {
          responseText = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          responseText = lastMessage.content
            .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
            .map((c: { type: string; text: string }) => c.text)
            .join("");
        }
      }

      // Use accumulated text from streaming (most reliable) with extraction fallback
      const finalResponseText = accumulatedText || responseText;

      // Persist assistant message
      const assistantMessage = this.chatStore.addMessage(sessionId, {
        role: "assistant",
        content: finalResponseText,
        thinkingOutput: accumulatedThinking || undefined,
        metadata: toolCallsAccum.length > 0 ? { toolCalls: toolCallsAccum } : undefined,
      });

      // Broadcast done event
      chatStreamManager.broadcast(sessionId, {
        type: "done",
        data: { messageId: assistantMessage.id },
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: "Generation cancelled",
        });
        return;
      }

      const errorMessage = err instanceof Error ? err.message : "AI processing failed";
      diagnostics.error(`Error in sendMessage for session ${sessionId}:`, err);

      if (accumulatedText || accumulatedThinking || toolCallsAccum.length > 0) {
        try {
          this.chatStore.addMessage(sessionId, {
            role: "assistant",
            content: accumulatedText || "(response interrupted before text generation)",
            thinkingOutput: accumulatedThinking || undefined,
            metadata: {
              interrupted: true,
              ...(toolCallsAccum.length > 0 ? { toolCalls: toolCallsAccum } : {}),
            },
          });
        } catch (persistErr) {
          diagnostics.error(`Failed to persist partial response for session ${sessionId}:`, persistErr);
        }
      }

      chatStreamManager.broadcast(sessionId, {
        type: "error",
        data: errorMessage,
      });
    } finally {
      this.activeGenerations.delete(sessionId);

      // Always dispose agent session
      if (agentResult) {
        try {
          agentResult.session.dispose?.();
        } catch (err) {
          diagnostics.error(`Error disposing agent session:`, err);
        }
      }
    }
  }

  cancelGeneration(sessionId: string): boolean {
    const entry = this.activeGenerations.get(sessionId);
    if (!entry) {
      return false;
    }

    entry.abortController.abort();

    if (entry.agentResult) {
      try {
        entry.agentResult.session.dispose?.();
      } catch (err) {
        diagnostics.error(`Error disposing agent session during cancellation:`, err);
      }
    }

    chatStreamManager.broadcast(sessionId, {
      type: "error",
      data: "Generation cancelled",
    });

    return true;
  }
}

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Inject a mock createFnAgent function. Used for testing only.
 */
export function __setCreateFnAgent(mock: typeof createFnAgent): void {
  createFnAgent = mock;
}

/**
 * Inject a mock buildAgentChatPrompt function. Used for testing only.
 */
export function __setBuildAgentChatPrompt(mock: typeof buildAgentChatPromptFn): void {
  buildAgentChatPromptFn = mock;
}

/**
 * Reset all chat state. Used for testing only.
 */
export function __resetChatState(): void {
  chatStreamManager.reset();
  rateLimits.clear();
  buildAgentChatPromptFn = undefined;

  // Reset diagnostics logger to default
  __setChatDiagnostics(null);
}
