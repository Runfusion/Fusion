/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * RUFU-068 engine wiring for the Stash memory backend capture:
 *  1. Per-task memory capture (task_completion) restored on the executor's task-complete
 *     seam, mirroring the deterministic post-task reflection capture (FN-7528).
 *  2. Complete-CHAT-session memory capture: a duck-typed chat-store subscription that turns
 *     each live session's message stream into Stash memory events so the Stash
 *     `/sessions/<sessionId>` GUI shows the full conversation transcript rather than a
 *     task-completion shot.
 *
 * All capture is best-effort / fail-closed / non-blocking: a capture or secret-resolution
 * failure must never block or fail a chat or task completion. Captured content is written to
 * the memory backend only — never to run-audit (FN-7158 ids/counts/outcome rule).
 */
import type {
  AgentLogEntry,
  ChatMessage,
  ChatSession,
  MemoryBackendSettings,
  MemoryCaptureEvent,
  MemoryCaptureResult,
  StashSecretsReader,
  Task,
  TaskStore,
} from "@fusion/core";
import { captureMemory, resolveStashMemorySettings } from "@fusion/core";
import { basename } from "node:path";
import { executorLog } from "../logger.js";

/*
FNXC:RUFU121StashSettingsInCore 2026-08-18-19:53:
RUFU-121 Step 3: the Stash settings/secret-resolution contract
(MemoryBackendSettings, StashSecretsReader, STASH_SECRET_KEY,
STASH_SECRET_SCOPE, resolveStashMemorySettings) moved VERBATIM into
@fusion/core (packages/core/src/memory/stash-settings.ts) so the dashboard
chat-delete sync route — which must not import @fusion/engine — can resolve
the SAME settings + secret contract as the engine capture chain. Re-exported
here for the existing engine import sites; no behavior change.
*/
export { STASH_SECRET_KEY, STASH_SECRET_SCOPE, resolveStashMemorySettings } from "@fusion/core";
export type { MemoryBackendSettings, StashSecretsReader } from "@fusion/core";

/*
FNXC:StashSessionCapture 2026-08-19-04:37:
(RUFU-122) Task-terminal transcript builder. On task terminalization (done +
failed/parked) the task's agent log (agent-log.jsonl, read via the public
TaskStore.getAgentLogs) is uploaded as an ordered transcript to the per-task
Stash session fusion-task-<taskId>, in front of the RUFU-068 terminal anchor
event (task_completion/task_failure). Mapping (operator-settled, do not
re-litigate): consecutive `text` streamed deltas are glued into ONE
`assistant_message` event (join with ""; created_at and metadata.line come
from the run's FIRST entry); `tool` -> `tool_use` (content and tool_name are
the tool name); `tool_result` -> `tool_result`; `tool_error` -> `tool_error`
with the content prefixed "ERROR: " so the error marker is visible in stored
events; `thinking` is always skipped; `status` entries are skipped by default
and only surface as `status` events when the caller passes includeStatus=true
(executorSessionCaptureIncludeStatus, schema-only setting). Every event:
content truncated client-side to 4000 chars, created_at = the entry's
ISO timestamp, metadata = { taskId, status, line, project, project_name }
where line is the entry's 1-based position in the returned log array
(getAgentLogs strips lineNo/sourceRef, so the array index IS the log line).
The builder is pure and deterministic — no I/O, no clock, no settings reads.
*/
export const TRANSCRIPT_CONTENT_MAX_CHARS = 4000;

/** Per-event project identity stamped into transcript + anchor metadata. */
export type TaskTranscriptProject = {
  project: string;
  project_name: string;
};

export function buildTaskTranscriptEvents(
  entries: AgentLogEntry[],
  taskId: string,
  status: string,
  project: TaskTranscriptProject,
): MemoryCaptureEvent[] {
  return buildTaskTranscriptEventsWithStatus(entries, taskId, status, project, false);
}

