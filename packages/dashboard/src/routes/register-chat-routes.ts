import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { THINKING_LEVELS, type EnrichedChatSession, type ChatAttachment } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
/*
FNXC:GrokAcp 2026-07-11-18:30:
List/create and ChatManager share resolveProjectChatContext (not getOrCreateProjectStore /
getOrCreateScopedChatStore at this layer). Direct imports of those helpers were leftover after
the store-alignment fix and failed lint as unused; keep manager construction on the resolved
store/chatStore pair only.
*/
import { getOrCreateScopedChatManager, resolveProjectChatContext } from "../chat-project-services.js";
import { CHAT_ALLOWED_MIME_TYPES, CHAT_MAX_ATTACHMENT_SIZE } from "./chat-attachment-config.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import { writeSSEEvent, type SessionBufferedEvent } from "../sse-buffer.js";
import { TASK_PLANNER_CHAT_AGENT_ID_PREFIX } from "../chat.js";
import type { ApiRoutesContext } from "./types.js";

interface ChatRouteDeps {
  parseLastEventId: (req: import("express").Request) => number | undefined;
  replayBufferedSSE: (res: import("express").Response, bufferedEvents: SessionBufferedEvent[]) => boolean;
  validateOptionalModelField: (value: unknown, fieldName: string) => string | undefined;
  upload: import("multer").Multer;
}

