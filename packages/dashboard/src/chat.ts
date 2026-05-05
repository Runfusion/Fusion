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
  ChatAttachment,
  ChatStore,
  ChatSession,
  ChatSessionCreateInput,
  Settings,
} from "@fusion/core";
import { summarizeTitle } from "@fusion/core";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { SessionEventBuffer } from "./sse-buffer.js";

import {
  createFnAgent as engineCreateFnAgent,
  createResolvedAgentSession as engineCreateResolvedAgentSession,
  promptWithFallback as enginePromptWithFallback,
  extractRuntimeHint,
  extractRuntimeModel,
} from "@fusion/engine";
import * as engineModule from "@fusion/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createFnAgent: any = engineCreateFnAgent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createResolvedAgentSession: any = engineCreateResolvedAgentSession;
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

  if ("buildAgentChatPrompt" in engineModule && typeof engineModule.buildAgentChatPrompt === "function") {
    buildAgentChatPromptFn = engineModule.buildAgentChatPrompt;
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

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Types ───────────────────────────────────────────────────────────────────

/** SSE event types for chat streaming */
export type ChatStreamEvent =
  | { type: "thinking"; data: string }
  | { type: "text"; data: string }
  | { type: "tool_start"; data: { toolName: string; args?: Record<string, unknown> } }
  | { type: "tool_end"; data: { toolName: string; isError: boolean; result?: unknown } }
  | { type: "fallback"; data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" } }
  | {
      type: "done";
      data: {
        messageId: string;
        message?: {
          id: string;
          sessionId: string;
          role: "assistant";
          content: string;
          thinkingOutput: string | null;
          metadata: Record<string, unknown> | null;
          attachments?: ChatAttachment[];
          createdAt: string;
        };
        attachments?: ChatAttachment[];
      };
    }
  | { type: "error"; data: string };

/** Callback function for streaming events */
export type ChatStreamCallback = (event: ChatStreamEvent, eventId?: number) => void;

/** Per-subscription record. `generationId` (if set) filters which broadcasts are delivered. */
interface ChatStreamSubscription {
  callback: ChatStreamCallback;
  generationId?: number;
}

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
  private readonly sessions = new Map<string, Set<ChatStreamSubscription>>();
  private readonly buffers = new Map<string, SessionEventBuffer>();

  constructor(private readonly bufferSize = 100) {
    super();
  }

  /**
   * Register a client callback for a chat session.
   * Returns a function to unsubscribe.
   *
   * If `options.generationId` is provided, this subscriber only receives broadcasts
   * tagged with the same generationId (or untagged broadcasts). This isolates each
   * client SSE connection to events from its own `chatManager.sendMessage` call so
   * that a previous generation's late "Generation cancelled" event cannot leak into
   * a new request that has just subscribed for the same session.
   */
  subscribe(
    sessionId: string,
    callback: ChatStreamCallback,
    options?: { generationId?: number },
  ): () => void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }

    const subscriptions = this.sessions.get(sessionId)!;
    const subscription: ChatStreamSubscription = { callback, generationId: options?.generationId };
    subscriptions.add(subscription);

    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
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
   *
   * When `options.generationId` is set, the event is delivered only to subscribers
   * that registered without a generation filter or whose generation matches.
   * Subscribers tied to a different generation will not receive it. Untagged
   * broadcasts (no generationId) reach every subscriber for backward compatibility.
   */
  broadcast(
    sessionId: string,
    event: ChatStreamEvent,
    options?: { generationId?: number },
  ): number {
    const serialized = JSON.stringify((event as { data?: unknown }).data ?? {});
    const eventData = typeof serialized === "string" ? serialized : "{}";
    const eventId = this.getBuffer(sessionId).push(event.type, eventData);

    const subscriptions = this.sessions.get(sessionId);
    if (!subscriptions) return eventId;

    const broadcastGenerationId = options?.generationId;

    for (const subscription of subscriptions) {
      if (
        broadcastGenerationId !== undefined &&
        subscription.generationId !== undefined &&
        subscription.generationId !== broadcastGenerationId
      ) {
        continue;
      }
      try {
        subscription.callback(event, eventId);
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
    const subscriptions = this.sessions.get(sessionId);
    return subscriptions !== undefined && subscriptions.size > 0;
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
  private generationCounter = 0;
  private activeGenerations = new Map<string, {
    abortController: AbortController;
    agentResult?: AgentResult;
    generationId: number;
  }>();

  constructor(
    private chatStore: ChatStore,
    private rootDir: string,
    private agentStore?: AgentStore,
    private pluginRunner?: {
      getRuntimeById?(runtimeId: string): unknown;
      createRuntimeContext?(pluginId: string): Promise<unknown>;
    },
    private getSettings?: () => Promise<Pick<Settings, "fallbackProvider" | "fallbackModelId" | "defaultProvider" | "defaultModelId"> | undefined> | Pick<Settings, "fallbackProvider" | "fallbackModelId" | "defaultProvider" | "defaultModelId"> | undefined,
  ) {}

  private async getChatModelSettings(): Promise<{
    fallbackProvider?: string;
    fallbackModelId?: string;
    defaultProvider?: string;
    defaultModelId?: string;
  }> {
    if (!this.getSettings) {
      return {};
    }

    try {
      const settings = await this.getSettings();
      return {
        fallbackProvider: settings?.fallbackProvider ?? undefined,
        fallbackModelId: settings?.fallbackModelId ?? undefined,
        defaultProvider: settings?.defaultProvider ?? undefined,
        defaultModelId: settings?.defaultModelId ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.warn(`Failed to load chat fallback settings: ${message}`);
      return {};
    }
  }

  private handleFallbackModelUsed(
    sessionId: string,
    generationId: number,
    payload: {
      primaryModel: string;
      fallbackModel: string;
      triggerPoint: "session-creation" | "prompt-time";
    },
  ): void {
    const slashIndex = payload.fallbackModel.indexOf("/");
    if (slashIndex > 0 && slashIndex < payload.fallbackModel.length - 1) {
      this.chatStore.updateSession(sessionId, {
        modelProvider: payload.fallbackModel.slice(0, slashIndex),
        modelId: payload.fallbackModel.slice(slashIndex + 1),
      });
    }

    diagnostics.warn(
      `[fallback] chat ${sessionId} switched from ${payload.primaryModel} to ${payload.fallbackModel} (${payload.triggerPoint})`,
    );
    chatStreamManager.broadcast(sessionId, {
      type: "fallback",
      data: payload,
    }, { generationId });
  }

  /**
   * Allocate a fresh generation slot for a session before subscribing/streaming.
   *
   * Returns a monotonically increasing `generationId` plus an `AbortController` that
   * later steps (the SSE route, `sendMessage`, `cancelGeneration`) use to drive and
   * tear down this specific generation. Any in-flight generation for the same
   * session is pre-emptively aborted; its lingering broadcasts will carry the old
   * generationId, which `ChatStreamManager` filters out for new subscribers.
   *
   * Routes that subscribe to SSE before invoking `sendMessage` should call this
   * first so subscription and broadcast generationIds are tied together.
   */
  beginGeneration(sessionId: string): { generationId: number; abortController: AbortController } {
    const existing = this.activeGenerations.get(sessionId);
    if (existing) {
      existing.abortController.abort();
      if (existing.agentResult) {
        try {
          existing.agentResult.session.dispose?.();
        } catch (err) {
          diagnostics.error(`Error disposing previous agent session during pre-emption:`, err);
        }
      }
    }
    this.generationCounter += 1;
    const generationId = this.generationCounter;
    const abortController = new AbortController();
    this.activeGenerations.set(sessionId, { abortController, generationId });
    return { generationId, abortController };
  }

  /**
   * Resolve the per-chat pi/Claude CLI SessionManager.
   *
   * - If the chat has a recorded session file that still exists on disk,
   *   reopen it so the CLI --resume sees the full prior transcript.
   * - Otherwise, create a fresh file-backed session and persist its path
   *   on the chat row. The path is computed synchronously by SessionManager
   *   on construction, so we can store it before the first prompt() call.
   * - If a recorded path has gone missing (manual cleanup, disk wipe), fall
   *   through to "create" and overwrite the stale pointer.
   *
   * Note: we deliberately use file-backed sessions even though pi's history
   * is also tracked in chat_messages. The file is what the Claude CLI's
   * --resume reads, and its session id is what pi-claude-cli passes as
   * `--session-id`. Pinning both via SessionManager.open is the only way to
   * keep the CLI session stable across user messages.
   */
  private resolveCliSessionManager(session: ChatSession): SessionManager {
    if (session.cliSessionFile && existsSync(session.cliSessionFile)) {
      try {
        return SessionManager.open(session.cliSessionFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          `Failed to reopen chat ${session.id} CLI session at ${session.cliSessionFile} (${message}); starting fresh`,
        );
      }
    }

    const manager = SessionManager.create(this.rootDir);
    const sessionFile = manager.getSessionFile();
    if (sessionFile) {
      try {
        this.chatStore.setCliSessionFile(session.id, sessionFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          `Failed to persist CLI session file for chat ${session.id}: ${message}`,
        );
      }
    }
    return manager;
  }

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
    attachments?: ChatAttachment[],
    options?: { generationId?: number },
  ): Promise<void> {
    // The SSE route allocates a generation via `beginGeneration` so it can subscribe
    // with a matching filter before this method runs. Direct callers (tests, internal
    // code) pass nothing and we allocate a generation here.
    const preallocated = options?.generationId !== undefined
      ? this.activeGenerations.get(sessionId)
      : undefined;
    let generationId: number;
    let abortController: AbortController;
    if (preallocated && preallocated.generationId === options?.generationId) {
      generationId = preallocated.generationId;
      abortController = preallocated.abortController;
    } else {
      const allocated = this.beginGeneration(sessionId);
      generationId = allocated.generationId;
      abortController = allocated.abortController;
    }
    const broadcastOptions = { generationId };

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
    let fallbackInfo:
      | { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }
      | undefined;

    try {
      // Validate session exists
      if (!session) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Chat session ${sessionId} not found`,
        }, broadcastOptions);
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
          attachments,
        });
      } catch (err) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: `Failed to save message: ${err instanceof Error ? err.message : "Unknown error"}`,
        }, broadcastOptions);
        return;
      }

      // Use model from session if not overridden (needed for both AI response and title generation)
      const requestedModelProvider = modelProvider ?? session.modelProvider ?? undefined;
      const requestedModelId = modelId ?? session.modelId ?? undefined;
      let effectiveModelProvider = requestedModelProvider;
      let effectiveModelId = requestedModelId;
      let hasExplicitAgentRuntimeModel = false;

      const needsTitle = session.title === null || session.title === undefined || session.title.trim() === "";

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

      if (agent) {
        const runtimeModel = extractRuntimeModel(agent.runtimeConfig);
        if (runtimeModel.provider && runtimeModel.modelId) {
          hasExplicitAgentRuntimeModel = true;
        }
        effectiveModelProvider ??= runtimeModel.provider;
        effectiveModelId ??= runtimeModel.modelId;
      }

      // Auto-generate chat title on first message if session has no title.
      // Run after the agent fetch so the title-summarizer uses the agent's model.
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

      if (mentions.length > 0) {
        const mentionContext = await this.buildMentionContext(mentions, mentionAgents);
        if (mentionContext) {
          systemPrompt = `${systemPrompt}\n\n${mentionContext}`;
        }
      }

      // Resolve #file references in the current message before sending to AI
      const resolvedContent = await resolveFileReferences(content, this.rootDir);

      const attachmentSummary = attachments && attachments.length > 0
        ? `[User attached: ${attachments
          .map((attachment) => `${attachment.originalName} (${attachment.mimeType}, ${formatAttachmentSize(attachment.size)})`)
          .join(", ")}]`
        : "";

      // Send only the new user content. Prior turns are reloaded by the
      // pi/Claude CLI session via SessionManager.open() below — stuffing the
      // transcript back into the user message would balloon the on-disk
      // session every turn (and previously did, see chat-store.ts:setCliSessionFile).
      const promptContent = [attachmentSummary, resolvedContent].filter(Boolean).join("\n\n");

      // Per-chat session continuity: the pi SessionManager (and, transitively,
      // the Claude CLI --resume session it owns) is keyed off the chat. On the
      // first user message we create a fresh, file-backed session and persist
      // its path; subsequent messages reopen the same file.
      const sessionManager = this.resolveCliSessionManager(session);
      const chatModelSettings = await this.getChatModelSettings();
      const usesConfiguredDefaultModel =
        requestedModelProvider === chatModelSettings.defaultProvider
        && requestedModelId === chatModelSettings.defaultModelId
        && !!requestedModelProvider
        && !!requestedModelId;
      const allowFallback =
        !hasExplicitAgentRuntimeModel
        && (
          !(requestedModelProvider && requestedModelId)
          || usesConfiguredDefaultModel
        );

      const sessionOptions = {
        cwd: this.rootDir,
        systemPrompt,
        tools: "coding" as const,
        sessionManager,
        ...(effectiveModelProvider && effectiveModelId
          ? {
              defaultProvider: effectiveModelProvider,
              defaultModelId: effectiveModelId,
            }
          : {}),
        ...(allowFallback && chatModelSettings.fallbackProvider && chatModelSettings.fallbackModelId
          ? {
              fallbackProvider: chatModelSettings.fallbackProvider,
              fallbackModelId: chatModelSettings.fallbackModelId,
            }
          : {}),
        onFallbackModelUsed: (payload: {
          primaryModel: string;
          fallbackModel: string;
          triggerPoint: "session-creation" | "prompt-time";
        }) => {
          fallbackInfo = payload;
          this.handleFallbackModelUsed(sessionId, generationId, payload);
        },
        onThinking: (delta: string) => {
          accumulatedThinking += delta;
          chatStreamManager.broadcast(sessionId, {
            type: "thinking",
            data: delta,
          }, broadcastOptions);
        },
        onText: (delta: string) => {
          accumulatedText += delta;
          chatStreamManager.broadcast(sessionId, {
            type: "text",
            data: delta,
          }, broadcastOptions);
        },
        onToolStart: (name: string, args?: Record<string, unknown>) => {
          const pendingForTool = pendingToolStarts.get(name) ?? [];
          pendingForTool.push({ toolName: name, args });
          pendingToolStarts.set(name, pendingForTool);

          chatStreamManager.broadcast(sessionId, {
            type: "tool_start",
            data: { toolName: name, args },
          }, broadcastOptions);
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
          }, broadcastOptions);
        },
      };

      const agentRuntimeHint = agent ? extractRuntimeHint(agent.runtimeConfig) : undefined;
      if (agentRuntimeHint) {
        agentResult = await createResolvedAgentSession({
          sessionPurpose: "executor",
          runtimeHint: agentRuntimeHint,
          pluginRunner: this.pluginRunner,
          ...sessionOptions,
        });
      } else {
        agentResult = await createFnAgent(sessionOptions);
      }
      this.activeGenerations.set(sessionId, { abortController, agentResult, generationId });

      if (abortController.signal.aborted) {
        agentResult.session.dispose?.();
        return;
      }

      // Send user message and get response
      await enginePromptWithFallback(agentResult.session, promptContent);

      if (abortController.signal.aborted) {
        return;
      }

      // Some runtimes (e.g. plugin-backed Codex/openclaw) signal provider failures
      // by setting session.state.errorMessage rather than throwing. Surface that
      // as an error event instead of persisting a blank assistant reply.
      const sessionErrorMessage = (agentResult.session.state as { errorMessage?: unknown }).errorMessage;
      if (typeof sessionErrorMessage === "string" && sessionErrorMessage.trim().length > 0
          && !accumulatedText && !accumulatedThinking && toolCallsAccum.length === 0) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: sessionErrorMessage,
        }, broadcastOptions);
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
      const assistantMetadata: Record<string, unknown> = {};
      if (toolCallsAccum.length > 0) {
        assistantMetadata.toolCalls = toolCallsAccum;
      }
      if (fallbackInfo) {
        assistantMetadata.fallback = fallbackInfo;
      }
      const assistantMessage = this.chatStore.addMessage(sessionId, {
        role: "assistant",
        content: finalResponseText,
        thinkingOutput: accumulatedThinking || undefined,
        metadata: Object.keys(assistantMetadata).length > 0 ? assistantMetadata : undefined,
      });

      // Broadcast done event with persisted assistant snapshot so clients can
      // render completion even when incremental text deltas were absent.
      chatStreamManager.broadcast(sessionId, {
        type: "done",
        data: {
          messageId: assistantMessage.id,
          message: {
            id: assistantMessage.id,
            sessionId: assistantMessage.sessionId,
            role: "assistant",
            content: assistantMessage.content,
            thinkingOutput: assistantMessage.thinkingOutput,
            metadata: assistantMessage.metadata,
            attachments: assistantMessage.attachments,
            createdAt: assistantMessage.createdAt,
          },
          attachments,
        },
      }, broadcastOptions);
    } catch (err) {
      if (abortController.signal.aborted) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: "Generation cancelled",
        }, broadcastOptions);
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
              ...(fallbackInfo ? { fallback: fallbackInfo } : {}),
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
      }, broadcastOptions);
    } finally {
      // Only clear the active-generation slot if it still belongs to us. If a newer
      // sendMessage pre-empted us via beginGeneration, the slot now holds that newer
      // generation's controller and must not be deleted by our cleanup.
      const current = this.activeGenerations.get(sessionId);
      if (current?.generationId === generationId) {
        this.activeGenerations.delete(sessionId);
      }

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
    }, { generationId: entry.generationId });

    return true;
  }

  /**
   * Check whether a generation is currently in progress for the given session.
   */
  isGenerating(sessionId: string): boolean {
    return this.activeGenerations.has(sessionId);
  }

  /**
   * Return all session IDs that currently have an active generation.
   * Useful for batch-enriching session lists without N+1 lookups.
   */
  getGeneratingSessionIds(): string[] {
    return [...this.activeGenerations.keys()];
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
 * Inject a mock createResolvedAgentSession function. Used for testing only.
 */
export function __setCreateResolvedAgentSession(mock: typeof createResolvedAgentSession): void {
  createResolvedAgentSession = mock;
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
  createFnAgent = engineCreateFnAgent;
  createResolvedAgentSession = engineCreateResolvedAgentSession;

  // Reset diagnostics logger to default
  __setChatDiagnostics(null);
}
