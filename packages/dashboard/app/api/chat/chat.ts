/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Chat sessions / rooms / streaming client API peeled from legacy.ts.
 */
import type {
  ChatAttachment,
  ChatMessage,
  ChatRoom,
  ChatRoomMember,
  ChatRoomMessage,
  EnrichedChatSession,
} from "@fusion/core";
import { api, buildApiUrl } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { withTokenHeader } from "../../auth";
import type { StreamConnectionState } from "../client/event-source.js";

// ── Chat API ─────────────────────────────────────────────────────────────────

// EnrichedChatSession is imported from @fusion/core above

export interface ChatSessionListResponse {
  sessions: EnrichedChatSession[];
}

export interface ChatSessionResponse {
  session: EnrichedChatSession;
}

export interface ChatMessageListResponse {
  messages: ChatMessage[];
}

export interface TaskPlannerChatSessionInput {
  modelProvider?: string;
  modelId?: string;
}

export interface ChatRoomListResponse {
  rooms: ChatRoom[];
}

export interface ChatRoomResponse {
  room: ChatRoom;
  members?: ChatRoomMember[];
}

export interface ChatRoomMembersResponse {
  members: ChatRoomMember[];
}

export interface ChatRoomMessageListResponse {
  messages: ChatRoomMessage[];
}

export interface ChatRoomMessageResponse {
  message: ChatRoomMessage;
}

/**
 * FNXC:ChatSearch 2026-07-07-00:00:
 * `q`/`titleOnly` mirror the server's GET /chat/sessions content-search params (see
 * register-chat-routes.ts). `q` triggers server-side message-content search; `titleOnly=true`
 * (or omitting `q`) preserves the pre-existing client-side title/agent-only filtering.
 */
export interface FetchChatSessionsOptions {
  status?: string;
  q?: string;
  titleOnly?: boolean;
}

/** Fetch all chat sessions for a project */
export function fetchChatSessions(
  projectId?: string,
  status?: string,
  options?: FetchChatSessionsOptions,
): Promise<ChatSessionListResponse> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  const resolvedStatus = options?.status ?? status;
  if (resolvedStatus) search.set("status", resolvedStatus);
  if (options?.q && options.q.trim()) search.set("q", options.q.trim());
  if (options?.titleOnly) search.set("titleOnly", "true");
  const qs = search.toString();
  return api<ChatSessionListResponse>(`/chat/sessions${qs ? `?${qs}` : ""}`);
}

export interface ChatSessionResumeLookupInput {
  agentId: string;
  modelProvider?: string;
  modelId?: string;
}

/**
 * Fetch the most relevant active session for chat resume semantics.
 * Returns at most one session for the provided target.
 */
export async function fetchResumeChatSession(
  input: ChatSessionResumeLookupInput,
  projectId?: string,
): Promise<{ session: EnrichedChatSession | null }> {
  const normalizedAgentId = input.agentId.trim();
  if (!normalizedAgentId) {
    throw new Error("agentId is required");
  }

  const normalizedProvider = input.modelProvider?.trim();
  const normalizedModelId = input.modelId?.trim();

  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error("Both modelProvider and modelId must be provided together, or neither should be provided");
  }

  const search = new URLSearchParams();
  search.set("lookup", "resume");
  search.set("agentId", normalizedAgentId);
  if (projectId) search.set("projectId", projectId);
  if (normalizedProvider && normalizedModelId) {
    search.set("modelProvider", normalizedProvider);
    search.set("modelId", normalizedModelId);
  }

  const data = await api<ChatSessionListResponse>(`/chat/sessions?${search.toString()}`);
  return { session: data.sessions[0] ?? null };
}

/** Create a new chat session */
export function createChatSession(
  input: { agentId: string; title?: string; modelProvider?: string; modelId?: string; thinkingLevel?: string },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId("/chat/sessions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single chat session */
export function fetchChatSession(id: string, projectId?: string): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId));
}

function normalizeTaskPlannerChatInput(taskId: string, input: TaskPlannerChatSessionInput = {}) {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required");
  }
  const normalizedProvider = input.modelProvider?.trim();
  const normalizedModelId = input.modelId?.trim();
  if ((normalizedProvider && !normalizedModelId) || (!normalizedProvider && normalizedModelId)) {
    throw new Error("Both modelProvider and modelId must be provided together, or neither should be provided");
  }
  return { normalizedTaskId, normalizedProvider, normalizedModelId };
}

