import { randomUUID } from "node:crypto";
import { archivedColumnsForTask } from "../task-lifecycle-lanes.js";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  THINKING_LEVELS,
  createLogger,
  captureMemory,
  deleteStashChatSession,
  DEFAULT_STASH_URL,
  resolvePermanentAgentEffectiveModel,
  resolvePermanentAgentEffectiveThinkingLevel,
  resolveStashMemorySettings,
  type ChatMessage,
  type EnrichedChatSession,
  type ChatAttachment,
  type MemoryCaptureEvent,
} from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
/*
FNXC:GrokAcp 2026-07-11-18:30:
List/create and ChatManager share resolveProjectChatContext (not getOrCreateProjectStore /
getOrCreateScopedChatStore at this layer). Direct imports of those helpers were leftover after
the store-alignment fix and failed lint as unused; keep manager construction on the resolved
store/chatStore pair only.
*/
import { getOrCreateScopedChatManager, resolveProjectChatContext } from "../chat-project-services.js";
import { CHAT_ALLOWED_MIME_TYPES, CHAT_MAX_VIDEO_ATTACHMENT_SIZE, getChatAttachmentMaxSize } from "./chat-attachment-config.js";
import { rateLimit, RATE_LIMITS } from "../rate-limit.js";
import { writeSSEEvent, type SessionBufferedEvent } from "../sse-buffer.js";
import { ChatReplacementError, TASK_PLANNER_CHAT_AGENT_ID_PREFIX } from "../chat.js";
import type { ApiRoutesContext } from "./types.js";

/*
FNXC:RUFU121DeleteSync 2026-08-18-20:50:
Logger for the RUFU-121 best-effort Stash chat-session delete sync (debug for skips,
warn for failures). Follows the dashboard createLogger("dashboard-...") convention.
*/
const chatDeleteSyncLog = createLogger("dashboard-register-chat-routes");

interface ChatRouteDeps {
  parseLastEventId: (req: import("express").Request) => number | undefined;
  replayBufferedSSE: (res: import("express").Response, bufferedEvents: SessionBufferedEvent[]) => boolean;
  validateOptionalModelField: (value: unknown, fieldName: string) => string | undefined;
  upload: import("multer").Multer;
  /*
  FNXC:ChatMemoryCaptureWiring 2026-08-18-14:37:
  RUFU-068's complete-chat Stash capture is attached to the ENGINE's ChatStore
  (in-process-runtime attachChatMemoryCaptureToExecutor subscribes to
  chat:message:added on the runtime ChatStore instance). resolveProjectChatContext
  returns that engine instance only when engineManager is provided; without it
  every chat request resolves to a dashboard-local ChatStore instance and chat
  messages never reach the capture subscription — Stash shows no chat transcript
  at all (observed 2026-08-18: 6 live messages, 0 captured events).
  */
  engineManager?: import("@fusion/engine").ProjectEngineManager;
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
        next(badRequest(`File too large. Maximum: ${CHAT_MAX_VIDEO_ATTACHMENT_SIZE} bytes (100MB)`));
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
        next(badRequest(`File too large. Maximum: ${CHAT_MAX_VIDEO_ATTACHMENT_SIZE} bytes (100MB)`));
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