/**
 * Builder implementation with the `status`-entry flag. The public
 * {@link buildTaskTranscriptEvents} is the spec-fixed default (status entries
 * skipped); the trigger calls this directly so inclusion is applied by the
 * caller around the builder per executorSessionCaptureIncludeStatus.
 */
function buildTaskTranscriptEventsWithStatus(
  entries: AgentLogEntry[],
  taskId: string,
  status: string,
  project: TaskTranscriptProject,
  includeStatus: boolean,
): MemoryCaptureEvent[] {
  const metaFor = (line: number): Record<string, unknown> => ({
    taskId,
    status,
    line,
    project: project.project,
    project_name: project.project_name,
  });
  const events: MemoryCaptureEvent[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const line = i + 1;
    if (entry.type === "text") {
      // Glue the run of consecutive text deltas into a single assistant message;
      // the event inherits the run's first entry timestamp/line.
      let j = i;
      let joined = "";
      while (j < entries.length && entries[j].type === "text") {
        joined += entries[j].text ?? "";
        j += 1;
      }
      events.push({
        event_type: "assistant_message",
        content: joined.slice(0, TRANSCRIPT_CONTENT_MAX_CHARS),
        created_at: entry.timestamp,
        metadata: metaFor(line),
      });
      i = j;
    } else if (entry.type === "tool") {
      const toolName = (entry.text ?? "").slice(0, TRANSCRIPT_CONTENT_MAX_CHARS);
      events.push({
        event_type: "tool_use",
        content: toolName,
        tool_name: toolName,
        created_at: entry.timestamp,
        metadata: metaFor(line),
      });
      i += 1;
    } else if (entry.type === "tool_result") {
      events.push({
        event_type: "tool_result",
        content: (entry.text ?? "").slice(0, TRANSCRIPT_CONTENT_MAX_CHARS),
        created_at: entry.timestamp,
        metadata: metaFor(line),
      });
      i += 1;
    } else if (entry.type === "tool_error") {
      events.push({
        event_type: "tool_error",
        content: `ERROR: ${entry.text ?? ""}`.slice(0, TRANSCRIPT_CONTENT_MAX_CHARS),
        created_at: entry.timestamp,
        metadata: metaFor(line),
      });
      i += 1;
    } else if (entry.type === "status" && includeStatus) {
      events.push({
        event_type: "status",
        content: (entry.text ?? "").slice(0, TRANSCRIPT_CONTENT_MAX_CHARS),
        created_at: entry.timestamp,
        metadata: metaFor(line),
      });
      i += 1;
    } else {
      // `thinking` (and any unrecognized type): never uploaded.
      i += 1;
    }
  }
  return events;
}

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * Per-task memory capture (task_completion). Completion-gated: runs at most once per task
 * (`capturedMemoryTaskIds`), only when a genuine task record exists, and is best-effort —
 * failures are logged and never block or fail task completion.
 *
 * FNXC:StashSessionCapture 2026-08-19-04:37:
 * (RUFU-122) The capture now uploads the full agent-log transcript (most recent
 * executorSessionCaptureMaxEvents entries, default 20000, capped with a warn
 * log) IN FRONT OF the terminal anchor event in a single captureMemory call:
 * session fusion-task-<taskId>, content = task.title, metadata =
 * { taskId, status, project, project_name }. The anchor kind is passed by the
 * SEAM, not inferred from task.status: completion seam -> task_completion,
 * terminal-failure seam -> task_failure (see the TaskCaptureAnchorKind note
 * below). The
 * executorSessionCaptureEnabled setting (default true) gates ONLY the
 * transcript — when off, only the anchor is captured. Per-event identity:
 * `project` resolves through the store's duck-typed getWorkflowSettingsProjectId
 * (same pattern as the no-task heartbeat patrol), falling back to "default";
 * `project_name` uses the RUFU-121 runtime identity (deps.projectIdentity)
 * falling back to basename(rootDir) || "project". A missing or pruned
 * agent-log.jsonl degrades to a warn log with an anchor-only capture — never
 * a throw. The captureMemory meta keeps the RUFU-121 folder identity
 * (projectId/projectName forwarded only when explicitly present, so the
 * session folder resolves by external_key exactly as before).
 */