export function fetchTaskPlannerChatSession(
  taskId: string,
  input: TaskPlannerChatSessionInput = {},
  projectId?: string,
): Promise<{ session: EnrichedChatSession | null }> {
  const { normalizedTaskId, normalizedProvider, normalizedModelId } = normalizeTaskPlannerChatInput(taskId, input);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-18:20:
  Task-detail planner chats are task-local but no longer pre-created by opening the Chat tab. Use lookup-only resume here so global Chat history only receives planner sessions after an explicit user message creates one.
  */
  return fetchResumeChatSession({
    agentId: `task-planner:${normalizedTaskId}`,
    ...(normalizedProvider && normalizedModelId ? { modelProvider: normalizedProvider, modelId: normalizedModelId } : {}),
  }, projectId);
}

export function ensureTaskPlannerChatSession(
  taskId: string,
  input: TaskPlannerChatSessionInput = {},
  projectId?: string,
): Promise<ChatSessionResponse> {
  const { normalizedTaskId, normalizedProvider, normalizedModelId } = normalizeTaskPlannerChatInput(taskId, input);

  /*
  FNXC:TaskDetailPlannerChat 2026-06-30-22:30:
  Task planner chat uses a task-scoped session seam instead of the generic agent-chat creator so it can bind the conversation to the task and planning model without requiring a real executor/reviewer agent or turning the message into steering.

  FNXC:TaskDetailPlannerChat 2026-06-30-18:20:
  This mutating helper is reserved for explicit user sends (composer, starter prompts, and planner-question answers). Tab activation must call fetchTaskPlannerChatSession instead so empty task-detail visits do not create chat history.
  */
  return api<ChatSessionResponse>(
    withProjectId(`/chat/task-planner/${encodeURIComponent(normalizedTaskId)}/session`, projectId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(normalizedProvider && normalizedModelId ? { modelProvider: normalizedProvider, modelId: normalizedModelId } : {}),
      }),
    },
  );
}

/** Update a chat session (title, status, thinkingLevel, model, or agent target) */
export function updateChatSession(
  id: string,
  updates: {
    title?: string | null;
    status?: string;
    modelProvider?: string | null;
    modelId?: string | null;
    agentId?: string;
    thinkingLevel?: string | null;
    pinned?: boolean;
  },
  projectId?: string,
): Promise<ChatSessionResponse> {
  return api<ChatSessionResponse>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a chat session */
export function deleteChatSession(id: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/chat/sessions/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch messages for a chat session */
export function fetchChatMessages(
  sessionId: string,
  opts?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
  projectId?: string,
): Promise<ChatMessageListResponse> {
  const search = new URLSearchParams();
  if (opts?.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) search.set("offset", String(opts.offset));
  if (opts?.before) search.set("before", opts.before);
  if (opts?.order) search.set("order", opts.order);
  const qs = search.toString();
  return api<ChatMessageListResponse>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`, projectId),
  );
}

/** Delete a specific message from a chat session */
export function deleteChatMessage(
  sessionId: string,
  messageId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, projectId),
    {
      method: "DELETE",
    },
  );
}

/**
 * FNXC:ChatMessageEdit 2026-07-07-09:00:
 * Edit an earlier user message in a direct (model-loop) chat session. Truncates the persisted
 * transcript from (and including) the target message onward AND rewinds the pi session context
 * server-side, so the returned `retained` list is the surviving pre-edit history. Does NOT
 * trigger regeneration — the caller resends the edited content via the existing streaming send.
 */
export function editChatMessage(
  sessionId: string,
  messageId: string,
  content: string,
  projectId?: string,
): Promise<{ retained: ChatMessage[] }> {
  return api<{ retained: ChatMessage[] }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ content }),
    },
  );
}

export function fetchChatRooms(
  options: { status?: string; agentId?: string } = {},
  projectId?: string,
): Promise<ChatRoomListResponse> {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  if (options.status) search.set("status", options.status);
  if (options.agentId) search.set("agentId", options.agentId);
  const qs = search.toString();
  return api<ChatRoomListResponse>(`/chat/rooms${qs ? `?${qs}` : ""}`);
}

export function fetchChatRoom(id: string, projectId?: string): Promise<ChatRoomResponse> {
  return api<ChatRoomResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId));
}

export function createChatRoom(
  input: { name: string; description?: string | null; createdBy?: string | null; memberAgentIds?: string[]; thinkingLevel?: string | null },
  projectId?: string,
): Promise<ChatRoomResponse> {
  const body = { ...input, ...(projectId ? { projectId } : {}) };
  return api<ChatRoomResponse>(withProjectId("/chat/rooms", projectId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateChatRoom(
  id: string,
  updates: { name?: string; description?: string | null; status?: "active" | "archived"; thinkingLevel?: string | null },
  projectId?: string,
): Promise<{ room: ChatRoom }> {
  return api<{ room: ChatRoom }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function deleteChatRoom(id: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

export function fetchChatRoomMembers(id: string, projectId?: string): Promise<ChatRoomMembersResponse> {
  return api<ChatRoomMembersResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members`, projectId));
}

