import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { EnrichedChatSession, ChatAttachment } from "@fusion/core";
import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import { writeSSEEvent } from "../sse-buffer.js";
import type { ApiRoutesContext } from "./types.js";

interface ChatRouteDeps {
  parseLastEventId: (req: import("express").Request) => number | undefined;
  validateOptionalModelField: (value: unknown, fieldName: string) => string | undefined;
  upload: import("multer").Multer;
}

const CHAT_ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "application/json",
  "text/yaml",
  "text/x-toml",
  "text/csv",
  "application/xml",
]);

const CHAT_MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

function resolveAttachmentPath(rootDir: string, sessionId: string, filename: string): { sessionDir: string; filePath: string } {
  const sessionDir = resolve(rootDir, ".fusion", "chat-attachments", sessionId);
  const safeName = basename(filename);
  const filePath = resolve(sessionDir, safeName);
  if (!filePath.startsWith(`${sessionDir}/`) && filePath !== sessionDir) {
    throw badRequest("Invalid attachment path");
  }
  return { sessionDir, filePath };
}

export function registerChatRoutes(ctx: ApiRoutesContext, deps: ChatRouteDeps): void {
  const { router, options, getProjectContext, chatLogger, rethrowAsApiError } = ctx;
  const { parseLastEventId, validateOptionalModelField, upload } = deps;

  const uploadChatAttachment: import("express").RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const multerError = err as { code?: string; message?: string };
      if (multerError?.code === "LIMIT_FILE_SIZE") {
        next(badRequest(`File too large. Maximum: ${CHAT_MAX_ATTACHMENT_SIZE} bytes (5MB)`));
        return;
      }
      next(err as Error);
    });
  };

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

        // Batch-gather generating session IDs to avoid N+1 calls
        const generatingIds = options?.chatManager?.getGeneratingSessionIds?.() ?? [];
        const generatingSet = new Set(generatingIds);

        for (const session of sessions) {
          const lastMessage = lastMessages.get(session.id);
          const enriched: EnrichedChatSession = session;
          if (lastMessage) {
            // Truncate content to 100 chars for preview
            const content = lastMessage.content || "";
            enriched.lastMessagePreview =
              content.length > 100 ? content.slice(0, 100) + "…" : content;
            enriched.lastMessageAt = lastMessage.createdAt;
          }
          enriched.isGenerating = generatingSet.has(session.id);
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

      const enriched: EnrichedChatSession = session;
      enriched.isGenerating = options?.chatManager?.isGenerating?.(sessionId) ?? false;

      res.json({ session: enriched });
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

  router.post("/chat/sessions/:id/attachments", rateLimit(RATE_LIMITS.mutation), uploadChatAttachment, async (req, res) => {
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

      const file = req.file;
      if (!file) {
        throw badRequest("file is required");
      }

      if (!CHAT_ALLOWED_MIME_TYPES.has(file.mimetype)) {
        throw badRequest(`Invalid mime type '${file.mimetype}'`);
      }

      if (file.size > CHAT_MAX_ATTACHMENT_SIZE) {
        throw badRequest(`File too large (${file.size} bytes). Maximum: ${CHAT_MAX_ATTACHMENT_SIZE} bytes (5MB)`);
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const sessionDir = resolve(rootDir, ".fusion", "chat-attachments", sessionId);
      await mkdir(sessionDir, { recursive: true });

      const sanitizedFilename = (file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${Date.now()}-${sanitizedFilename}`;
      const filePath = join(sessionDir, filename);
      await writeFile(filePath, file.buffer);

      const attachment: ChatAttachment = {
        id: `att-${randomUUID().slice(0, 8)}`,
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        createdAt: new Date().toISOString(),
      };

      res.status(201).json({ attachment });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to upload chat attachment");
    }
  });

  router.get("/chat/sessions/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const { filePath } = resolveAttachmentPath(rootDir, String(req.params.id), String(req.params.filename));
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.status(404).json({ error: "Attachment not found" });
        } else {
          res.end();
        }
      });
      res.setHeader("Content-Type", "application/octet-stream");
      stream.pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to fetch chat attachment");
    }
  });

  router.delete("/chat/sessions/:id/attachments/:filename", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const { filePath } = resolveAttachmentPath(rootDir, String(req.params.id), String(req.params.filename));
      await rm(filePath);
      res.json({ success: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw notFound("Attachment not found");
      }
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete chat attachment");
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
   * - done: Message sent successfully with messageId + persisted assistant message snapshot
   * - error: Error message
   */
  router.post("/chat/sessions/:id/messages", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      const chatManager = options?.chatManager;
      if (!chatStore || !chatManager) {
        throw internalError("Chat store or manager not available");
      }

      const { content, modelProvider, modelId, attachments } = req.body as {
        content?: string;
        modelProvider?: string;
        modelId?: string;
        attachments?: ChatAttachment[];
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

      // Allocate a generation up front so subscription and sendMessage broadcasts
      // share the same id. This filters out stragglers from a prior, just-cancelled
      // generation that would otherwise hit this fresh subscriber and falsely look
      // like an error/done for this request.
      const { generationId } = chatManager.beginGeneration(sessionId);

      // Subscribe to session events for this generation only.
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
      }, { generationId });

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
        }, { generationId });
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
        Array.isArray(attachments) ? attachments : undefined,
        { generationId },
      ).catch((err: Error) => {
        chatLogger.error("Error in sendMessage", {
          error: err.message,
        });
        chatStreamManager.broadcast(sessionId, {
          type: "error",
          data: err.message || "Failed to process message",
        }, { generationId });
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
      "POST /chat/sessions/:id/attachments",
      "GET /chat/sessions/:id/attachments/:filename",
      "DELETE /chat/sessions/:id/attachments/:filename",
      "POST /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/cancel",
      "DELETE /chat/sessions/:id/messages/:messageId",
    ];
    chatLogger.info("routes registered", { chatRoutes });
  }

}
