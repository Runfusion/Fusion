import type { EnrichedChatSession } from "@fusion/core";
import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import { writeSSEEvent } from "../sse-buffer.js";
import type { ApiRoutesContext } from "./types.js";

interface ChatRouteDeps {
  parseLastEventId: (req: import("express").Request) => number | undefined;
  validateOptionalModelField: (value: unknown, fieldName: string) => string | undefined;
}

export function registerChatRoutes(ctx: ApiRoutesContext, deps: ChatRouteDeps): void {
  const { router, options, getProjectContext, chatLogger, rethrowAsApiError } = ctx;
  const { parseLastEventId, validateOptionalModelField } = deps;

  // ── Chat Routes ────────────────────────────────────────────────────────────

  /**
   * GET /api/chat/sessions
   * List chat sessions with optional filtering.
   * Query params: projectId?, status?, agentId?
   *
   * Response is enriched with lastMessagePreview and lastMessageAt for each session.
   */
  router.get("/chat/sessions", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const { projectId, status, agentId, lookup, modelProvider, modelId } = req.query as {
        projectId?: string;
        status?: string;
        agentId?: string;
        lookup?: string;
        modelProvider?: string;
        modelId?: string;
      };

      const isResumeLookup = lookup === "resume";
      const hasModelProvider = typeof modelProvider === "string" && modelProvider.trim().length > 0;
      const hasModelId = typeof modelId === "string" && modelId.trim().length > 0;
      if (hasModelProvider !== hasModelId) {
        throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
      }

      if (isResumeLookup && (!agentId || !agentId.trim())) {
        throw badRequest("agentId is required when lookup=resume");
      }

      const sessions = isResumeLookup
        ? (() => {
            const matched = chatStore.findLatestActiveSessionForTarget({
              agentId: agentId!.trim(),
              ...(projectId && { projectId }),
              ...(hasModelProvider && hasModelId
                ? {
                    modelProvider: modelProvider!.trim(),
                    modelId: modelId!.trim(),
                  }
                : {}),
            });

            return matched ? [matched] : [];
          })()
        : chatStore.listSessions({
            ...(projectId && { projectId }),
            ...(status && { status: status as "active" | "archived" }),
            ...(agentId && { agentId }),
          });

      // Enrich sessions with last message preview
      if (sessions.length > 0) {
        const sessionIds = sessions.map((s) => s.id);
        const lastMessages = chatStore.getLastMessageForSessions(sessionIds);

        for (const session of sessions) {
          const lastMessage = lastMessages.get(session.id);
          if (lastMessage) {
            // Truncate content to 100 chars for preview
            const content = lastMessage.content || "";
            const enriched: EnrichedChatSession = session;
            enriched.lastMessagePreview =
              content.length > 100 ? content.slice(0, 100) + "…" : content;
            enriched.lastMessageAt = lastMessage.createdAt;
          }
        }
      }

      res.json({ sessions });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to list chat sessions");
    }
  });

  /**
   * POST /api/chat/sessions
   * Create a new chat session.
   * Body: { agentId: string, title?: string, modelProvider?: string, modelId?: string }
   * If modelProvider and modelId are provided, those are used. Otherwise the model is
   * resolved from the agent's runtimeConfig.model setting.
   * The session is scoped to the project identified by projectId query param or header.
   */
  router.post("/chat/sessions", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      // Get project context to scope the session and resolve agent from the correct store
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const { agentId, title, modelProvider, modelId } = req.body as {
        agentId?: string;
        title?: string;
        modelProvider?: string;
        modelId?: string;
      };

      if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
        throw badRequest("agentId is required");
      }

      // Validate that if one model field is provided, the other must also be provided
      const hasClientModelProvider = typeof modelProvider === "string" && modelProvider.trim() !== "";
      const hasClientModelId = typeof modelId === "string" && modelId.trim() !== "";
      if (hasClientModelProvider !== hasClientModelId) {
        throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
      }

      // Fetch the agent to resolve model configuration (only if client didn't provide model)
      let resolvedProvider: string | null = null;
      let resolvedModelId: string | null = null;

      if (hasClientModelProvider && hasClientModelId) {
        // Use client-provided model
        resolvedProvider = modelProvider!.trim();
        resolvedModelId = modelId!.trim();
      } else {
        // Resolve from agent's runtimeConfig.model
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound(`Agent ${agentId} not found`);
        }

        // Parse the agent's model config from runtimeConfig.model
        // Format: "provider/modelId" (e.g., "anthropic/claude-sonnet-4-5")
        const runtimeModel = typeof agent.runtimeConfig?.model === "string" ? agent.runtimeConfig.model : "";
        const slashIdx = runtimeModel.indexOf("/");
        resolvedProvider = slashIdx > 0 ? runtimeModel.slice(0, slashIdx) : null;
        resolvedModelId = slashIdx > 0 ? runtimeModel.slice(slashIdx + 1) : null;
      }

      // Create the chat session with projectId for multi-project scoping
      const session = chatStore.createSession({
        agentId: agentId.trim(),
        title: title?.trim() || null,
        projectId: projectId ?? null,
        modelProvider: resolvedProvider,
        modelId: resolvedModelId,
      });

      res.status(201).json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create chat session");
    }
  });

  /**
   * GET /api/chat/sessions/:id
   * Get a single chat session.
   */
  router.get("/chat/sessions/:id", async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get chat session");
    }
  });

  /**
   * PATCH /api/chat/sessions/:id
   * Update a chat session (title, status).
   * Body: { title?: string, status?: "active" | "archived" }
   */
  router.patch("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const { title, status } = req.body as { title?: string; status?: string };

      // Validate status if provided
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw badRequest("status must be 'active' or 'archived'");
      }

      const session = chatStore.updateSession(sessionId, {
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(status !== undefined && { status }),
      });

      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to update chat session");
    }
  });

  /**
   * DELETE /api/chat/sessions/:id
   * Delete a chat session and all its messages.
   */
  router.delete("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      const sessionId = String(req.params.id);
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const deleted = chatStore.deleteSession(sessionId);
      if (!deleted) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to delete chat session");
    }
  });

  /**
   * GET /api/chat/sessions/:id/messages
   * Get messages for a chat session with pagination.
   * Query params: limit? (default 50, max 200), offset? (default 0), before? (ISO timestamp)
   */
  router.get("/chat/sessions/:id/messages", async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const { limit: limitStr, offset: offsetStr, before } = req.query as {
        limit?: string;
        offset?: string;
        before?: string;
      };

      // Validate pagination params
      const limit = limitStr !== undefined ? parseInt(String(limitStr), 10) : 50;
      const offset = offsetStr !== undefined ? parseInt(String(offsetStr), 10) : 0;

      if (!Number.isFinite(limit) || limit < 1) {
        throw badRequest("limit must be a positive integer");
      }
      if (!Number.isFinite(offset) || offset < 0) {
        throw badRequest("offset must be a non-negative integer");
      }

      const effectiveLimit = Math.min(limit, 200);

      const messages = chatStore.getMessages(sessionId, {
        limit: effectiveLimit,
        offset,
        ...(before && { before }),
      });

      res.json({ messages });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to get chat messages");
    }
  });

  /**
   * POST /api/chat/sessions/:id/messages
   * Send a message and stream AI response via SSE.
   * Body: { content: string, modelProvider?: string, modelId?: string }
   *
   * Event types:
   * - thinking: AI thinking output chunks
   * - text: AI response text chunks
   * - done: Message sent successfully with messageId
   * - error: Error message
   */
  router.post("/chat/sessions/:id/messages", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      const chatManager = options?.chatManager;
      if (!chatStore || !chatManager) {
        throw internalError("Chat store or manager not available");
      }

      const { content, modelProvider, modelId } = req.body as {
        content?: string;
        modelProvider?: string;
        modelId?: string;
      };
      const sessionId = String(req.params.id);

      if (!content || typeof content !== "string" || !content.trim()) {
        throw badRequest("content is required and must be a non-empty string");
      }

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send initial connection confirmation
      res.write(": connected\n\n");

      // Import chat modules
      const { chatStreamManager, checkRateLimit: checkChatRateLimit, getRateLimitResetTime: getChatRateLimitResetTime } = await import("../chat.js");

      // Check rate limit
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (!checkChatRateLimit(ip)) {
        const resetTime = getChatRateLimitResetTime(ip);
        writeSSEEvent(res, "error", JSON.stringify({
          message: `Rate limit exceeded. Reset at ${resetTime?.toISOString() || "unknown"}`,
        }));
        res.end();
        return;
      }

      // Replay buffered events if client sent Last-Event-ID
      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = chatStreamManager.getBufferedEvents(sessionId, lastEventId);
        for (const bufferedEvent of buffered) {
          if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
            res.end();
            return;
          }
        }
      }

      // Subscribe to session events
      const unsubscribe = chatStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        // End stream on done or error
        if (event.type === "done" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      // Handle client disconnect
      req.on("close", () => {
        unsubscribe();
      });

      // Send heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
      });

      // Send message in background (non-blocking)
      // Validate optional model pair consistency
      const normalizedProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const normalizedModelId = validateOptionalModelField(modelId, "modelId");
      if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: "modelProvider and modelId must both be provided or neither",
        });
        unsubscribe();
        res.end();
        return;
      }

      // Fire and forget - streaming happens via callbacks
      chatManager.sendMessage(
        sessionId,
        content.trim(),
        normalizedProvider,
        normalizedModelId,
      ).catch((err: Error) => {
        chatLogger.error("Error in sendMessage", {
          error: err.message,
        });
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: err.message || "Failed to process message",
        });
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to send chat message");
    }
  });

  /**
   * POST /api/chat/sessions/:id/cancel
   * Cancel an in-flight chat generation.
   */
  router.post("/chat/sessions/:id/cancel", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatManager = options?.chatManager;
      if (!chatManager) {
        throw new ApiError(503, "Chat manager not available");
      }

      const sessionId = String(req.params.id);
      const success = chatManager.cancelGeneration(sessionId);
      res.json({ success });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to cancel chat generation");
    }
  });

  /**
   * DELETE /api/chat/sessions/:id/messages/:messageId
   * Delete a specific message from a chat session.
   */
  router.delete("/chat/sessions/:id/messages/:messageId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }

      const sessionId = String(req.params.id);
      const messageId = String(req.params.messageId);

      // Verify session exists
      const session = chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // Check if message exists
      const message = chatStore.getMessage(messageId);
      if (!message) {
        throw notFound(`Message ${messageId} not found`);
      }

      // Delete the message
      const deleted = chatStore.deleteMessage(messageId);
      if (!deleted) {
        throw notFound(`Message ${messageId} not found`);
      }
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to delete chat message");
    }
  });

  if (process.env.FUSION_DEBUG_CHAT_ROUTES === "1") {
    const chatRoutes = [
      "GET /chat/sessions",
      "POST /chat/sessions",
      "GET /chat/sessions/:id",
      "PATCH /chat/sessions/:id",
      "DELETE /chat/sessions/:id",
      "GET /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/cancel",
      "DELETE /chat/sessions/:id/messages/:messageId",
    ];
    chatLogger.info("routes registered", { chatRoutes });
  }

}