export function addChatRoomMember(
  id: string,
  input: { agentId: string; role?: "owner" | "member" },
  projectId?: string,
): Promise<{ member: ChatRoomMember }> {
  return api<{ member: ChatRoomMember }>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeChatRoomMember(id: string, agentId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(agentId)}`, projectId),
    { method: "DELETE" },
  );
}

export function fetchChatRoomMessages(
  id: string,
  opts?: { limit?: number; offset?: number; before?: string; order?: "asc" | "desc" },
  projectId?: string,
): Promise<ChatRoomMessageListResponse> {
  const search = new URLSearchParams();
  if (opts?.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) search.set("offset", String(opts.offset));
  if (opts?.before) search.set("before", opts.before);
  if (opts?.order) search.set("order", opts.order);
  const qs = search.toString();
  return api<ChatRoomMessageListResponse>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ""}`, projectId),
  );
}

export async function uploadChatRoomAttachment(
  roomId: string,
  file: File,
  projectId?: string,
): Promise<{ attachment: ChatAttachment }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/chat/rooms/${encodeURIComponent(roomId)}/attachments`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || "Upload failed");
  return data as { attachment: ChatAttachment };
}

export function attachmentBaseUrlForRoom(roomId: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/chat/rooms/${encodeURIComponent(roomId)}/attachments/`, projectId));
}

export function postChatRoomMessage(
  id: string,
  input: { content: string; senderAgentId?: null; mentions?: string[]; attachments?: ChatAttachment[] },
  projectId?: string,
): Promise<ChatRoomMessageResponse> {
  return api<ChatRoomMessageResponse>(withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteChatRoomMessage(
  id: string,
  messageId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, projectId),
    { method: "DELETE" },
  );
}

export function clearChatRoomMessages(
  id: string,
  projectId?: string,
): Promise<{ success: boolean; deletedCount: number }> {
  return api<{ success: boolean; deletedCount: number }>(
    withProjectId(`/chat/rooms/${encodeURIComponent(id)}/messages`, projectId),
    { method: "DELETE" },
  );
}

/**
 * Room POST /messages in FN-3808 is persist-only (201 JSON response).
 * Do not add streamChatRoomResponse until FN-3810 introduces AI invocation/streaming.
 */

/** Cancel an in-flight chat generation. */
export function cancelChatResponse(
  sessionId: string,
  projectId?: string,
): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(
    withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, projectId),
    {
      method: "POST",
    },
  );
}

/** Send a chat message and receive the AI response via SSE streaming.
 *
 *  The backend exposes `POST /api/chat/sessions/:id/messages` which returns an SSE
 *  stream (not JSON). Events: `thinking`, `text`, `fallback`, `done`, `error`.
 *
 *  Since `EventSource` only supports GET requests, this function uses `fetch()`
 *  with a ReadableStream to parse SSE events from the POST response body.
 *  When attachments are provided, the request body is sent as multipart form data;
 *  otherwise it uses the existing JSON payload path.
 */
export interface ChatFailureReference {
  kind: string;
  id: string;
  label?: string;
}

export interface ChatFailureInfo {
  summary: string;
  errorClass?: string;
  code?: string;
  detail?: string;
  reference?: ChatFailureReference;
}