const CHAT_MESSAGE_MAX_ATTACHMENTS = 10;

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
  const { router, options, store, getProjectContext, chatLogger, rethrowAsApiError } = ctx;
  const { parseLastEventId, replayBufferedSSE, validateOptionalModelField, upload } = deps;

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

  const uploadChatMessageAttachments: import("express").RequestHandler = (req, res, next) => {
    upload.array("attachments", CHAT_MESSAGE_MAX_ATTACHMENTS)(req, res, (err?: unknown) => {
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

  const persistChatAttachment = async (
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    rootDir: string,
    sessionId: string,
  ): Promise<ChatAttachment> => {
    if (!CHAT_ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw badRequest(`Invalid mime type '${file.mimetype}'`);
    }

    if (file.size > CHAT_MAX_ATTACHMENT_SIZE) {
      throw badRequest(`File too large (${file.size} bytes). Maximum: ${CHAT_MAX_ATTACHMENT_SIZE} bytes (5MB)`);
    }

    const sessionDir = resolve(rootDir, ".fusion", "chat-attachments", sessionId);
    await mkdir(sessionDir, { recursive: true });

    const sanitizedFilename = (file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${Date.now()}-${sanitizedFilename}`;
    const filePath = join(sessionDir, filename);
    await writeFile(filePath, file.buffer);

    return {
      id: `att-${randomUUID().slice(0, 8)}`,
      filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      createdAt: new Date().toISOString(),
    };
  };

  // ── Per-project store / manager resolution ───────────────────────────────────

  async function resolveScopedChatStore(projectId: string | undefined) {
    return resolveProjectChatContext({
      projectId,
      defaultStore: store,
      defaultChatStore: options?.chatStore,
      engineManager: options?.engineManager,
    });
  }

  async function resolveScopedChatManager(projectId: string | undefined) {
    if (!projectId) {
      if (!options?.chatManager) throw new ApiError(503, "Chat manager not available");
      return options.chatManager;
    }
    /*
    FNXC:GrokAcp 2026-07-11-17:00:
    Chat list/create use resolveProjectChatContext, which falls back to the host
    default store when no engine is running for the project (nested dashboard /
    lockfile-blocked engines). ChatManager must use that same store/chatStore
    pair — getOrCreateProjectStore alone pointed at a different fusion dir, so
    sessions visible in the UI 404'd on sendMessage ("Chat session not found").
    Prefer the engine plugin runner when available; otherwise the host runner
    (e.g. Grok ACP 0.2) so CLI runtimes still resolve.
    */
    const { store: scopedStore, chatStore } = await resolveScopedChatStore(projectId);
    const engine = options?.engineManager?.getEngine(projectId);
    const projectPluginRunner = engine?.getPluginRunner?.();
    const pluginRunner = projectPluginRunner ?? options?.pluginRunner;
    return getOrCreateScopedChatManager(scopedStore, chatStore, pluginRunner, Boolean(projectPluginRunner), engine?.getMessageStore());
  }
  const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

  function validateThinkingLevel(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw badRequest("thinkingLevel must be a string");
    }
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (!THINKING_LEVEL_SET.has(normalized)) {
      throw badRequest(`thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    return normalized;
  }

  function validateModelPair(modelProvider: unknown, modelId: unknown): { modelProvider?: string; modelId?: string } {
    let normalizedProvider: string | undefined;
    let normalizedModelId: string | undefined;
    try {
      normalizedProvider = validateOptionalModelField(modelProvider, "modelProvider");
      normalizedModelId = validateOptionalModelField(modelId, "modelId");
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Invalid model override");
    }
    if (Boolean(normalizedProvider) !== Boolean(normalizedModelId)) {
      throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
    }
    return normalizedProvider && normalizedModelId
      ? { modelProvider: normalizedProvider, modelId: normalizedModelId }
      : {};
  }

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
  Task planner Chat uses a synthetic task-scoped chat target (`task-planner:<taskId>`) so the dashboard can persist/resume a conversation without binding it to an executor/reviewer agent or the Activity steering-comment pipeline. The route validates the task in the scoped project store and stores the effective planning model override on the session.

  FNXC:TaskDetailPlannerChatRetention 2026-06-30-18:45:
  Planner chats that already have user interaction remain available when a task reaches done, and archived-task cleanup removes existing task-planner sessions through ChatStore deletion so archived tasks stop retaining task-local planner context.

  FNXC:TaskDetailPlannerChat 2026-07-01-21:40:
  Completed tasks may start a task-detail planner Chat after the fact so operators can ask retrospective questions and request a refinement from the completed source task. Archived tasks remain non-startable, and common Chat feed visibility is still controlled only by the global task-chat filtering setting below.
  */
  router.post("/chat/task-planner/:taskId/session", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const rawTaskId = req.params.taskId;
      const taskId = typeof rawTaskId === "string" ? rawTaskId.trim() : "";
      if (!taskId) {
        throw badRequest("taskId is required");
      }

      const { modelProvider, modelId } = validateModelPair(req.body?.modelProvider, req.body?.modelId);
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(projectId);
      const task = await scopedStore.getTask(taskId).catch(() => null);
      if (!task) {
        throw notFound(`Task ${taskId} not found`);
      }

      const agentId = `${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${task.id}`;
      let existing = await chatStore.findLatestActiveSessionForTarget({
        agentId,
        ...(projectId ? { projectId } : {}),
      });

      // FNXC:CentralProjectIdentity 2026-07-14-00:15:
      // ctx projectId now resolves to the launch id, so a projectId-filtered lookup
      // misses legacy active planner sessions created with a null projectId → we'd
      // create a duplicate. On a scoped miss, retry unscoped and reuse a matched
      // legacy (null-projectId) session for this task-specific agent. The projectId
      // is not stamped onto it: ChatSessionUpdateInput has no projectId field, so no
      // clean update path exists — reusing it is enough to prevent the duplicate.
      if (!existing && projectId) {
        const legacy = await chatStore.findLatestActiveSessionForTarget({ agentId });
        if (legacy && legacy.projectId == null) {
          existing = legacy;
        }
      }

      if (existing) {
        const session = modelProvider && modelId
          ? await chatStore.updateSession(existing.id, { modelProvider, modelId })
          : existing;
        res.json({ session });
        return;
      }

      if (task.column === "archived") {
        throw badRequest(`Task ${task.id} is archived; planner chat cannot be started for archived tasks`);
      }

      const session = await chatStore.createSession({
        agentId,
        title: `${task.id} planner chat`,
        projectId: projectId ?? null,
        modelProvider: modelProvider ?? null,
        modelId: modelId ?? null,
      });
      res.status(201).json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create task planner chat session");
    }
  });

  // ── Chat Routes ────────────────────────────────────────────────────────────

  /**
   * GET /api/chat/sessions
   * List chat sessions with optional filtering.
   * Query params: projectId?, status?, agentId?, q?, titleOnly?
   *
   * FNXC:ChatSearch 2026-07-07-00:00:
   * `q` triggers a server-side message-content search (title/agentId filtering stays
   * client-side, unchanged) because chat message bodies are not fully loaded client-side.
   * `titleOnly=true` (or `q` absent) preserves the exact prior behavior: the normal enriched
   * session list, with title/agent filtering left to the client. When `q` is present and
   * titleOnly is not set, the result is narrowed to sessions whose content matches
   * `q` (via ChatStore.searchSessionsByMessageContent), scoped by the same
   * projectId/status/agentId filters and the task-planner common-feed guard used below, with
   * `matchedMessagePreview` attached. The dashboard hook unions this with its local
   * title/agent match so "content mode" covers both signals.
   *
   * Response is enriched with lastMessagePreview and lastMessageAt for each session.
   */
  router.get("/chat/sessions", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const { projectId, status, agentId, lookup, modelProvider, modelId, q, titleOnly } = req.query as {
        projectId?: string;
        status?: string;
        agentId?: string;
        lookup?: string;
        modelProvider?: string;
        modelId?: string;
        q?: string;
        titleOnly?: string;
      };
      const { store: scopedStore, chatStore } = await resolveScopedChatStore(projectId);
      const hasSearchQuery = typeof q === "string" && q.trim().length > 0;
      const isTitleOnly = titleOnly === "true" || !hasSearchQuery;
      const isContentSearch = hasSearchQuery && !isTitleOnly;

      const isResumeLookup = lookup === "resume";
      const hasModelProvider = typeof modelProvider === "string" && modelProvider.trim().length > 0;
      const hasModelId = typeof modelId === "string" && modelId.trim().length > 0;
      if (hasModelProvider !== hasModelId) {
        throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
      }

      if (isResumeLookup && (!agentId || !agentId.trim())) {
        throw badRequest("agentId is required when lookup=resume");
      }

      let sessions = isResumeLookup
        ? await (async () => {
            const matched = await chatStore.findLatestActiveSessionForTarget({
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
        : await chatStore.listSessions({
            ...(projectId && { projectId }),
            ...(status && { status: status as "active" | "archived" }),
            ...(agentId && { agentId }),
          });

      // Enrich sessions with last message preview
      if (sessions.length > 0) {
        const sessionIds = sessions.map((s) => s.id);
        const lastMessages = await chatStore.getLastMessageForSessions(sessionIds);

        if (!isResumeLookup) {
          const settings = await scopedStore.getSettings();
          const showTaskChatsInCommonFeed = settings.showTaskChatsInCommonFeed === true;
          /*
          FNXC:TaskDetailPlannerChat 2026-06-30-18:35:
          Planner-chat sessions may appear in global Chat only after a user has sent at least one message. Lazy creation prevents most empty rows; this server-side guard keeps stale/legacy task-planner rows with no messages out of every global Chat surface while preserving normal direct and room sessions.

          FNXC:ChatModal 2026-07-01-00:00:
          The common Chat feed now excludes task-planner sessions unless the project setting explicitly opts in. Resume lookups and task-detail Chat routes bypass this common-feed filter so task planning history remains reachable from task detail.
          */
          sessions = sessions.filter((session) => {
            if (!session.agentId.startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX)) return true;
            if (!showTaskChatsInCommonFeed) return false;
            return lastMessages.has(session.id);
          });
        }

        /*
        FNXC:ChatSearch 2026-07-07-00:00:
        Content search runs AFTER the task-planner common-feed filter above so a matching
        message inside a hidden task-planner session can never bypass that guard. It also runs
        after resume-lookup narrowing, so `lookup=resume` and task-detail routes are unaffected
        (isContentSearch is only true for the plain listSessions path).
        */
        let contentMatches: Map<string, string> | undefined;
        if (isContentSearch && !isResumeLookup) {
          contentMatches = await chatStore.searchSessionsByMessageContent(q!.trim(), sessions.map((s) => s.id));
          sessions = sessions.filter((session) => contentMatches!.has(session.id));
        }

        // Batch-gather generating session IDs to avoid N+1 calls
        const resolvedChatManager = projectId
          ? await resolveScopedChatManager(projectId).catch(() => options?.chatManager)
          : options?.chatManager;
        const generatingIds = resolvedChatManager?.getGeneratingSessionIds?.() ?? [];
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
          if (contentMatches) {
            const matchedPreview = contentMatches.get(session.id);
            if (matchedPreview !== undefined) {
              enriched.matchedMessagePreview = matchedPreview;
            }
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
   * Body: { agentId: string, title?: string, modelProvider?: string, modelId?: string, thinkingLevel?: string }
   * If modelProvider and modelId are provided, those are used. Otherwise the model is
   * resolved from the agent's runtimeConfig.model setting.
   * The session is scoped to the project identified by projectId query param or header.
   */
  router.post("/chat/sessions", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      // Get project context to scope the session and resolve agent from the correct store
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(projectId);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
      await agentStore.init();

      const { agentId, title, modelProvider, modelId, thinkingLevel: rawThinkingLevel } = req.body as {
        agentId?: string;
        title?: string;
        modelProvider?: string;
        modelId?: string;
        thinkingLevel?: string;
      };

      if (!agentId || typeof agentId !== "string" || !agentId.trim()) {
        throw badRequest("agentId is required");
      }

      const thinkingLevel = validateThinkingLevel(rawThinkingLevel);

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
      const session = await chatStore.createSession({
        agentId: agentId.trim(),
        title: title?.trim() || null,
        projectId: projectId ?? null,
        modelProvider: resolvedProvider,
        modelId: resolvedModelId,
        ...(thinkingLevel ? { thinkingLevel } : {}),
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
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const enriched: EnrichedChatSession = session;
      const chatManager = await resolveScopedChatManager(req.query.projectId as string | undefined).catch(() => options?.chatManager);
      enriched.isGenerating = chatManager?.isGenerating?.(sessionId) ?? false;

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
   * Update a chat session (title, status, thinkingLevel, model, or agent target).
   * Body: { title?: string, status?: "active" | "archived", thinkingLevel?: string | null,
   *         modelProvider?: string | null, modelId?: string | null, agentId?: string }
   *
   * FNXC:Chat-ThinkingLevel 2026-07-12-19:30:
   * FN-7775 only let a user pick a session's thinking level at creation time
   * (POST /chat/sessions). FN-7898 lets an EXISTING model-loop session's
   * reasoning-effort level be changed mid-conversation from the in-chat
   * composer control, distinct from that create-time picker. `null`/`""`
   * is an explicit clear back to the project/global default (mirrors the
   * create-time semantics where an absent/empty thinkingLevel means
   * "inherit"); omitting the key entirely leaves the session's stored
   * value untouched, matching the existing title/status behavior below.
   *
   * FNXC:Chat-ModelSwitch 2026-07-12-20:15:
   * FN-7908 extends this SAME route (rather than adding a new one) so the
   * brain-icon popup introduced by FN-7898 can also retarget an active
   * Direct chat's model or switch it to a real agent mid-conversation.
   * modelProvider/modelId are validated as a pair via the existing
   * validateModelPair helper (used elsewhere in this file for task-planner
   * session creation); agentId is validated as a non-empty string. Both are
   * forwarded to chatStore.updateSession only when present in the body so
   * omitted keys stay untouched, matching the thinkingLevel/title/status
   * pattern above.
   */
  router.patch("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);
      const {
        title,
        status,
        thinkingLevel: rawThinkingLevel,
        modelProvider: rawModelProvider,
        modelId: rawModelId,
        agentId: rawAgentId,
      } = req.body as {
        title?: string;
        status?: string;
        thinkingLevel?: string | null;
        modelProvider?: string | null;
        modelId?: string | null;
        agentId?: string;
      };

      // Validate status if provided
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw badRequest("status must be 'active' or 'archived'");
      }

      // Normalize thinkingLevel before persisting: undefined leaves the field
      // untouched (key omitted below), null/empty-string is an explicit clear
      // to inherit the default, and any other value is validated against
      // THINKING_LEVELS via the existing validateThinkingLevel helper.
      let normalizedThinkingLevel: string | null | undefined;
      if (rawThinkingLevel !== undefined) {
        if (rawThinkingLevel === null || (typeof rawThinkingLevel === "string" && rawThinkingLevel.trim() === "")) {
          normalizedThinkingLevel = null;
        } else {
          const validated = validateThinkingLevel(rawThinkingLevel);
          normalizedThinkingLevel = validated ?? null;
        }
      }

      // FNXC:Chat-ModelSwitch — modelProvider/modelId are only validated (and
      // therefore only forwarded) when at least one of them is present in the
      // body, so a PATCH that omits both keys entirely leaves the session's
      // stored model target untouched instead of tripping the pair-mismatch
      // check below.
      const modelPairProvided = rawModelProvider !== undefined || rawModelId !== undefined;
      const { modelProvider: normalizedModelProvider, modelId: normalizedModelId } = modelPairProvided
        ? validateModelPair(rawModelProvider, rawModelId)
        : {};

      let normalizedAgentId: string | undefined;
      if (rawAgentId !== undefined) {
        if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
          throw badRequest("agentId must be a non-empty string");
        }
        normalizedAgentId = rawAgentId.trim();
      }

      const session = await chatStore.updateSession(sessionId, {
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(status !== undefined && { status }),
        ...(normalizedThinkingLevel !== undefined && { thinkingLevel: normalizedThinkingLevel }),
        ...(modelPairProvided && { modelProvider: normalizedModelProvider ?? null, modelId: normalizedModelId ?? null }),
        ...(normalizedAgentId !== undefined && { agentId: normalizedAgentId }),
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
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);
      const sessionId = String(req.params.id);

      const deleted = await chatStore.deleteSession(sessionId);
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
   * Query params: limit? (default 50, max 200), offset? (default 0), before? (ISO timestamp), order? ('asc'|'desc')
   */
  router.get("/chat/sessions/:id/messages", async (req, res) => {
    try {
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);

      // Verify session exists
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const { limit: limitStr, offset: offsetStr, before, order } = req.query as {
        limit?: string;
        offset?: string;
        before?: string;
        order?: string;
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

      if (order !== undefined && order !== "asc" && order !== "desc") {
        throw badRequest('order must be "asc" or "desc"');
      }

      const effectiveLimit = Math.min(limit, 200);

      const messages = await chatStore.getMessages(sessionId, {
        limit: effectiveLimit,
        offset,
        ...(before && { before }),
        ...(order === "desc" || order === "asc" ? { order } : {}),
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
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const file = req.file;
      if (!file) {
        throw badRequest("file is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const attachment = await persistChatAttachment(file, scopedStore.getRootDir(), sessionId);

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
   * GET /api/chat/sessions/:id/stream
   * Attach to an in-flight generation stream for an existing session.
   */
  router.get("/chat/sessions/:id/stream", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    try {
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);
      const chatManager = await resolveScopedChatManager(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // FNXC:CentralProjectIdentity 2026-07-14-00:15:
      // ctx projectId now resolves to the launch id, but legacy sessions stored a
      // null/undefined projectId before scoping existed. Treat those as launch-owned
      // so attaching to their in-flight stream is not spuriously 404'd; only reject a
      // session that is explicitly stamped with a DIFFERENT project id.
      const { projectId } = await getProjectContext(req);
      if (projectId !== undefined && session.projectId != null && session.projectId !== projectId) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": connected\n\n");

      const { chatStreamManager } = await import("../chat.js");
      const lastEventId = parseLastEventId(req);
      const buffered = chatStreamManager.getBufferedEvents(sessionId, lastEventId ?? 0);
      if (!replayBufferedSSE(res, buffered)) {
        res.end();
        return;
      }

      if (!chatManager.isGenerating(sessionId)) {
        res.end();
        return;
      }

      const generationId = chatManager.getActiveGenerationId(sessionId);
      if (generationId === undefined) {
        res.end();
        return;
      }

      const unsubscribe = chatStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        if (event.type === "done" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      }, { generationId });

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to attach chat stream");
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
  router.post("/chat/sessions/:id/messages", rateLimit(RATE_LIMITS.sse), uploadChatMessageAttachments, async (req, res) => {
    try {
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const body = (req.body ?? {}) as {
        content?: string;
        modelProvider?: string;
        modelId?: string;
        attachments?: ChatAttachment[];
        taskId?: string;
      };
      const { content, modelProvider, modelId, attachments, taskId } = body;
      const sessionId = String(req.params.id);
      const uploadedFiles = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const referencedAttachments = Array.isArray(attachments) ? attachments : undefined;
      const hasAttachments = uploadedFiles.length > 0 || (referencedAttachments?.length ?? 0) > 0;
      if (content !== undefined && typeof content !== "string") {
        throw badRequest("content is required and must be a non-empty string");
      }
      const trimmedContent = content?.trim() ?? "";
      /**
       * FNXC:Chat 2026-06-17-02:12:
       * Attachment-only chat sends are valid user messages. Reject only payloads that have neither text nor uploaded/referenced attachments so Quick Chat and Main Chat can submit files without filler text.
       */
      if (!trimmedContent && !hasAttachments) {
        throw badRequest("content is required and must be a non-empty string");
      }

      // Verify session exists
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
      if (normalizedTaskId) {
        const expectedAgentId = `${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${normalizedTaskId}`;
        if (session.agentId !== expectedAgentId) {
          throw badRequest("taskId does not match the chat session task scope");
        }
      }

      const { store: scopedStore } = await getProjectContext(req);
      const uploadedAttachments = uploadedFiles.length > 0
        ? await Promise.all(uploadedFiles.map((file) => persistChatAttachment(file, scopedStore.getRootDir(), sessionId)))
        : undefined;
      const messageAttachments = uploadedAttachments && uploadedAttachments.length > 0
        ? uploadedAttachments
        : referencedAttachments;

      // Resolve per-project ChatManager before opening the SSE stream so
      // failures (e.g. project DB cannot be opened) produce a proper HTTP error.
      const chatManager = await resolveScopedChatManager(req.query.projectId as string | undefined);

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
        trimmedContent,
        normalizedProvider,
        normalizedModelId,
        messageAttachments,
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
      const chatManager = await resolveScopedChatManager(req.query.projectId as string | undefined);
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
      const { chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);

      const sessionId = String(req.params.id);
      const messageId = String(req.params.messageId);

      // Verify session exists
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      // Check if message exists
      const message = await chatStore.getMessage(messageId);
      if (!message) {
        throw notFound(`Message ${messageId} not found`);
      }

      // Delete the message
      const deleted = await chatStore.deleteMessage(messageId);
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

  /**
   * PATCH /api/chat/sessions/:id/messages/:messageId
   *
   * FNXC:ChatMessageEdit 2026-07-07-09:00:
   * Edit a user's earlier message: truncates the persisted transcript from (and including)
   * the target message onward AND rewinds the pi session context so the model forgets the
   * discarded turns (see ChatManager.rewindSessionForEdit). Does NOT stream a regeneration —
   * the client resends the edited content through the existing streaming POST send after this
   * call returns the retained (pre-edit) history.
   */
  router.patch("/chat/sessions/:id/messages/:messageId", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const { chatStore } = await resolveScopedChatStore(projectId);
      const chatManager = await resolveScopedChatManager(projectId);

      const sessionId = String(req.params.id);
      const messageId = String(req.params.messageId);
      const content = (req.body as { content?: unknown } | undefined)?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        throw badRequest("content must be a non-empty string");
      }

      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const message = await chatStore.getMessage(messageId);
      if (!message || message.sessionId !== sessionId) {
        throw notFound(`Message ${messageId} not found`);
      }
      if (message.role !== "user") {
        throw badRequest("Only user messages can be edited");
      }

      if (chatManager.isGenerating(sessionId)) {
        throw badRequest("Cannot edit a message while a generation is in progress");
      }

      const { retained } = await chatManager.rewindSessionForEdit(sessionId, messageId);
      res.json({ retained });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to edit chat message");
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
      "GET /chat/sessions/:id/stream",
      "POST /chat/sessions/:id/messages",
      "POST /chat/sessions/:id/cancel",
      "DELETE /chat/sessions/:id/messages/:messageId",
      "PATCH /chat/sessions/:id/messages/:messageId",
    ];
    chatLogger.info("routes registered", { chatRoutes });
  }

}
