import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ChatAttachment, ChatRoomCreateInput, ChatRoomStatus, ChatRoomUpdateInput } from "@fusion/core";
import type { Request } from "express";
import { RoomReplyGenerationError } from "../chat.js";
import { createProjectScopedChatManager, resolveProjectChatContext } from "../chat-project-services.js";
import { ApiError, badRequest, internalError, notFound } from "../api-error.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import { CHAT_ALLOWED_MIME_TYPES, CHAT_MAX_ATTACHMENT_SIZE } from "./chat-attachment-config.js";
import type { ApiRoutesContext } from "./types.js";

function isSlugCollisionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("slug") || message.includes("exists");
}

interface ChatRoomRouteDeps {
  upload: import("multer").Multer;
}

function resolveRoomAttachmentPath(rootDir: string, roomId: string, filename: string): { roomDir: string; filePath: string } {
  const roomDir = resolve(rootDir, ".fusion", "chat-room-attachments", roomId);
  const safeName = basename(filename);
  if (safeName !== filename) {
    throw badRequest("Invalid attachment path");
  }
  const filePath = resolve(roomDir, safeName);
  if (!filePath.startsWith(`${roomDir}/`) && filePath !== roomDir) {
    throw badRequest("Invalid attachment path");
  }
  return { roomDir, filePath };
}

