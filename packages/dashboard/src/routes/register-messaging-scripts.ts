import type { Request } from "express";
import { resolve } from "node:path";
import { ApprovalRequestStore, DASHBOARD_USER_ID, MessageStore, type MessageType, type ParticipantType, validateMessageMetadata } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { getTerminalService } from "../terminal-service.js";
import type { ApiRoutesContext } from "./types.js";

export function registerMessagingScriptRoutes(ctx: ApiRoutesContext): void {
  const { router, options, getProjectContext, rethrowAsApiError, runtimeLogger } = ctx;

  // ── Scripts API ──────────────────────────────────────────────────────────

  /**
   * GET /api/scripts
   * Fetch all saved scripts.
   * Returns: Record<string, string> (name -> command)
   */
  router.get("/scripts", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      res.json(settings.scripts ?? {});
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/scripts
   * Add or update a script.
   * Body: { name: string, command: string }
   * Returns: Record<string, string> (updated scripts)
   */
  router.post("/scripts", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name, command } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required");
      }
      if (command === undefined || typeof command !== "string") {
        throw badRequest("command is required");
      }

      const settings = await scopedStore.getSettings();
      const scripts = {
        ...(settings.scripts ?? {}),
        [name.trim()]: command.trim(),
      };
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/scripts/:name
   * Remove a script.
   * Returns: Record<string, string> (updated scripts)
   */
  router.delete("/scripts/:name", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { name } = req.params;
      const settings = await scopedStore.getSettings();
      const scripts = { ...(settings.scripts ?? {}) };
      delete scripts[name];
      await scopedStore.updateSettings({ scripts });
      res.json(scripts);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/scripts/:name/run
   * Execute a saved script by name using terminal service.
   * Body: { args?: string[] } - Optional arguments to append to the command
   * Returns: { sessionId: string, command: string }
   */
  router.post("/scripts/:name/run", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const scriptName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

      if (!scriptName) {
        throw badRequest("Script name is required");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
        throw badRequest("Script name must contain only alphanumeric characters, hyphens, and underscores (no spaces)");
      }

      const settings = await scopedStore.getSettings();
      const currentScripts = settings.scripts ?? {};

      if (currentScripts[scriptName] === undefined) {
        throw notFound(`Script '${scriptName}' not found`);
      }

      const baseCommand = currentScripts[scriptName];
      const { args } = req.body ?? {};

      if (args !== undefined && !Array.isArray(args)) {
        throw badRequest("args must be an array of strings");
      }
      if (args && !args.every((a: unknown) => typeof a === "string")) {
        throw badRequest("args must be an array of strings");
      }

      let fullCommand = baseCommand;
      if (args && args.length > 0) {
        const escapedArgs = args.map((arg: unknown) => {
          const str = String(arg);
          if (str.includes('"') || str.includes("$") || str.includes("`")) {
            return `'${str.replace(/'/g, "'\\''")}'`;
          }
          return `"${str}"`;
        });
        fullCommand = `${baseCommand} ${escapedArgs.join(" ")}`;
      }

      const terminalService = getTerminalService(scopedStore.getRootDir());
      const result = await terminalService.createSession({
        cwd: scopedStore.getRootDir(),
      });

      if (!result.success) {
        const statusByCode = {
          max_sessions: 503,
          invalid_shell: 400,
          pty_load_failed: 503,
          pty_spawn_failed: 500,
        } as const;
        const status = result.code ? (statusByCode[result.code] ?? 500) : 500;
        throw new ApiError(status, result.error || "Failed to create terminal session");
      }

      const sessionId = result.session.id;
      /*
      FNXC:ScriptRunTerminalReadiness 2026-06-17-17:38:
      Saved-script execution creates a fresh PTY and injects the command programmatically, so wait for the shell's initial output plus the bounded quiet window before writing to avoid dropped or garbled leading bytes.
      */
      await terminalService.waitForReady(sessionId);
      terminalService.writeInput(sessionId, `${fullCommand}\n`);

      res.status(201).json({
        sessionId,
        command: fullCommand,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Messaging Routes ──────────────────────────────────────────────────

  /** Cache of MessageStore instances keyed by rootDir */
  const messageStoreCache = new Map<string, MessageStore>();

  async function getMessageStore(req: Request): Promise<MessageStore> {
    const { store: scopedStore, engine, projectId } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();

    // Prefer the runtime's MessageStore when available so routes and SSE share
    // the same EventEmitter instance (required for live mailbox updates).
    const runtimeMessageStore =
      engine?.getMessageStore() ?? (!projectId ? options?.engine?.getMessageStore() : undefined);
    if (runtimeMessageStore) {
      messageStoreCache.set(rootDir, runtimeMessageStore);
      return runtimeMessageStore;
    }

    let msgStore = messageStoreCache.get(rootDir);
    if (!msgStore) {
      const db = scopedStore.getDatabase();
      msgStore = new MessageStore(db);
      messageStoreCache.set(rootDir, msgStore);
    }
    return msgStore;
  }

  const VALID_MESSAGE_TYPES: MessageType[] = ["agent-to-agent", "agent-to-user", "user-to-agent", "system"];
  const VALID_PARTICIPANT_TYPES: ParticipantType[] = ["agent", "user", "system"];
  type HeartbeatMonitorHandle = NonNullable<NonNullable<ApiRoutesContext["options"]>["heartbeatMonitor"]>;
  const heartbeatMonitor = options?.heartbeatMonitor;

  function isHeartbeatMonitorForProject(scopedStore: import("@fusion/core").TaskStore): boolean {
    if (!heartbeatMonitor?.rootDir) return true;
    try {
      const monitorRoot = resolve(heartbeatMonitor.rootDir);
      const storeRoot = resolve(scopedStore.getRootDir());
      return monitorRoot === storeRoot;
    } catch {
      return true;
    }
  }

  function resolveHeartbeatMonitor(scopedStore: import("@fusion/core").TaskStore): HeartbeatMonitorHandle | undefined {
    const engineManager = options?.engineManager;
    if (!engineManager) return undefined;
    try {
      const storeRoot = resolve(scopedStore.getRootDir());
      for (const engine of engineManager.getAllEngines().values()) {
        if (resolve(engine.getWorkingDirectory()) === storeRoot) {
          return (engine.getHeartbeatMonitor() ?? undefined) as HeartbeatMonitorHandle | undefined;
        }
      }
    } catch {
      // no-op: fallback handled by caller
    }
    return undefined;
  }

  router.get("/messages/inbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        read: req.query.unreadOnly === "true" ? false : undefined,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getInbox(DASHBOARD_USER_ID, "user", filter);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      res.json({ messages, total: messages.length, unreadCount: mailbox.unreadCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/messages/outbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const filter = {
        limit: parseInt(req.query.limit as string) || 20,
        offset: parseInt(req.query.offset as string) || 0,
        type: req.query.type as MessageType | undefined,
      };
      const messages = await msgStore.getOutbox(DASHBOARD_USER_ID, "user", filter);
      res.json({ messages, total: messages.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/messages/unread-count", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const { store: scopedStore } = await getProjectContext(req);
      const mailbox = await msgStore.getMailbox(DASHBOARD_USER_ID, "user");
      let pendingApprovalCount = 0;
      try {
        const approvalStore = new ApprovalRequestStore(scopedStore.getDatabase());
        pendingApprovalCount = approvalStore.list({ status: "pending", limit: Number.MAX_SAFE_INTEGER, offset: 0 }).length;
      } catch {
        pendingApprovalCount = 0;
      }
      res.json({ unreadCount: mailbox.unreadCount, pendingApprovalCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // IMPORTANT: Must be registered before /messages/:id to avoid path conflicts.
  router.post("/messages/read-all", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const count = await msgStore.markAllAsRead(DASHBOARD_USER_ID, "user");
      res.json({ markedAsRead: count });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/messages", async (req, res) => {
    try {
      const { toId, toType, content, type, metadata, wakeImmediately } = req.body;

      if (!toId || typeof toId !== "string") {
        throw badRequest("toId is required");
      }
      if (!toType || !VALID_PARTICIPANT_TYPES.includes(toType)) {
        throw badRequest(`toType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }
      if (!content || typeof content !== "string" || content.length === 0 || content.length > 2000) {
        throw badRequest("content is required and must be 1-2000 characters");
      }
      if (!type || !VALID_MESSAGE_TYPES.includes(type)) {
        throw badRequest(`type must be one of: ${VALID_MESSAGE_TYPES.join(", ")}`);
      }

      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }
      if (wakeImmediately !== undefined && typeof wakeImmediately !== "boolean") {
        throw badRequest("wakeImmediately must be a boolean");
      }

      try {
        validateMessageMetadata(metadata);
      } catch (err: unknown) {
        throw badRequest(err instanceof Error ? err.message : "metadata.replyTo is invalid");
      }

      const msgStore = await getMessageStore(req);
      const message = await msgStore.sendMessage({
        fromId: DASHBOARD_USER_ID,
        fromType: "user",
        toId,
        toType,
        content,
        type,
        metadata,
      });

      const shouldWakeImmediately = toType === "agent" && (wakeImmediately === true || metadata?.wakeRecipient === true);
      const recipientAgentId = toId;

      res.status(201).json(message);

      if (shouldWakeImmediately) {
        void (async () => {
          try {
            const { store: scopedStore, projectId } = await getProjectContext(req);
            const resolvedMonitor =
              isHeartbeatMonitorForProject(scopedStore)
                ? heartbeatMonitor
                : projectId
                  ? resolveHeartbeatMonitor(scopedStore)
                  : undefined;

            if (resolvedMonitor) {
              await resolvedMonitor.executeHeartbeat({
                agentId: recipientAgentId,
                source: "on_demand",
                triggerDetail: "wake-on-message",
              });
            }
          } catch (wakeErr) {
            runtimeLogger.warn(`POST /api/messages wakeImmediately best-effort wake failed: ${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`);
          }
        })();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/messages/conversation/:participantType/:participantId", async (req, res) => {
    try {
      const { participantType, participantId } = req.params;
      if (!VALID_PARTICIPANT_TYPES.includes(participantType as ParticipantType)) {
        throw badRequest(`participantType must be one of: ${VALID_PARTICIPANT_TYPES.join(", ")}`);
      }

      const msgStore = await getMessageStore(req);
      const messages = await msgStore.getConversation(
        { id: DASHBOARD_USER_ID, type: "user" },
        { id: participantId, type: participantType as ParticipantType },
      );
      res.json(messages);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.getMessage(req.params.id);
      if (!message) {
        throw notFound("Message not found");
      }
      res.json(message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/messages/:id/read", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const message = await msgStore.markAsRead(req.params.id);
      res.json(message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  router.delete("/messages/:id", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      await msgStore.deleteMessage(req.params.id);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/agents/mailbox/all", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const messages = await msgStore.getAllAgentToAgentMessages();
      const unreadCount = await msgStore.getUnreadAgentToAgentCount();
      res.json({ messages, total: messages.length, unreadCount });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/agents/:id/mailbox", async (req, res) => {
    try {
      const msgStore = await getMessageStore(req);
      const agentId = req.params.id;
      const mailbox = await msgStore.getMailbox(agentId, "agent");
      const inbox = await msgStore.getInbox(agentId, "agent");
      const outbox = await msgStore.getOutbox(agentId, "agent");
      res.json({ ...mailbox, messages: inbox, inbox, outbox });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });
}
