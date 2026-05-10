import type { ChatAttachment, ChatRoomCreateInput, ChatRoomStatus, ChatRoomUpdateInput } from "@fusion/core";
import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import type { ApiRoutesContext } from "./types.js";

function isSlugCollisionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("slug") || message.includes("exists");
}

export function registerChatRoomRoutes(ctx: ApiRoutesContext): void {
  const { router, options, chatLogger, rethrowAsApiError } = ctx;

  router.get("/chat/rooms", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const { projectId, status, agentId } = req.query as {
        projectId?: string;
        status?: string;
        agentId?: string;
      };

      const statusFilter = status as ChatRoomStatus | undefined;
      const rooms = agentId
        ? chatStore.listRoomsForAgent(agentId, { projectId, status: statusFilter })
        : chatStore.listRooms({ projectId, status: statusFilter });

      res.json({ rooms });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to list chat rooms");
    }
  });

  router.post("/chat/rooms", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const { name, description, projectId, createdBy, memberAgentIds } = req.body as {
        name?: string;
        description?: string | null;
        projectId?: string | null;
        createdBy?: string | null;
        memberAgentIds?: string[];
      };

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }

      const roomInput: ChatRoomCreateInput & { memberAgentIds?: string[] } = {
        name: name.trim(),
        ...(description !== undefined ? { description } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(createdBy !== undefined ? { createdBy } : {}),
        ...(Array.isArray(memberAgentIds) ? { memberAgentIds } : {}),
      };

      let room;
      try {
        room = chatStore.createRoom(roomInput);
      } catch (err) {
        if (isSlugCollisionError(err)) {
          throw new ApiError(409, err instanceof Error ? err.message : "Room slug already exists");
        }
        throw err;
      }

      const members = chatStore.listRoomMembers(room.id);
      res.status(201).json({ room, members });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to create chat room");
    }
  });

  router.get("/chat/rooms/:id", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const members = chatStore.listRoomMembers(roomId);
      res.json({ room, members });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to get chat room");
    }
  });

  router.patch("/chat/rooms/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const { name, description, status } = req.body as { name?: string; description?: string | null; status?: ChatRoomStatus };

      if (name === undefined && description === undefined && status === undefined) {
        throw badRequest("at least one of name, description, or status is required");
      }

      const input: ChatRoomUpdateInput = {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
      };

      let room;
      try {
        room = chatStore.updateRoom(roomId, input);
      } catch (err) {
        if (isSlugCollisionError(err)) {
          throw new ApiError(409, err instanceof Error ? err.message : "Room slug already exists");
        }
        throw err;
      }

      if (!room) throw notFound(`Chat room ${roomId} not found`);
      res.json({ room });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to update chat room");
    }
  });

  router.delete("/chat/rooms/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      chatStore.deleteRoom(roomId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete chat room");
    }
  });

  router.get("/chat/rooms/:id/members", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const members = chatStore.listRoomMembers(roomId);
      res.json({ members });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to list chat room members");
    }
  });

  router.post("/chat/rooms/:id/members", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { agentId, role } = req.body as { agentId?: string; role?: "owner" | "member" };
      if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
        throw badRequest("agentId is required and must be a non-empty string");
      }
      if (role !== undefined && role !== "owner" && role !== "member") {
        throw badRequest("role must be 'owner' or 'member'");
      }

      const member = chatStore.addRoomMember(roomId, agentId.trim(), role ?? "member");
      res.status(201).json({ member });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to add chat room member");
    }
  });

  router.delete("/chat/rooms/:id/members/:agentId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const agentId = String(req.params.agentId);
      const removed = chatStore.removeRoomMember(roomId, agentId);
      if (!removed) throw notFound(`Room member ${agentId} not found in room ${roomId}`);

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to remove chat room member");
    }
  });

  router.get("/chat/rooms/:id/messages", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { limit: limitStr, offset: offsetStr, before } = req.query as { limit?: string; offset?: string; before?: string };
      const limit = limitStr !== undefined ? parseInt(String(limitStr), 10) : 50;
      const offset = offsetStr !== undefined ? parseInt(String(offsetStr), 10) : 0;
      if (!Number.isFinite(limit) || limit < 1) throw badRequest("limit must be a positive integer");
      if (!Number.isFinite(offset) || offset < 0) throw badRequest("offset must be a non-negative integer");

      const messages = chatStore.getRoomMessages(roomId, {
        limit,
        offset,
        ...(before ? { before } : {}),
      });

      res.json({ messages });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to list chat room messages");
    }
  });

  router.post("/chat/rooms/:id/messages", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { content, senderAgentId, attachments } = req.body as {
        content?: string;
        senderAgentId?: string | null;
        mentions?: string[];
        attachments?: ChatAttachment[];
      };

      if (!content || typeof content !== "string" || !content.trim()) {
        throw badRequest("content is required and must be a non-empty string");
      }
      if (senderAgentId !== undefined && senderAgentId !== null) {
        throw badRequest("senderAgentId is reserved for FN-3810; must be null or omitted");
      }

      const chatManager = options?.chatManager;
      if (!chatManager) throw internalError("Chat manager not available");

      const result = await chatManager.sendRoomMessage(roomId, content.trim(), Array.isArray(attachments) ? attachments : undefined);

      res.status(201).json({ message: result.userMessage });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to create chat room message");
    }
  });

  router.delete("/chat/rooms/:id/messages/:messageId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const messageId = String(req.params.messageId);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const message = chatStore.getRoomMessage(messageId);
      if (!message || message.roomId !== roomId) {
        throw notFound(`Message ${messageId} not found`);
      }

      chatStore.deleteRoomMessage(messageId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete chat room message");
    }
  });

  router.post("/chat/rooms/:id/messages/:messageId/attachments", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const chatStore = options?.chatStore;
      if (!chatStore) throw internalError("Chat store not available");

      const roomId = String(req.params.id);
      const messageId = String(req.params.messageId);
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const message = chatStore.getRoomMessage(messageId);
      if (!message || message.roomId !== roomId) {
        throw notFound(`Message ${messageId} not found`);
      }

      const attachment = req.body as ChatAttachment;
      if (!attachment || typeof attachment !== "object") {
        throw badRequest("attachment payload is required");
      }

      const updatedMessage = chatStore.addRoomMessageAttachment(roomId, messageId, attachment);
      res.json({ message: updatedMessage });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to add chat room message attachment");
    }
  });

  if (process.env.FUSION_DEBUG_CHAT_ROUTES === "1") {
    const chatRoomRoutes = [
      "GET /chat/rooms",
      "POST /chat/rooms",
      "GET /chat/rooms/:id",
      "PATCH /chat/rooms/:id",
      "DELETE /chat/rooms/:id",
      "GET /chat/rooms/:id/members",
      "POST /chat/rooms/:id/members",
      "DELETE /chat/rooms/:id/members/:agentId",
      "GET /chat/rooms/:id/messages",
      "POST /chat/rooms/:id/messages",
      "DELETE /chat/rooms/:id/messages/:messageId",
      "POST /chat/rooms/:id/messages/:messageId/attachments",
    ];
    chatLogger.info("room routes registered", { chatRoomRoutes });
  }
}