export function registerChatRoomRoutes(ctx: ApiRoutesContext, deps: ChatRoomRouteDeps): void {
  const { router, options, getProjectContext, chatLogger, rethrowAsApiError } = ctx;
  const { upload } = deps;

  const uploadChatAttachment: import("express").RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const multerError = err as { code?: string };
      if (multerError?.code === "LIMIT_FILE_SIZE") {
        next(badRequest(`File too large. Maximum: ${CHAT_MAX_ATTACHMENT_SIZE} bytes (5MB)`));
        return;
      }
      next(err as Error);
    });
  };

  function getRequestedProjectId(req: Request): string | undefined {
    return typeof req.query.projectId === "string"
      ? req.query.projectId
      : (typeof req.body?.projectId === "string" ? req.body.projectId : undefined);
  }

  async function resolveRoomScopedServices(req: Request, roomProjectId: string | null | undefined) {
    if (!roomProjectId) {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }
      const chatManager = options?.chatManager ?? await createProjectScopedChatManager({
        store: ctx.store,
        chatStore,
        pluginRunner: options?.pluginRunner,
        messageStore: options?.engine?.getMessageStore(),
      });
      return { chatStore, chatManager };
    }

    if (!options?.engineManager) {
      const chatStore = options?.chatStore;
      if (!chatStore) {
        throw internalError("Chat store not available");
      }
      const chatManager = options?.chatManager ?? await createProjectScopedChatManager({
        store: ctx.store,
        chatStore,
        pluginRunner: options?.pluginRunner,
        messageStore: options?.engine?.getMessageStore(),
      });
      return { chatStore, chatManager };
    }

    const { store: scopedStore, chatStore } = await resolveProjectChatContext({
      projectId: roomProjectId,
      defaultStore: ctx.store,
      defaultChatStore: options?.chatStore,
      engineManager: options?.engineManager,
    });
    const engine = options.engineManager.getEngine(roomProjectId);
    const chatManager = await createProjectScopedChatManager({
      store: scopedStore,
      chatStore,
      pluginRunner: options?.pluginRunner,
      messageStore: engine?.getMessageStore(),
    });
    return { chatStore, chatManager };
  }

  router.get("/chat/rooms", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const projectId = getRequestedProjectId(req);
      const { chatStore } = await resolveRoomScopedServices(req, projectId);
      const { status, agentId } = req.query as {
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
      const { name, description, projectId, createdBy, memberAgentIds } = req.body as {
        name?: string;
        description?: string | null;
        projectId?: string | null;
        createdBy?: string | null;
        memberAgentIds?: string[];
      };
      const { chatStore } = await resolveRoomScopedServices(req, projectId);

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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { limit: limitStr, offset: offsetStr, before, order: orderStr } = req.query as {
        limit?: string;
        offset?: string;
        before?: string;
        order?: string;
      };
      const limit = limitStr !== undefined ? parseInt(String(limitStr), 10) : 50;
      const offset = offsetStr !== undefined ? parseInt(String(offsetStr), 10) : 0;
      const order = orderStr === undefined ? "asc" : String(orderStr);
      if (!Number.isFinite(limit) || limit < 1) throw badRequest("limit must be a positive integer");
      if (!Number.isFinite(offset) || offset < 0) throw badRequest("offset must be a non-negative integer");
      if (order !== "asc" && order !== "desc") throw badRequest("order must be either asc or desc");

      const messages = chatStore.getRoomMessages(roomId, {
        limit,
        offset,
        order,
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
      const roomId = String(req.params.id);
      const hintedProjectId = getRequestedProjectId(req);
      const services = await resolveRoomScopedServices(req, hintedProjectId);
      const room = services.chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { content, senderAgentId, attachments } = req.body as {
        content?: string;
        senderAgentId?: string | null;
        mentions?: string[];
        attachments?: ChatAttachment[];
      };

      const messageAttachments = Array.isArray(attachments) ? attachments : undefined;
      if (content !== undefined && typeof content !== "string") {
        throw badRequest("content is required and must be a non-empty string");
      }
      const trimmedContent = content?.trim() ?? "";
      /**
       * FNXC:ChatRooms 2026-06-17-02:12:
       * Room chat must accept attachment-only messages from main and quick chat while continuing to reject fully empty sends with no text and no attachment references.
       */
      if (!trimmedContent && (messageAttachments?.length ?? 0) === 0) {
        throw badRequest("content is required and must be a non-empty string");
      }
      if (senderAgentId !== undefined && senderAgentId !== null) {
        throw badRequest("senderAgentId is reserved for FN-3810; must be null or omitted");
      }

      const result = await services.chatManager.sendRoomMessage(roomId, trimmedContent, messageAttachments);
      res.status(201).json({ message: result.userMessage });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof RoomReplyGenerationError) {
        throw new ApiError(502, err.message);
      }
      rethrowAsApiError(err, "Failed to create chat room message");
    }
  });

  router.delete("/chat/rooms/:id/messages/:messageId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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

  router.delete("/chat/rooms/:id/messages", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const deletedCount = chatStore.clearRoomMessages(roomId);
      res.json({ success: true, deletedCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to clear chat room messages");
    }
  });

  router.post("/chat/rooms/:id/attachments", rateLimit(RATE_LIMITS.mutation), uploadChatAttachment, async (req, res) => {
    try {
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const file = req.file;
      if (!file) throw badRequest("file is required");
      if (!CHAT_ALLOWED_MIME_TYPES.has(file.mimetype)) throw badRequest(`Invalid mime type '${file.mimetype}'`);
      if (file.size > CHAT_MAX_ATTACHMENT_SIZE) {
        throw badRequest(`File too large (${file.size} bytes). Maximum: ${CHAT_MAX_ATTACHMENT_SIZE} bytes (5MB)`);
      }

      const { store: scopedStore } = await getProjectContext(req);
      const roomDir = resolve(scopedStore.getRootDir(), ".fusion", "chat-room-attachments", roomId);
      await mkdir(roomDir, { recursive: true });

      const sanitizedFilename = (file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${Date.now()}-${sanitizedFilename}`;
      const filePath = join(roomDir, filename);
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
      rethrowAsApiError(err, "Failed to upload chat room attachment");
    }
  });

  router.get("/chat/rooms/:id/attachments/:filename", async (req, res) => {
    try {
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
      const room = chatStore.getRoom(roomId);
      if (!room) throw notFound(`Chat room ${roomId} not found`);

      const { store: scopedStore } = await getProjectContext(req);
      const { filePath } = resolveRoomAttachmentPath(scopedStore.getRootDir(), roomId, String(req.params.filename));
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
      rethrowAsApiError(err, "Failed to fetch chat room attachment");
    }
  });

  router.post("/chat/rooms/:id/messages/:messageId/attachments", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const roomId = String(req.params.id);
      const { chatStore } = await resolveRoomScopedServices(req, getRequestedProjectId(req));
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
      "DELETE /chat/rooms/:id/messages",
      "POST /chat/rooms/:id/attachments",
      "GET /chat/rooms/:id/attachments/:filename",
      "POST /chat/rooms/:id/messages/:messageId/attachments",
    ];
    chatLogger.info("room routes registered", { chatRoomRoutes });
  }
}