export type TaskMemoryCaptureDeps = {
  store: TaskStore;
  capturedMemoryTaskIds: Set<string>;
  rootDir: string;
  /**
   * FNXC:RUFU121TaskCaptureIdentity 2026-08-18-19:53:
   * RUFU-121 Step 4: optional explicit project identity for task captures.
   * When absent (the default at the signalTaskComplete seam), projectId is
   * derived from the store itself via TaskStore.getProjectId().
   */
  projectIdentity?: RuntimeProjectIdentity;
};

/*
FNXC:StashSessionCapture 2026-08-19-06:24:
(RUFU-122 review fix) The terminal anchor's event type is decided by the
SEAM that fires the capture, never by task.status: the engine never writes
status "done" onto the task row (completion is column-based — the row stays
null/unset until the merge lane), so a status-derived anchor classified every
COMPLETED task as task_failure with status "unknown" metadata, inverting the
RUFU-068 anchor contract and polluting fn_memory_search recall. The completion
seam (signalTaskComplete — the task's work handed off to review) always means
task_completion / status "done"; the terminal-failure seam (runImplementation
post-loop finally, which only fires on a freshly-read status "failed") means
task_failure / the fresh failed status. Callers pass the kind explicitly.
*/
export type TaskCaptureAnchorKind = "completion" | "failure";