    const maxSize = getChatAttachmentMaxSize(file.mimetype);
    if (file.size > maxSize) {
      throw badRequest(`File too large (${file.size} bytes). Maximum: ${maxSize} bytes (${file.mimetype.startsWith("video/") ? "100MB" : "5MB"})`);
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

  async function resolveScopedChatStore(req: import("express").Request) {
    const projectContext = await getProjectContext(req);
    const chatContext = await resolveProjectChatContext({
      projectId: projectContext.projectId,
      defaultStore: store,
      defaultChatStore: options?.chatStore,
      engineManager: options?.engineManager,
      requestStore: projectContext.store,
    });
    return { ...chatContext, projectId: projectContext.projectId, engine: projectContext.engine };
  }

  async function resolveScopedChatManager(req: import("express").Request) {
    const { store: scopedStore, chatStore, projectId, engine: contextEngine } = await resolveScopedChatStore(req);
    if (!projectId) {
      if (!options?.chatManager) throw new ApiError(503, "Chat manager not available");
      return options.chatManager;
    }
    /*
    FNXC:GrokAcp 2026-07-11-17:00:
    Chat list/create and send resolve the request's canonical scoped store before
    constructing the manager. This keeps engine-unavailable secondary projects on
    their own ChatStore/TaskStore pair instead of borrowing the host default store.
    Prefer the engine plugin runner when available; otherwise the host runner
    (e.g. Grok ACP 0.2) so CLI runtimes still resolve.
    */
    const engine = contextEngine ?? options?.engineManager?.getEngine(projectId);
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
  FNXC:TaskChatDefaultModel 2026-08-19-12:12:
  Task-detail Chat keeps the synthetic task-scoped target (`task-planner:<taskId>`) for server-built context and scoped tools, while explicit sends update the persisted Direct Chat model and thinking target on that same session.

  FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
  Task planner Chat uses a synthetic task-scoped chat target (`task-planner:<taskId>`) so the dashboard can persist/resume a conversation without binding it to an executor/reviewer agent or the Activity steering-comment pipeline. The route validates the task in the scoped project store and stores the current Chat target on the session.

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
      const thinkingLevel = validateThinkingLevel(req.body?.thinkingLevel);
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { chatStore } = await resolveProjectChatContext({
        projectId,
        defaultStore: store,
        defaultChatStore: options?.chatStore,
        engineManager: options?.engineManager,
        requestStore: scopedStore,
      });
      const task = await scopedStore.getTask(taskId).catch(() => null);
      if (!task) {
        throw notFound(`Task ${taskId} not found`);
      }

      const agentId = `${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${task.id}`;

      /*
      FNXC:TaskChatDefaultModel 2026-08-19-12:47:
      Explicit task-chat sends must serialize lookup, retarget, and first creation by task target.
      The task lifecycle advisory lock is cross-process in PostgreSQL and keeps two tabs from
      creating divergent transcripts while preserving the synthetic task context boundary.
      */
      const result = await scopedStore.withPlanningLifecycleLock(task.id, async () => {
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
          const updates = {
            ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          };
          const session = Object.keys(updates).length > 0
            ? await chatStore.updateSession(existing.id, updates)
            : existing;
          return { created: false, session };
        }

        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-06:50 (batch-core):
        Planner chat is refused for archived tasks. Keyed on the literal, a renamed board started
        planner sessions against archived cards, whose rows the archive treats as immutable.
        */
        if ((await archivedColumnsForTask(scopedStore, task.id)).has(task.column)) {
          throw badRequest(`Task ${task.id} is archived; planner chat cannot be started for archived tasks`);
        }

        const session = await chatStore.createSession({
          agentId,
          title: `${task.id} planner chat`,
          projectId: projectId ?? null,
          modelProvider: modelProvider ?? null,
          modelId: modelId ?? null,
          thinkingLevel: thinkingLevel ?? null,
        });
        return { created: true, session };
      });
      if (result.created) {
        res.status(201).json({ session: result.session });
      } else {
        res.json({ session: result.session });
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create task planner chat session");
    }
  });

  /*
  FNXC:ChatTags 2026-07-25-10:55:
  Tags are a Direct-conversation taxonomy, not room metadata. Every endpoint
  resolves the project-scoped ChatStore and passes its project identity into the
  store mutation, preventing unqualified tag/session IDs from crossing scopes.
  */
  router.get("/chat/tags", rateLimit(RATE_LIMITS.api), async (req, res) => {
    try {
      const { projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(req);
      res.json({ tags: await chatStore.listTags(projectId ?? null) });
    } catch (err) { rethrowAsApiError(err, "Failed to list chat tags"); }
  });

  router.post("/chat/tags", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      if (typeof req.body?.name !== "string") throw badRequest("name must be a string");
      const { projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(req);
      const tag = await chatStore.createTag({ name: req.body.name, projectId: projectId ?? null });
      res.status(201).json({ tag });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : "Invalid tag";
      if (message.includes("tag") || message.includes("Tag")) throw badRequest(message);
      rethrowAsApiError(err, "Failed to create chat tag");
    }
  });

  router.patch("/chat/tags/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      if (typeof req.body?.name !== "string") throw badRequest("name must be a string");
      const { projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(req);
      const tag = await chatStore.renameTag(String(req.params.id), projectId ?? null, { name: req.body.name });
      if (!tag) throw notFound("Chat tag not found");
      res.json({ tag });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const message = err instanceof Error ? err.message : "Invalid tag";
      if (message.includes("tag") || message.includes("Tag")) throw badRequest(message);
      rethrowAsApiError(err, "Failed to rename chat tag");
    }
  });

  router.delete("/chat/tags/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const { projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(req);
      if (!await chatStore.deleteTag(String(req.params.id), projectId ?? null)) throw notFound("Chat tag not found");
      res.json({ success: true });
    } catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to delete chat tag"); }
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
      const { store: scopedStore, chatStore } = await resolveScopedChatStore(req);
      const hasSearchQuery = typeof q === "string" && q.trim().length > 0;
      const isTitleOnly = titleOnly === "true" || !hasSearchQuery;
      const isContentSearch = hasSearchQuery && !isTitleOnly;

      const isResumeLookup = lookup === "resume";
      const isTaskPlannerResumeLookup = isResumeLookup
        && typeof agentId === "string"
        && agentId.trim().startsWith(TASK_PLANNER_CHAT_AGENT_ID_PREFIX);
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
            let matched = await chatStore.findLatestActiveSessionForTarget({
              agentId: agentId!.trim(),
              ...(projectId && { projectId }),
              ...(!isTaskPlannerResumeLookup && hasModelProvider && hasModelId
                ? {
                    modelProvider: modelProvider!.trim(),
                    modelId: modelId!.trim(),
                  }
                : {}),
            });

            /*
            FNXC:TaskChatDefaultModel 2026-08-19-12:12:
            Synthetic task Chat lookup ignores the current Direct model and falls back to a legacy null-project session when needed. This preserves one transcript across settings changes without weakening project scoping for normal Chat sessions.
            */
            if (!matched && isTaskPlannerResumeLookup && projectId) {
              const legacy = await chatStore.findLatestActiveSessionForTarget({ agentId: agentId!.trim() });
              if (legacy?.projectId == null) matched = legacy;
            }

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
          ? await resolveScopedChatManager(req).catch(() => options?.chatManager)
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
   * If modelProvider and modelId are provided, those are used. Otherwise the model and
   * thinking level resolve through the agent's permanent-role inheritance chain.
   * The session is scoped to the project identified by projectId query param or header.
   */
  router.post("/chat/sessions", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      // Get project context to scope the session and resolve agent from the correct store
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { chatStore } = await resolveScopedChatStore(req);
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

      /*
      FNXC:ChatSessionCreate 2026-08-11-09:38:
      A chat may target a MODEL rather than an agent. The client marks that case with the synthetic sentinel id `__fn_agent__` (`app/hooks/useChat.ts`), which is deliberately never persisted as an agent row, and always sends an explicit `modelProvider`/`modelId` pair alongside it.
      FN-8869 hoisted this lookup out of the `else` branch below so it ran unconditionally, which 404'd every model-target chat ("Agent __fn_agent__ not found") and surfaced as the generic "Failed to create chat session" toast.

      The agent is REQUIRED only when it is the source of the model resolution. When the client supplies a complete model pair, a missing agent is not an error — that is the pre-FN-8869 contract, and the rest of the stack already treats the sentinel as legitimately agent-less (ChatManager tolerates a missing agent on send; the UI hides agent identity for it).
      Do not re-hoist this check: match on the supplied model pair rather than hardcoding the sentinel, so the route stays agnostic to the client's marker value.
      */
      const agent = await agentStore.getAgent(agentId);
      const hasClientModel = hasClientModelProvider && hasClientModelId;
      if (!agent && !hasClientModel) {
        throw notFound(`Agent ${agentId} not found`);
      }
      const settings = await scopedStore.getSettings();

      // Fetch the agent to resolve model configuration (only if client didn't provide model)
      let resolvedProvider: string | null = null;
      let resolvedModelId: string | null = null;
      let inheritedThinkingLevel: string | undefined;

      if (hasClientModel) {
        // Use client-provided model
        resolvedProvider = modelProvider!.trim();
        resolvedModelId = modelId!.trim();
      } else {
        // Resolve from agent's runtimeConfig.model. `agent` is non-null here: the
        // guard above only tolerates a missing agent when a client model pair exists.
        const resolved = resolvePermanentAgentEffectiveModel(agent!, settings);
        resolvedProvider = resolved.provider ?? null;
        resolvedModelId = resolved.modelId ?? null;
        inheritedThinkingLevel = resolvePermanentAgentEffectiveThinkingLevel(agent!, settings);
      }
      // Agent-less model sessions inherit nothing — there is no role to inherit from.
      inheritedThinkingLevel ??= agent
        ? resolvePermanentAgentEffectiveThinkingLevel(agent, settings)
        : undefined;

      // Create the chat session with projectId for multi-project scoping
      const session = await chatStore.createSession({
        agentId: agentId.trim(),
        title: title?.trim() || null,
        projectId: projectId ?? null,
        modelProvider: resolvedProvider,
        modelId: resolvedModelId,
        ...((thinkingLevel ?? inheritedThinkingLevel) ? { thinkingLevel: thinkingLevel ?? inheritedThinkingLevel } : {}),
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
      const { chatStore } = await resolveScopedChatStore(req);

      const sessionId = String(req.params.id);
      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const enriched: EnrichedChatSession = session;
      const chatManager = await resolveScopedChatManager(req).catch(() => options?.chatManager);
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
   * Update a chat session (title, status, thinkingLevel, model, agent target,
   * or per-conversation memory focus).
   * Body: { title?: string, status?: "active" | "archived", thinkingLevel?: string | null,
   *         modelProvider?: string | null, modelId?: string | null, agentId?: string, pinned?: boolean,
   *         memoryFocus?: string | null }
   *
   * FNXC:ChatMemoryFocus 2026-08-13:
   * RUFU-068: `memoryFocus` delegates to ChatStore.setSessionMemoryFocus, which
   * trims the topic and normalizes empty/null to null (whole-project scope). An
   * omitted key leaves the stored value untouched (matching the status/title
   * pattern); an explicit empty string is an intentional clear back to
   * whole-project scope. The active topic persists in chat_sessions.memory_focus
   * so it survives reconnect and scopes recall to it as a WITHIN-project read filter.
   *
   * FNXC:ChatPinned 2026-07-16-12:00:
   * `pinned` delegates to ChatStore's advisory-lock-protected max-three check.
   * Null project sessions use its default scope safely, and archiving clears
   * pinnedAt in the same store update so archived sessions cannot retain pins.
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
      const { chatStore } = await resolveScopedChatStore(req);

      const sessionId = String(req.params.id);
      const {
        title,
        status,
        thinkingLevel: rawThinkingLevel,
        modelProvider: rawModelProvider,
        modelId: rawModelId,
        agentId: rawAgentId,
        pinned: rawPinned,
        tagIds: rawTagIds,
        memoryFocus: rawMemoryFocus,
      } = req.body as {
        title?: string;
        status?: string;
        thinkingLevel?: string | null;
        modelProvider?: string | null;
        modelId?: string | null;
        agentId?: string;
        pinned?: boolean;
        tagIds?: unknown;
        memoryFocus?: string | null;
      };

      // Validate status if provided
      if (status !== undefined && status !== "active" && status !== "archived") {
        throw badRequest("status must be 'active' or 'archived'");
      }

      if (rawTagIds !== undefined && (!Array.isArray(rawTagIds) || rawTagIds.some((id) => typeof id !== "string" || !id.trim()))) {
        throw badRequest("tagIds must be an array of tag IDs");
      }

      if (rawPinned !== undefined && typeof rawPinned !== "boolean") {
        throw badRequest("pinned must be a boolean");
      }

      // FNXC:ChatMemoryFocus — memoryFocus must be a string when present; null
      // is an explicit clear (whole-project scope). setSessionMemoryFocus trims
      // and normalizes empty->null, so we only type-check here.
      if (rawMemoryFocus !== undefined && rawMemoryFocus !== null && typeof rawMemoryFocus !== "string") {
        throw badRequest("memoryFocus must be a string");
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

      let session = await chatStore.updateSession(sessionId, {
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(status !== undefined && { status }),
        ...(normalizedThinkingLevel !== undefined && { thinkingLevel: normalizedThinkingLevel }),
        ...(modelPairProvided && { modelProvider: normalizedModelProvider ?? null, modelId: normalizedModelId ?? null }),
        ...(normalizedAgentId !== undefined && { agentId: normalizedAgentId }),
      });

      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }
      if (rawTagIds !== undefined) {
        try {
          session = await chatStore.replaceSessionTags(sessionId, session.projectId ?? null, rawTagIds.map((id) => id.trim()));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unable to update conversation tags";
          throw badRequest(message);
        }
        if (!session) throw notFound(`Chat session ${sessionId} not found`);
      }

      if (rawPinned !== undefined) {
        try {
          session = await chatStore.setSessionPinned(sessionId, rawPinned);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unable to update conversation pin";
          if (message.includes("pin") || message.includes("Archived")) throw badRequest(message);
          throw err;
        }
        if (!session) throw notFound(`Chat session ${sessionId} not found`);
      }

      // FNXC:ChatMemoryFocus — persist the per-conversation memory focus topic.
      // Only when the key is present in the body (omitted keys stay untouched);
      // null/empty clear to whole-project scope via setSessionMemoryFocus.
      if (rawMemoryFocus !== undefined) {
        try {
          session = await chatStore.setSessionMemoryFocus(sessionId, rawMemoryFocus);
        } catch (err) {
          rethrowAsApiError(err, "Failed to update conversation memory focus");
        }
        if (!session) throw notFound(`Chat session ${sessionId} not found`);
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
   *
   * FNXC:RUFU121DeleteSync 2026-08-18-20:50:
   * RUFU-121 Step 5: AFTER the local delete reports success, fire-and-forget a best-effort
   * Stash session delete sync (GET /sessions?limit=200 → match session_id → DELETE row).
   * NOT awaited — the response emits exactly as today, and the sync must never throw into
   * the route (deleteStashChatSession is itself never-throwing; the wrapper also catches).
   * Silently skipped (no Stash call, no error) when memory is disabled, the backend is not
   * `stash`, or the stash API key is unresolvable. Known limitations (accepted per
   * the best-effort contract): an in-flight capture flush can recreate the Stash session
   * after a delete sync (watermark not yet flushed), and the GET /sessions lookup is a
   * global recent window (max 200) — very old sessions may not be found.
   *
   * FNXC:RUFU121DeleteSyncUrl 2026-08-18-21:59:
   * RUFU-121 (code-review remediation): the stashUrl resolves exactly the way the
   * engine capture path does (resolveMemoryBackend): an unset/blank stashUrl falls
   * back to DEFAULT_STASH_URL, so "unresolvable" can never mean "unset" — an unset
   * URL is resolvable by design (the built-in default is what capture already
   * targets in the operator's default configuration). The first implementation
   * gated on `!stashUrl`, which made the sync a silent no-op in that default
   * configuration (no explicit stashUrl setting), so deleted chats kept leaking
   * into Stash — the exact symptom this step exists to remove. The API key still
   * gates: an empty key (missing/undecryptable secret) means the request would
   * 401 anyway, so the spec's missing-key → no-call contract is preserved.
   */
  router.delete("/chat/sessions/:id", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const { store, chatStore } = await resolveScopedChatStore(req);
      const sessionId = String(req.params.id);

      const deleted = await chatStore.deleteSession(sessionId);
      if (!deleted) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      /*
      FNXC:RUFU121DeleteSync 2026-08-18-20:50:
      RUFU-121 Step 5: fire-and-forget — the void IIFE never blocks the response and never
      rejects (every path is try/caught; the helper degrades to not-found/skipped instead of
      throwing). The session id is passed VERBATIM from req.params.id (it is literally
      chat-<8hex> — no string surgery). The store satisfies the StashSecretsReader duck type
      (getSecretsStore) so the engine's resolveStashMemorySettings works unchanged here.

      FNXC:RUFU121DeleteSyncUrl 2026-08-18-21:59:
      URL fallback mirrors resolveMemoryBackend byte-for-byte (trim + DEFAULT_STASH_URL)
      so the sync targets the same server capture targets. Only an empty API key skips.
      */
      void (async () => {
        try {
          const settings = await store.getSettings();
          const resolved = await resolveStashMemorySettings(store, settings);
          if (!resolved || resolved.memoryEnabled === false) return;
          if (resolved.memoryBackendType !== "stash") return;
          const rawStashUrl = resolved.stashUrl;
          const stashUrl =
            typeof rawStashUrl === "string" && rawStashUrl.trim().length > 0
              ? rawStashUrl.trim()
              : DEFAULT_STASH_URL;
          const stashApiKey = resolved.stashApiKey;
          if (!stashApiKey) return;
          const result = await deleteStashChatSession(stashUrl, stashApiKey, sessionId);
          if (result.status !== "ok") {
            chatDeleteSyncLog.debug(`Stash chat-session delete sync skipped/not-found for ${sessionId}: ${result.status}`);
          }
        } catch (err: unknown) {
          chatDeleteSyncLog.warn(
            `Stash chat-session delete sync failed for ${sessionId} (best-effort, non-blocking): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();

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
  /*
  FNXC:ChatStashBackfill 2026-08-19-16:28:
  (operator request 2026-08-19) Backfill a chat's full message history into Stash as a
  first-class action — "nahrat starsie chaty do stashu" — surfaced in the chat session
  context menu only when the project's memory backend is Stash. Reuses the live-capture
  write path (captureMemory) so backfilled transcripts land in the same per-project
  session folder, dedupe identically (Stash content_hash), and stay searchable/recallable
  exactly like live-captured events. Event timestamps use each message's REAL created_at
  (not the capture time) — old transcripts must keep their original chronology for
  after/before filtering and Stash title generation. The chatMessageToMemoryCaptureEvent
  mapping is inlined (not reused) precisely because the live helper stamps now() — a
  backfill that re-stamped every old message with the upload time would destroy the
  transcript's chronology.
  Contract: 200 {ok,inserted,deduped,uploaded} on success; 404 unknown session; 400 for
  memory-disabled / non-stash backend / unconfigured key / empty chat; 502 when the Stash
  upload itself fails — captureMemory never throws, it degrades to ok:false, and the
  route must surface that as a visible failure, never a success.
  */
  router.post("/chat/sessions/:id/backfill-stash", rateLimit(RATE_LIMITS.mutation), async (req, res) => {
    try {
      const { store, chatStore } = await resolveScopedChatStore(req.query.projectId as string | undefined);
      const sessionId = String(req.params.id);

      const session = await chatStore.getSession(sessionId);
      if (!session) {
        throw notFound(`Chat session ${sessionId} not found`);
      }

      const settings = await store.getSettings();
      const resolved = await resolveStashMemorySettings(store, settings);
      if (!resolved || resolved.memoryEnabled === false) {
        throw badRequest("Memory is disabled for this project — enable it in Settings → Memory");
      }
      if (resolved.memoryBackendType !== "stash") {
        throw badRequest("The Stash memory backend is not enabled for this project");
      }
      if (!resolved.stashApiKey) {
        throw badRequest("Stash API key is not configured — add the global stash-api-key secret");
      }

      // Full history in ascending order, paginated to the tail (the store caps page
      // sizes; the loop safety cap of 50k messages is far beyond any real chat).
      const messages: ChatMessage[] = [];
      const PAGE_SIZE = 500;
      for (let offset = 0; offset < 100 * PAGE_SIZE; offset += PAGE_SIZE) {
        const page = await chatStore.getMessages(sessionId, { limit: PAGE_SIZE, offset, order: "asc" });
        messages.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      if (messages.length === 0) {
        throw badRequest("Chat has no messages to upload");
      }

      const rootDir = store.getRootDir();
      // store.getProjectId() is string | null — the ternary below narrows to string
      // for captureMemory's meta.projectId; a null guard keeps the type honest.
      const projectId = store.getProjectId();
      const events = messages.map((message) => {
        const metadata = message.metadata ?? {};
        const agentName = typeof metadata.agent_name === "string"
          ? metadata.agent_name
          : typeof metadata.agentName === "string"
            ? metadata.agentName
            : "fusion";
        const base: Record<string, unknown> = {
          event_type: message.role === "user" ? "user_message" : message.role === "assistant" ? "assistant_message" : "tool_use",
          agent_name: agentName,
          timestamp: message.createdAt || new Date().toISOString(),
          content: message.content ?? "",
        };
        const toolName = typeof metadata.tool_name === "string"
          ? metadata.tool_name
          : typeof metadata.toolName === "string"
            ? metadata.toolName
            : undefined;
        if (message.role === "system" && toolName) base.tool_name = toolName;
        return base as unknown as MemoryCaptureEvent;
      });

      const result = await captureMemory(rootDir, resolved, sessionId, events, {
        projectRoot: rootDir,
        ...(projectId ? { projectId } : {}),
        ...(session.title ? { chatTitle: session.title } : {}),
      });

      if (!result.ok) {
        res.status(502).json({
          ok: false,
          inserted: 0,
          deduped: 0,
          uploaded: messages.length,
          error: "Stash upload failed — is the Stash server reachable?",
        });
        return;
      }
      res.json({ ok: true, inserted: result.inserted, deduped: result.deduped, uploaded: messages.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to backfill chat to Stash");
    }
  });

  router.get("/chat/sessions/:id/messages", async (req, res) => {
    try {
      const { chatStore } = await resolveScopedChatStore(req);

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
      const { chatStore } = await resolveScopedChatStore(req);

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
      const { chatStore } = await resolveScopedChatStore(req);
      const chatManager = await resolveScopedChatManager(req);

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
    let preparedGenerationId: number | undefined;
    let chatManager: Awaited<ReturnType<typeof resolveScopedChatManager>> | undefined;
    const sessionId = String(req.params.id);
    try {
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const { chatStore } = await resolveProjectChatContext({
        projectId,
        defaultStore: store,
        defaultChatStore: options?.chatStore,
        engineManager: options?.engineManager,
        requestStore: scopedStore,
      });

      const body = (req.body ?? {}) as {
        content?: string;
        modelProvider?: string;
        modelId?: string;
        attachments?: ChatAttachment[];
        taskId?: string;
        replacementMessageId?: string;
      };
      const { content, modelProvider, modelId, attachments, taskId, replacementMessageId: rawReplacementMessageId } = body;
      const uploadedFiles = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const referencedAttachments = Array.isArray(attachments) ? attachments : undefined;
      const hasAttachments = uploadedFiles.length > 0 || (referencedAttachments?.length ?? 0) > 0;
      if (content !== undefined && typeof content !== "string") {
        throw badRequest("content is required and must be a non-empty string");
      }
      const trimmedContent = content?.trim() ?? "";
      if (rawReplacementMessageId !== undefined && typeof rawReplacementMessageId !== "string") {
        throw badRequest("replacementMessageId must be a string");
      }
      const replacementMessageId = rawReplacementMessageId?.trim() ?? "";
      if (replacementMessageId && !trimmedContent) {
        throw badRequest("Replacement content must be a non-empty string");
      }
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

      // Validate all rejection-prone request fields before opening SSE. A replacement
      // must not discard history until the request can reach its matching generation.
      const normalizedProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const normalizedModelId = validateOptionalModelField(modelId, "modelId");
      if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
        throw badRequest("modelProvider and modelId must both be provided or neither");
      }

      const uploadedAttachments = uploadedFiles.length > 0
        ? await Promise.all(uploadedFiles.map((file) => persistChatAttachment(file, scopedStore.getRootDir(), sessionId)))
        : undefined;
      const messageAttachments = uploadedAttachments && uploadedAttachments.length > 0
        ? uploadedAttachments
        : referencedAttachments;

      // Resolve per-project ChatManager before opening the SSE stream so
      // failures (e.g. project DB cannot be opened) produce a proper HTTP error.
      const engine = projectId ? options?.engineManager?.getEngine(projectId) : undefined;
      const projectPluginRunner = engine?.getPluginRunner?.();
      chatManager = getOrCreateScopedChatManager(
        scopedStore,
        chatStore,
        projectPluginRunner ?? options?.pluginRunner,
        Boolean(projectPluginRunner),
        engine?.getMessageStore(),
      );

      // The internal limiter is shared with GET stream subscribers. Keep its rejection
      // before headers so a replacement cannot be accepted without a prepared send.
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const { chatStreamManager, checkRateLimit: checkChatRateLimit, getRateLimitResetTime: getChatRateLimitResetTime } = await import("../chat.js");
      if (!checkChatRateLimit(ip)) {
        const resetTime = getChatRateLimitResetTime(ip);
        throw new ApiError(429, `Rate limit exceeded. Reset at ${resetTime?.toISOString() || "unknown"}`);
      }

      if (replacementMessageId) {
        preparedGenerationId = (await chatManager!.prepareReplacement(sessionId, replacementMessageId)).generationId;
      }

      // Set SSE headers only after replacement validation/rewind and generation fencing.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send initial connection confirmation
      res.write(": connected\n\n");

      // Replay is retained for ordinary reconnectable sends. A replacement starts a
      // new fenced transcript and must not replay terminal events from its discarded
      // generation into the new SSE response.
      const lastEventId = replacementMessageId ? undefined : parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = chatStreamManager.getBufferedEvents(sessionId, lastEventId);
        for (const bufferedEvent of buffered) {
          if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
            res.end();
            return;
          }
        }
      }

      // Replacement preparation allocates its generation before headers. Ordinary
      // sends retain the existing allocation path.
      const generationId = preparedGenerationId ?? chatManager!.beginGeneration(sessionId).generationId;

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

      // Fire and forget - streaming happens via callbacks. The matching generation
      // consumes the replacement reservation and cannot be preempted by an ordinary send.
      chatManager!.sendMessage(
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
      if (preparedGenerationId !== undefined) {
        chatManager?.releasePreparedReplacement(sessionId, preparedGenerationId);
      }
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof ChatReplacementError) {
        if (err.statusCode === 404) throw notFound(err.message);
        throw new ApiError(err.statusCode, err.message);
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
      const chatManager = await resolveScopedChatManager(req);
      const sessionId = String(req.params.id);
      // FNXC:ChatCancellation 2026-08-21-01:36:
      // Await the server-authoritative barrier: active generations finish durable prefix/checkpoint
      // ordering, while idle /new and /clear receive a successful no-op without recovery work.
      const result = await chatManager.cancelGeneration(sessionId);
      res.json(result);
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
      const { chatStore } = await resolveScopedChatStore(req);

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
    ];
    chatLogger.info("routes registered", { chatRoutes });
  }

}