function extractChatFailureInfo(value: unknown): ChatFailureInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const reference = (() => {
    const rawReference = record.reference;
    if (!rawReference || typeof rawReference !== "object") {
      return undefined;
    }
    const referenceRecord = rawReference as Record<string, unknown>;
    const kind = typeof referenceRecord.kind === "string" ? referenceRecord.kind.trim() : "";
    const id = typeof referenceRecord.id === "string" ? referenceRecord.id.trim() : "";
    if (!kind || !id) {
      return undefined;
    }
    return {
      kind,
      id,
      ...(typeof referenceRecord.label === "string" && referenceRecord.label.trim()
        ? { label: referenceRecord.label.trim() }
        : {}),
    } satisfies ChatFailureReference;
  })();

  return {
    summary,
    ...(typeof record.errorClass === "string" && record.errorClass.trim()
      ? { errorClass: record.errorClass.trim() }
      : {}),
    ...(typeof record.code === "string" && record.code.trim()
      ? { code: record.code.trim() }
      : {}),
    ...(typeof record.detail === "string" && record.detail.trim()
      ? { detail: record.detail.trim() }
      : {}),
    ...(reference ? { reference } : {}),
  };
}

function parseChatErrorPayload(rawData: string): string | ChatFailureInfo {
  try {
    const parsed = JSON.parse(rawData);
    const structured = extractChatFailureInfo(parsed);
    if (structured) {
      return structured;
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message;
    }
    return typeof parsed === "string" ? parsed : rawData || "Stream error";
  } catch {
    return rawData || "Stream error";
  }
}

export interface ChatStreamErrorMeta {
  /** True once the POST stream was accepted and the server started an SSE response. */
  requestAccepted: boolean;
  /** True when the error came from an SSE event rather than the initial HTTP response. */
  receivedStreamEvent: boolean;
}

export interface ChatStreamHandlers {
  onThinking?: (data: string) => void;
  onText?: (data: string) => void;
  onToolStart?: (data: { toolName: string; args?: Record<string, unknown> }) => void;
  onToolEnd?: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
  onFallback?: (data: { primaryModel: string; fallbackModel: string; triggerPoint: "session-creation" | "prompt-time" }) => void;
  onDone?: (data: { messageId: string; message?: ChatMessage }) => void;
  onError?: (data: string | ChatFailureInfo, meta?: ChatStreamErrorMeta) => void;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
}