export async function triggerTaskMemoryCapture(
  deps: TaskMemoryCaptureDeps,
  task: Task,
  anchorKind: TaskCaptureAnchorKind = "completion",
): Promise<void> {
  const { store, capturedMemoryTaskIds, rootDir } = deps;
  if (!task || !task.id) return;
  // Terminal-state label for transcript + anchor metadata. The kind decides it
  // (see the TaskCaptureAnchorKind FNXC above): completion -> "done" even when
  // the in-scope row still carries a stale non-done status (the post-completion
  // non-continuable seam clears the row but passes the pre-clear object); the
  // failure seam carries the freshly-read "failed" status from the finally.
  const taskStatus = anchorKind === "failure" ? (task.status ?? "failed") : "done";
  const taskTitle = task.title ?? "";

  // Completion-gated synchronously BEFORE any await: two back-to-back completions of the same
  // task must never both attempt capture (the gate must not race across the settings read).
  // RUFU-122: the gate covers the WHOLE capture (transcript + anchor) — the single
  // captureMemory call below is the only write, so one gate pass is sufficient.
  if (capturedMemoryTaskIds.has(task.id)) return;
  capturedMemoryTaskIds.add(task.id);

  try {
    const settings = await store.getSettings();
    if (settings.memoryEnabled === false) return;
    const resolved = await resolveStashMemorySettings(store, settings);
    if ((resolved?.memoryBackendType as string | undefined) !== "stash") return;

    /*
    FNXC:RUFU121TaskCaptureIdentity 2026-08-18-19:53:
    RUFU-121 Step 4: task captures carry the store's projectId so the Stash
    backend stamps the per-project session folder (stable external_key
    fusion-<projectId>). The project name is forwarded only when the caller
    explicitly provides one — the folder resolves by external_key without a
    name. Mock/test stores may lack getProjectId: the optional call degrades
    to null (no identity, no folder) instead of throwing.
    */
    const projectId = deps.projectIdentity?.projectId ?? store.getProjectId?.() ?? null;
    const projectName = deps.projectIdentity?.projectName ?? null;

    /*
    FNXC:StashSessionCapture 2026-08-19-04:37:
    (RUFU-122) Per-event project identity for transcript + anchor metadata:
    `project` via the store's duck-typed getWorkflowSettingsProjectId (the
    no-task heartbeat patrol pattern — "default" when the store lacks the
    seam), `project_name` from the RUFU-121 runtime identity with a
    basename(rootDir) || "project" fallback so every captured event carries a
    non-empty project_name like chat-captured events do. These feed EVENT
    metadata only; the folder identity params above stay explicit-or-null so
    the RUFU-121 session-folder resolution is untouched.
    */
    const project = (typeof store.getWorkflowSettingsProjectId === "function"
      ? store.getWorkflowSettingsProjectId()
      : undefined) || "default";
    const projectNameMeta = projectName || basename(rootDir) || "project";

    // Transcript gates (operator-fixed setting names). The enabled flag
    // defaults ON; the max keeps the MOST RECENT N transcript events (tail),
    // never truncating an event mid-stream — the full log stays on disk.
    const sessionCaptureEnabled = settings.executorSessionCaptureEnabled !== false;
    const includeStatus = settings.executorSessionCaptureIncludeStatus === true;
    const rawMaxEvents = settings.executorSessionCaptureMaxEvents;
    const maxEvents =
      typeof rawMaxEvents === "number" && Number.isFinite(rawMaxEvents) && rawMaxEvents > 0
        ? Math.floor(rawMaxEvents)
        : 20_000;

    let transcript: MemoryCaptureEvent[] = [];
    if (sessionCaptureEnabled) {
      // Public reader only (TaskStore.getAgentLogs); minimal mock stores may
      // lack the seam — degrade to an empty transcript (anchor-only capture).
      const entries = (await store.getAgentLogs?.(task.id)) ?? [];
      if (entries.length === 0) {
        executorLog.warn(
          `${task.id}: agent-log.jsonl missing or pruned; transcript capture no-op (anchor still fires)`,
        );
      } else {
        transcript = buildTaskTranscriptEventsWithStatus(
          entries,
          task.id,
          taskStatus,
          { project, project_name: projectNameMeta },
          includeStatus,
        );
        if (transcript.length > maxEvents) {
          executorLog.warn(
            `${task.id}: transcript has ${transcript.length} events, exceeds executorSessionCaptureMaxEvents=${maxEvents}; keeping the most recent ${maxEvents} (full log remains on disk)`,
          );
          transcript = transcript.slice(-maxEvents);
        }
      }
    }

    /*
    FNXC:StashSessionCapture 2026-08-19-04:37:
    (RUFU-122) The terminal anchor is the LAST event of the single capture:
    task_completion from the completion seam, task_failure from the
    terminal-failure seam (anchorKind — never derived from task.status, which
    is never "done" on the completion seam; see the TaskCaptureAnchorKind
    note), content = task.title, metadata = { taskId, status, project,
    project_name }. The server stamps created_at; the legacy client
    timestamp field is dropped.
    */
    const anchor: MemoryCaptureEvent = {
      event_type: anchorKind === "failure" ? "task_failure" : "task_completion",
      content: taskTitle,
      metadata: { taskId: task.id, status: taskStatus, project, project_name: projectNameMeta },
    };

    const result = await captureMemory(
      rootDir,
      resolved,
      `fusion-task-${task.id}`,
      [...transcript, anchor],
      {
        taskId: task.id,
        projectRoot: rootDir,
        ...(projectId ? { projectId } : {}),
        ...(projectName ? { projectName } : {}),
      },
    );
    if (!result.ok) {
      // No-op backend / transient failure — do not fail the run.
      //
      // FNXC:StashSessionCapture 2026-08-19-07:30:
      // (RUFU-122 review fix) The operator's best-effort contract (2026-08-18
      // request, requirement 2) is a WARN log when a task's capture upload fails
      // mid-stream. The Stash sink has no logger of its own; it reports the
      // outcome through MemoryCaptureResult (ok=false, inserted = leading
      // successful chunks), so this branch is where that warn must surface —
      // at debug level a partial transcript upload (tail lost, only the first
      // 100-event chunks stored) would be invisible at default log levels.
      executorLog.warn(
        `${task.id}: task memory capture incomplete (ok=false, inserted=${result.inserted}, non-blocking)`,
      );
    }
  } catch (error) {
    executorLog.warn(
      `${task.id}: task memory capture failed (best-effort, non-blocking): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * Event-type mapping for a single chat message onto the Stash memory event shape. The Stash
 * backend enforces a top-level `agent_name` (default "fusion") and `session_id` per event
 * (FYNC:StashEventShape — missing fields → 422); content size/truncation is handled by the
 * captured `content` field. agent/tool identities are read from message.metadata when present.
 */
export function chatMessageToMemoryCaptureEvent(message: Pick<ChatMessage, "role" | "content" | "metadata">): MemoryCaptureEvent {
  const metadata: Record<string, unknown> = message.metadata ?? {};
  const agentName = typeof metadata.agent_name === "string"
    ? metadata.agent_name
    : typeof metadata.agentName === "string"
      ? metadata.agentName
      : "fusion";
  const toolName = typeof metadata.tool_name === "string"
    ? metadata.tool_name
    : typeof metadata.toolName === "string"
      ? metadata.toolName
      : undefined;

  const base: Record<string, unknown> = {
    event_type: message.role === "user" ? "user_message" : message.role === "assistant" ? "assistant_message" : "tool_use",
    agent_name: agentName,
    timestamp: new Date().toISOString(),
    content: message.content ?? "",
  };
  if (message.role === "system" && toolName) base.tool_name = toolName;

  return base as unknown as MemoryCaptureEvent;
}

/**
 * Duck-typed chat event emitter (ChatStore conforms via Node EventEmitter). Only the
 * `on`/`off` surface is required so tests can substitute a fake emitter.
 */
export interface ChatEventEmitter {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

/**
 * FNXC:RUFU121RuntimeProjectIdentity 2026-08-18-19:53:
 * RUFU-121 Step 4: the runtime-level project identity used as the fallback for
 * chat capture when a session carries no projectId of its own. Resolved ONCE
 * per runtime start (cached on the runtime; null on failure — never blocks
 * runtime start).
 */
export type RuntimeProjectIdentity = {
  projectId?: string | null;
  projectName?: string | null;
};

/**
 * Injectable capture sink used by {@link ChatSessionMemoryCapture}. The sink performs the
 * actual backend write (in production via `captureMemory` with stash secret resolution) so the
 * service itself stays deterministic and unit-testable without network/secret machinery.
 *
 * FNXC:RUFU121SinkIdentity 2026-08-18-19:53:
 * RUFU-121 Step 4: the sink receives the effective project identity per flush —
 * per-session context (from chat:session:updated) with the runtime identity as
 * fallback — so captureMemory can attribute events to the per-project Stash
 * session folder (external_key fusion-<projectId>). All identity params are
 * optional: a missing identity degrades to the legacy identity-less capture.
 */
export type ChatMemoryCaptureSink = (params: {
  sessionId: string;
  events: MemoryCaptureEvent[];
  rootDir: string;
  projectId?: string | null;
  projectName?: string | null;
  chatTitle?: string | null;
}) => Promise<MemoryCaptureResult>;

/**
 * A chat message plus its originating session id, as buffered by the capture service.
 * The id is used for per-session dedup so a message is never appended twice.
 */
interface BufferedChatMessage {
  id: string;
  sessionId: string;
  event: MemoryCaptureEvent;
}

/**
 * The chat-store events this service subscribes to.
 */
export const CHAT_MESSAGE_ADDED = "chat:message:added";
export const CHAT_SESSION_UPDATED = "chat:session:updated";

/**
 * Session statuses that signal "conversation close". ChatSessions transition to `archived`
 * when a conversation ends, so the final flush runs there.
 */
export const FINAL_CHAT_SESSION_STATUSES: ReadonlySet<string> = new Set(["archived"]);

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * Complete-CHAT-session memory capture service. It subscribes to a duck-typed chat-store event
 * emitter and, for each live message:
 *   - maps the message to a Stash memory event (progressive append-per-partes), and
 *   - buffers it so a final flock at conversation close (session `archived`) flushes anything
 *     not yet appended.
 *
 * Memory stores only messages for enabled / captured backends: the sink is a no-op when memory
 * is disabled or the backend lacks the capture seam. Buffering is per-session and dedup-safe by
 * message id, so a final flush never re-emits an already-appended message. All sink failures are
 * swallowed (best-effort), leaving the message buffered for a later retry — nothing ever throws
 * out of this service.
 */
export class ChatSessionMemoryCapture {
  /** Append-only per-session message log (never mutated after append). */
  private readonly buffers = new Map<string, BufferedChatMessage[]>();
  /** Confirmed-sent watermark per session (number of leading buffered messages already in the sink). */
  private readonly sentCounts = new Map<string, number>();
  /** Monotonic count of distinct messages confirmed sent for a session (survives buffer drain). */
  private readonly dispatchedTotals = new Map<string, number>();
  /**
   * Message ids confirmed-delivered per session, persistent across buffer drains. This is what
   * guarantees a re-emitted message id (e.g. the store re-firing a delivered event after the
   * buffer was already cleared) is never captured twice, while a sink failure keeps the id OUT
   * of this set so the final flush can safely retry it.
   */
  private readonly deliveredIds = new Map<string, Set<string>>();
  /** Per-session async serialization chain so progressive flushes never overlap. */
  private readonly flushQueues = new Map<string, Promise<unknown>>();
  /**
   * FNXC:RUFU121SessionIdentity 2026-08-18-19:53:
   * RUFU-121 Step 4: per-session project identity { projectId, title } cached from
   * chat:session:updated (emitted at session creation and on updates). ChatMessage
   * carries neither projectId nor a session title, so this cache is the ONLY
   * message-path source of a session's identity. Refreshed on every update so a
   * later flush always reads the freshest value.
   */
  private readonly sessionContexts = new Map<string, { projectId: string | null; title: string | null }>();
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  private detachFn: (() => void) | null = null;

  constructor(
    private readonly opts: {
      sink: ChatMemoryCaptureSink;
      rootDir: string;
      /** Emit each message to the sink immediately on arrival (progressive). Default true. */
      emitOnAdd?: boolean;
      finalStatuses?: ReadonlySet<string>;
      /**
       * FNXC:RUFU121SessionIdentity 2026-08-18-19:53:
       * RUFU-121 Step 4: runtime-level project identity — the fallback for
       * sessions whose chat:session:updated event carries no projectId.
       */
      projectIdentity?: RuntimeProjectIdentity;
    },
  ) {}

  /** Subscribe to a chat-store emitter. Returns a stable detach function. Idempotent. */
  attach(emitter: ChatEventEmitter): () => void {
    if (this.detachFn) return this.detachFn;

    const onMessage = (message: ChatMessage) => {
      void this.handleMessageAdded(message);
    };
    const onSessionUpdated = (session: ChatSession) => {
      void this.handleSessionUpdated(session);
    };
    this.handlers.set(CHAT_MESSAGE_ADDED, [onMessage as (...args: any[]) => void]);
    this.handlers.set(CHAT_SESSION_UPDATED, [onSessionUpdated as (...args: any[]) => void]);

    emitter.on(CHAT_MESSAGE_ADDED, onMessage as (...args: unknown[]) => void);
    emitter.on(CHAT_SESSION_UPDATED, onSessionUpdated as (...args: unknown[]) => void);

    this.detachFn = () => this.detach(emitter);
    return this.detachFn;
  }

  /** Remove subscriptions. Best-effort; safe to call multiple times. */
  detach(emitter: ChatEventEmitter): void {
    if (!this.detachFn) return;
    for (const [event, handlers] of this.handlers) {
      for (const handler of handlers) emitter.off(event, handler as (...args: unknown[]) => void);
    }
    this.handlers.clear();
    this.detachFn = null;
  }

  /** Handle a message added to a session: map → append to the per-session log → (progressive) flush. */
  async handleMessageAdded(message: ChatMessage): Promise<void> {
    if (!message || !message.id || !message.sessionId) return;
    // Skip a message already confirmed-delivered for this session (idempotent across re-emits).
    if (this.deliveredIds.get(message.sessionId)?.has(message.id)) return;

    let buffered = this.buffers.get(message.sessionId);
    if (!buffered) {
      buffered = [];
      this.buffers.set(message.sessionId, buffered);
    }
    // Dedup within the pending buffer by message id (a duplicate append while a flush is in
    // flight must not double-buffer the same message).
    if (buffered.some((b) => b.id === message.id)) return;
    buffered.push({ id: message.id, sessionId: message.sessionId, event: chatMessageToMemoryCaptureEvent(message) });

    if (this.opts.emitOnAdd !== false) {
      await this.flushSession(message.sessionId);
    }
  }

  /**
   * Handle a session update. Caches the session's project identity on EVERY
   * chat:session:updated, and when the session transitions to a final status,
   * flushes any remaining not-yet-sent messages — the idempotent
   * conversation-close flush.
   *
   * FNXC:RUFU121SessionIdentity 2026-08-18-19:53:
   * RUFU-121 Step 4: the identity cache is written BEFORE the final-status
   * early return so the conversation-close flush (and any progressive flush
   * after creation) sees the session's projectId/title even when the updated
   * event that carries them is itself the final-status event.
   */
  async handleSessionUpdated(session: ChatSession): Promise<void> {
    if (!session || !session.id) return;
    this.sessionContexts.set(session.id, {
      projectId: session.projectId ?? null,
      title: session.title ?? null,
    });
    const finalStatuses = this.opts.finalStatuses ?? FINAL_CHAT_SESSION_STATUSES;
    if (!finalStatuses.has(session.status)) return;
    await this.flushSession(session.id);
  }

  /** Number of still-pending (buffered, not-yet-sent) messages for a session. */
  pendingCount(sessionId: string): number {
    const buffered = this.buffers.get(sessionId);
    if (!buffered) return 0;
    return buffered.length - (this.sentCounts.get(sessionId) ?? 0);
  }

  /** Number of distinct messages already confirmed sent to the sink for a session. */
  dispatchedCount(sessionId: string): number {
    return this.dispatchedTotals.get(sessionId) ?? 0;
  }

  /**
   * Enqueue a flush for the session. Flushes are serialized per session (FIFO) so a progressive
   * append never races another in-flight flush: each drain reads a fresh watermark and sends only
   * the not-yet-sent tail. Never rejects — a failed sink leaves the tail buffered for retry.
   */
  flushSession(sessionId: string): Promise<MemoryCaptureResult | null> {
    const prev = this.flushQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => this.drain(sessionId))
      .catch(() => null);
    this.flushQueues.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async drain(sessionId: string): Promise<MemoryCaptureResult | null> {
    const buffered = this.buffers.get(sessionId);
    if (!buffered) return null;
    const sent = this.sentCounts.get(sessionId) ?? 0;
    if (buffered.length <= sent) {
      if (buffered.length === sent) {
        // Fully drained: drop the buffer AND reset the watermark so a future re-appended
        // sequence for this session starts fresh (dedup-safe, no stale watermark).
        this.buffers.delete(sessionId);
        this.sentCounts.delete(sessionId);
      }
      return null;
    }
    const events = buffered.slice(sent).map((b) => b.event);
    /*
    FNXC:RUFU121SessionIdentity 2026-08-18-19:53:
    RUFU-121 Step 4: effective project identity for this flush — the per-session
    context (cached from chat:session:updated) wins, the runtime identity is the
    fallback for sessions with no projectId of their own. projectName travels
    ONLY when it belongs to the effective project id: a cross-project session
    (ctx.projectId != runtime.projectId) must never be stamped with the runtime
    project's name — its Stash folder still resolves by the stable external_key
    fusion-<projectId>. A message before any session:updated event simply gets
    the runtime fallback (or nothing) and never throws.
    */
    const ctx = this.sessionContexts.get(sessionId);
    const effectiveProjectId = ctx?.projectId ?? this.opts.projectIdentity?.projectId ?? null;
    const runtimeIdentity = this.opts.projectIdentity;
    const effectiveProjectName =
      runtimeIdentity?.projectId != null &&
      runtimeIdentity.projectName != null &&
      runtimeIdentity.projectId === effectiveProjectId
        ? runtimeIdentity.projectName
        : undefined;
    const chatTitle = ctx?.title ?? undefined;
    let result: MemoryCaptureResult | null = null;
    try {
      result = await this.opts.sink({
        sessionId,
        events,
        rootDir: this.opts.rootDir,
        projectId: effectiveProjectId,
        projectName: effectiveProjectName,
        chatTitle,
      });
    } catch (error) {
      executorLog.warn(
        `chat memory capture flush failed for session ${sessionId} (best-effort, non-blocking): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result?.ok) {
      // Advance the watermark by exactly the events this drain sent — never re-advance over
      // messages appended while this drain was in flight.
      const newSent = sent + events.length;
      this.sentCounts.set(sessionId, newSent);
      this.dispatchedTotals.set(sessionId, (this.dispatchedTotals.get(sessionId) ?? 0) + events.length);
      let delivered = this.deliveredIds.get(sessionId);
      if (!delivered) {
        delivered = new Set<string>();
        this.deliveredIds.set(sessionId, delivered);
      }
      for (const entry of buffered.slice(sent)) delivered.add(entry.id);
      if (buffered.length === newSent) {
        this.buffers.delete(sessionId);
        this.sentCounts.delete(sessionId);
      }
    }
    return result;
  }
}