export function streamChatResponse(
  sessionId: string,
  content: string,
  handlers: ChatStreamHandlers,
  attachments?: File[],
  projectId?: string,
  options?: { maxReconnectAttempts?: number; firstEventTimeoutMs?: number; taskId?: string },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, projectId));

  const abortController = new AbortController();
  let closedByUser = false;
  let terminated = false;
  let requestAccepted = false;
  let receivedStreamEvent = false;
  const firstEventTimeoutMs = Math.max(1_000, options?.firstEventTimeoutMs ?? 60_000);
  let firstEventTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFirstEventTimer = (): void => {
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
  };

  const markFirstEventReceived = (): void => {
    if (receivedStreamEvent) {
      return;
    }
    receivedStreamEvent = true;
    clearFirstEventTimer();
  };

  const dispatchEvent = (eventName: string, rawData: string): void => {
    if (!eventName) {
      return;
    }

    markFirstEventReceived();

    switch (eventName) {
      case "thinking":
        try {
          handlers.onThinking?.(JSON.parse(rawData));
        } catch {
          handlers.onThinking?.(rawData);
        }
        break;
      case "text":
        try {
          handlers.onText?.(JSON.parse(rawData));
        } catch {
          handlers.onText?.(rawData);
        }
        break;
      case "tool_start":
        try {
          handlers.onToolStart?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "tool_end":
        try {
          handlers.onToolEnd?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "fallback":
        try {
          handlers.onFallback?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "done":
        terminated = true;
        try {
          const parsed = JSON.parse(rawData) as { messageId?: unknown; message?: unknown };
          handlers.onDone?.({
            messageId: typeof parsed.messageId === "string" ? parsed.messageId : "",
            ...(parsed.message && typeof parsed.message === "object" ? { message: parsed.message as ChatMessage } : {}),
          });
        } catch {
          handlers.onDone?.({ messageId: "" });
        }
        break;
      case "error":
        terminated = true;
        handlers.onError?.(parseChatErrorPayload(rawData), { requestAccepted: true, receivedStreamEvent: true });
        break;
    }
  };

  // Start streaming via POST
  (async () => {
    try {
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      const body = hasAttachments
        ? (() => {
            const formData = new FormData();
            formData.append("content", content);
            if (options?.taskId) formData.append("taskId", options.taskId);
            attachments.forEach((file) => formData.append("attachments", file));
            return formData;
          })()
        : JSON.stringify({ content, ...(options?.taskId ? { taskId: options.taskId } : {}) });

      const res = await fetch(url, {
        method: "POST",
        headers: hasAttachments ? withTokenHeader() : withTokenHeader({ "Content-Type": "application/json" }),
        body,
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMsg = `Request failed: ${res.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* use default */ }
        handlers.onError?.(errorMsg, { requestAccepted: false, receivedStreamEvent: false });
        return;
      }

      if (!res.body) {
        handlers.onError?.("No response body", { requestAccepted: true, receivedStreamEvent: false });
        return;
      }

      requestAccepted = true;
      handlers.onConnectionStateChange?.("connected");
      firstEventTimer = setTimeout(() => {
        if (terminated || closedByUser || receivedStreamEvent) {
          return;
        }
        /*
        FNXC:ChatReliability 2026-07-04-00:00:
        Accepted chat requests can keep generating after the dashboard has not yet seen the first SSE event. Treat this timer as a non-terminal wait marker so the UI stays in-progress and can reconcile late persisted output instead of showing a false Response failed bubble.
        */
        firstEventTimer = null;
      }, firstEventTimeoutMs);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentDataLines: string[] = [];

      // POST-based chat responses still speak SSE, so parser state must persist
      // across ReadableStream chunks. Networks can split `event:` and `data:`
      // lines arbitrarily, and resetting state per-read drops assistant output.
      const processLines = (chunk: string, flushPendingEvent = false): void => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        // At stream end, flush any remaining buffered line so complete trailing
        // events are parsed even when the payload has no final newline.
        if (flushPendingEvent && buffer.length > 0) {
          lines.push(buffer);
          buffer = "";
        }

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const value = line.slice(5);
            // Strip only the optional SSE protocol delimiter-space after `data:`.
            // Payload whitespace (including JSON-string leading spaces) must stay verbatim.
            currentDataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          } else if (line === "") {
            const currentData = currentDataLines.join("\n");
            dispatchEvent(currentEvent, currentData);
            currentEvent = "";
            currentDataLines = [];
          }
        }

        // Flush any pending event/data at stream end.
        // Only dispatch if we have both a valid event type and accumulated data.
        if (flushPendingEvent && currentEvent && currentDataLines.length > 0) {
          const trailingData = currentDataLines.join("\n");
          dispatchEvent(currentEvent, trailingData);
          currentEvent = "";
          currentDataLines = [];
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processLines(decoder.decode(), true);
          break;
        }

        processLines(decoder.decode(value, { stream: true }));
      }

      const hasUndispatchedTrailingFragment =
        buffer.length > 0 || currentEvent.length > 0 || currentDataLines.length > 0;

      // Server closed the stream without emitting a terminal `done` or `error`
      // SSE event (common on flaky mobile networks, proxy idle-kill, or
      // backgrounded tabs). Surface as an error so the client unwinds
      // streaming state instead of getting stuck with isStreaming=true.
      // Ignore dangling partial fragments at EOF: those indicate a truncated
      // trailing event that should be dropped rather than surfaced as transport
      // failure.
      if (!terminated && !closedByUser && !hasUndispatchedTrailingFragment) {
        handlers.onError?.("Connection closed unexpectedly", { requestAccepted, receivedStreamEvent });
      }
      clearFirstEventTimer();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!closedByUser && !terminated) {
          handlers.onError?.("Connection aborted", { requestAccepted, receivedStreamEvent });
        }
        clearFirstEventTimer();
        return;
      }
      if (closedByUser) {
        clearFirstEventTimer();
        return;
      }
      clearFirstEventTimer();
      handlers.onError?.(err instanceof Error ? err.message : "Connection error", { requestAccepted, receivedStreamEvent });
    }
  })();

  return {
    close: () => {
      closedByUser = true;
      clearFirstEventTimer();
      abortController.abort();
    },
    isConnected: () => !closedByUser,
  };
}

export function attachChatStream(
  sessionId: string,
  handlers: ChatStreamHandlers,
  projectId?: string,
  options?: { lastEventId?: number },
): { close: () => void; isConnected: () => boolean } {
  const url = buildApiUrl(withProjectId(`/chat/sessions/${encodeURIComponent(sessionId)}/stream`, projectId));
  const abortController = new AbortController();
  let closedByUser = false;
  let terminated = false;

  const dispatchEvent = (eventName: string, rawData: string): void => {
    if (!eventName) {
      return;
    }

    switch (eventName) {
      case "thinking":
        try {
          handlers.onThinking?.(JSON.parse(rawData));
        } catch {
          handlers.onThinking?.(rawData);
        }
        break;
      case "text":
        try {
          handlers.onText?.(JSON.parse(rawData));
        } catch {
          handlers.onText?.(rawData);
        }
        break;
      case "tool_start":
        try {
          handlers.onToolStart?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "tool_end":
        try {
          handlers.onToolEnd?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "fallback":
        try {
          handlers.onFallback?.(JSON.parse(rawData));
        } catch {
          // skip malformed event
        }
        break;
      case "done":
        terminated = true;
        try {
          const parsed = JSON.parse(rawData) as { messageId?: unknown; message?: unknown };
          handlers.onDone?.({
            messageId: typeof parsed.messageId === "string" ? parsed.messageId : "",
            ...(parsed.message && typeof parsed.message === "object" ? { message: parsed.message as ChatMessage } : {}),
          });
        } catch {
          handlers.onDone?.({ messageId: "" });
        }
        break;
      case "error":
        terminated = true;
        handlers.onError?.(parseChatErrorPayload(rawData));
        break;
    }
  };

  (async () => {
    try {
      const requestHeaders = new Headers(withTokenHeader() as HeadersInit);
      if (typeof options?.lastEventId === "number") {
        requestHeaders.set("Last-Event-ID", String(options.lastEventId));
      }

      const res = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMsg = `Request failed: ${res.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          errorMsg = parsed.error || errorMsg;
        } catch { /* use default */ }
        handlers.onError?.(errorMsg);
        return;
      }

      if (!res.body) {
        handlers.onError?.("No response body");
        return;
      }

      handlers.onConnectionStateChange?.("connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentDataLines: string[] = [];

      const processLines = (chunk: string, flushPendingEvent = false): void => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        if (flushPendingEvent && buffer.length > 0) {
          lines.push(buffer);
          buffer = "";
        }

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const value = line.slice(5);
            // Strip only the optional SSE protocol delimiter-space after `data:`.
            // Payload whitespace (including JSON-string leading spaces) must stay verbatim.
            currentDataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          } else if (line === "") {
            const currentData = currentDataLines.join("\n");
            dispatchEvent(currentEvent, currentData);
            currentEvent = "";
            currentDataLines = [];
          }
        }

        if (flushPendingEvent && currentEvent && currentDataLines.length > 0) {
          const trailingData = currentDataLines.join("\n");
          dispatchEvent(currentEvent, trailingData);
          currentEvent = "";
          currentDataLines = [];
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          processLines(decoder.decode(), true);
          break;
        }

        processLines(decoder.decode(value, { stream: true }));
      }

      const hasUndispatchedTrailingFragment =
        buffer.length > 0 || currentEvent.length > 0 || currentDataLines.length > 0;

      if (!terminated && !closedByUser && !hasUndispatchedTrailingFragment) {
        return;
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!closedByUser && !terminated) {
          handlers.onError?.("Connection aborted");
        }
        return;
      }
      if (closedByUser) {
        return;
      }
      handlers.onError?.(err instanceof Error ? err.message : "Connection error");
    }
  })();

  return {
    close: () => {
      closedByUser = true;
      abortController.abort();
    },
    isConnected: () => !closedByUser,
  };
}


/*
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Preserve legacy `insights` imports while implementations live in insights.ts.
 */
export {
  archiveInsight,
  deleteInsight,
  dismissInsight,
  fetchInsight,
  fetchInsightRun,
  fetchInsightRuns,
  fetchInsights,
  getInsightCreateTaskData,
  triggerInsightRun,
  unarchiveInsight,
  updateInsight,
} from "../system/insights.js";
export type {
  InsightsListResponse,
  RunsListResponse,
} from "../system/insights.js";