export interface ChatMemorySettingsReader extends StashSecretsReader {
  getSettings(): Promise<MemoryBackendSettings>;
}

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * Production capture sink: resolves memory settings + the stash secret (if backend is stash)
 * per flush and writes via the core `captureMemory` helper, which is itself fail-closed
 * (`{ok:false}` on any failure / disabled memory / non-capture backend). session_id is the
 * ChatSession id, so the Stash `/sessions/<sessionId>` screen shows the whole transcript.
 *
 * FNXC:RUFU121StashSinkIdentity 2026-08-18-19:53:
 * RUFU-121 Step 4: the optional `projectIdentity` argument is the runtime-level identity
 * fallback for direct sink callers. The ChatSessionMemoryCapture path already resolves the
 * effective per-flush identity (per-session context + runtime fallback) and passes it via the
 * sink params, so identity forwarded to captureMemory's meta is whichever is present — the
 * sink-param value wins, the factory fallback covers identity-less params. Existing per-flush
 * settings+secret resolution behavior is untouched.
 */
export function createStashChatMemoryCaptureSink(
  store: ChatMemorySettingsReader,
  projectIdentity?: RuntimeProjectIdentity,
): ChatMemoryCaptureSink {
  return async ({ sessionId, events, rootDir, projectId, projectName, chatTitle }) => {
    try {
      const settings = await store.getSettings();
      const resolved = await resolveStashMemorySettings(store, settings);
      const effectiveProjectId = projectId ?? projectIdentity?.projectId ?? null;
      const effectiveProjectName =
        projectName != null
          ? projectName
          : projectIdentity?.projectId != null &&
              projectIdentity.projectName != null &&
              projectIdentity.projectId === effectiveProjectId
            ? projectIdentity.projectName
            : null;
      return await captureMemory(rootDir, resolved, sessionId, events, {
        projectRoot: rootDir,
        ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
        ...(effectiveProjectName ? { projectName: effectiveProjectName } : {}),
        ...(chatTitle ? { chatTitle } : {}),
      });
    } catch {
      return { ok: false, inserted: 0, deduped: 0 };
    }
  };
}