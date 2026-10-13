/*
FNXC:HeartbeatWakeDiscipline 2026-10-13 (STAS-300):

One place reads the signals a heartbeat wake is allowed to claim, and the same
place answers "is anything newer than what the last acknowledged run already
saw?". Both the prompt the agent reads and the timer gate that decides whether to
spend a session on it come through here, because the two had drifted: the prompt
rendered a `limit: 10` preview's `.length` as the unread total, while the agent's
own `fn_read_messages` — the same `messages` table, a different query — could
report up to 31. A second counter that can disagree is what made a phantom
"pending messages: 10" unfixable from inside the prompt.

Rules this module exists to enforce:
- The unread total is the message store's own count (`getMailbox().unreadCount`,
  the same `read = 0 AND NOT archived` predicate `fn_read_messages` reads), never
  a preview length. No store means no total: callers get `null` and must say so
  instead of printing a 0.
- A caller that cannot read a signal throws to its caller. Silence is what let an
  idle agent be re-dispatched for weeks.
*/
import type { Agent, ChatRoom, ChatRoomMessage, ChatStore, Message, MessageStore, TaskStore } from "@fusion/core";
import { resolveFreshAutoClaimCandidates, type AutoClaimSnapshotManager } from "./scheduling/auto-claim-snapshot.js";

/** How many unread rows the wake delta shows the agent as a preview. A preview, never a total. */
export const INBOX_PREVIEW_LIMIT = 10;
const ROOM_MESSAGES_PER_ROOM_LIMIT = 10;
const ROOM_MESSAGES_TOTAL_CAP = 30;

export interface WakeInboxSignal {
  /** The store's unread total, or `null` when no authoritative message store exists. */
  unreadTotal: number | null;
  preview: Message[];
}

export async function collectInboxSignal(
  messageStore: MessageStore | undefined,
  agentId: string,
): Promise<WakeInboxSignal> {
  if (!messageStore) {
    return { unreadTotal: null, preview: [] };
  }
  const [preview, mailbox] = await Promise.all([
    messageStore.getInbox(agentId, "agent", { read: false, limit: INBOX_PREVIEW_LIMIT }),
    messageStore.getMailbox(agentId, "agent"),
  ]);
  return { unreadTotal: mailbox.unreadCount, preview };
}

export interface WakeRoomSignal {
  entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>;
  total: number;
  truncatedCount: number;
}

export async function collectRoomSignal(
  chatStore: ChatStore | undefined,
  agentId: string,
  sinceIso: string,
): Promise<WakeRoomSignal> {
  if (!chatStore) {
    return { entries: [], total: 0, truncatedCount: 0 };
  }

  const rooms = await chatStore.listRoomsForAgent(agentId, { status: "active" });
  const entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }> = [];
  let total = 0;
  let surfaced = 0;
  let truncatedCount = 0;

  for (const room of rooms) {
    const messages = await chatStore.listRoomMessagesSince(room.id, sinceIso, {
      excludeSenderAgentId: agentId,
      limit: ROOM_MESSAGES_PER_ROOM_LIMIT,
    });
    if (messages.length === 0) {
      continue;
    }

    total += messages.length;
    const remaining = ROOM_MESSAGES_TOTAL_CAP - surfaced;
    if (remaining <= 0) {
      truncatedCount += messages.length;
      continue;
    }

    const surfacedMessages = messages.slice(0, remaining);
    truncatedCount += messages.length - surfacedMessages.length;
    entries.push({ room, messages: surfacedMessages });
    surfaced += surfacedMessages.length;
  }

  return { entries, total, truncatedCount };
}

/**
 * What the last acknowledged run said it had seen. `consumedMessageIds` holds only ids the
 * store CONFIRMED read, so a listed id can never reappear in an unread query — the list is the
 * audit record of the acknowledgement, and the board/comment cursors are the freshness compare.
 */
export interface HeartbeatWakeCursor {
  consumedMessageIds: string[];
  roomEntryIds: string[];
  surfacedCommentIds: string[];
  boardState: HeartbeatBoardState;
}

export interface HeartbeatBoardState {
  assignedTaskId?: string | null;
  assignedTaskState?: string | null;
  assignedRows: string[];
  autoClaimCandidates: string[];
}

export interface WakeSignalSnapshot {
  inboxUnreadTotal: number;
  roomEntryIds: string[];
  steeringCommentIds: string[];
  boardState: HeartbeatBoardState;
}

export type WakeCursorParse =
  | { kind: "absent" }
  | { kind: "unsupported" }
  | { kind: "cursor"; cursor: HeartbeatWakeCursor };

/**
 * Reads the acknowledgement out of a persisted run row. Anything the module cannot prove —
 * no run, no cursor, a cursor whose shape it does not recognise — is reported as such so the
 * caller dispatches: suppression has to be earned, never assumed.
 */
export function parseHeartbeatWakeCursor(resultJson: unknown): WakeCursorParse {
  if (!isRecord(resultJson) || resultJson.heartbeatDoneAccepted !== true) {
    return { kind: "absent" };
  }
  const cursor = resultJson.wakeCursor;
  if (!isRecord(cursor) || !isRecord(cursor.boardState)) {
    return { kind: "unsupported" };
  }
  if (
    !isStringArray(cursor.consumedMessageIds)
    || !isStringArray(cursor.roomEntryIds)
    || !isStringArray(cursor.surfacedCommentIds)
    || !isStringArray(cursor.boardState.assignedRows)
    || !isStringArray(cursor.boardState.autoClaimCandidates)
  ) {
    return { kind: "unsupported" };
  }

  return {
    kind: "cursor",
    cursor: {
      consumedMessageIds: cursor.consumedMessageIds,
      roomEntryIds: cursor.roomEntryIds,
      surfacedCommentIds: cursor.surfacedCommentIds,
      boardState: {
        assignedTaskId: readNullableString(cursor.boardState.assignedTaskId),
        assignedTaskState: readNullableString(cursor.boardState.assignedTaskState),
        assignedRows: cursor.boardState.assignedRows,
        autoClaimCandidates: cursor.boardState.autoClaimCandidates,
      },
    },
  };
}

/**
 * The board and comment half of the wake-signal compare, read the same way the prompt reads it:
 * the agent's assigned rows, the steering comments on them, and — only for an agent that can run
 * without an assignment — the auto-claim candidate set.
 */
export interface WakeSignalSources {
  taskStore: TaskStore;
  agent: Agent;
  chatStore?: ChatStore;
  messageStore?: MessageStore;
  /** The same snapshot cache the prompt renders candidates from, so both read one board view. */
  autoClaimSnapshotManager?: AutoClaimSnapshotManager;
  sinceIso: string;
}

/**
 * The board half of a wake cursor: the rows assigned to this agent with the column each sits in,
 * and — for an agent that can run unassigned — the auto-claim candidate set. Written by the run
 * that advertised them and compared by the next tick, so it must be read identically both times.
 */
export async function collectBoardSignal(
  sources: Pick<WakeSignalSources, "taskStore" | "agent" | "autoClaimSnapshotManager">,
): Promise<HeartbeatBoardState> {
  const { taskStore, agent, autoClaimSnapshotManager } = sources;
  const [assignedTasks, autoClaimCandidates] = await Promise.all([
    taskStore.getTasksByAssignedAgent(agent.id),
    collectAutoClaimCandidateIds(taskStore, agent, autoClaimSnapshotManager),
  ]);

  return boardStateFrom(assignedTasks, agent, autoClaimCandidates);
}

export async function collectWakeSignals(sources: WakeSignalSources): Promise<WakeSignalSnapshot> {
  const { taskStore, agent, chatStore, messageStore, autoClaimSnapshotManager, sinceIso } = sources;
  const [assignedTasks, inbox, rooms, autoClaimCandidates] = await Promise.all([
    taskStore.getTasksByAssignedAgent(agent.id),
    collectInboxSignal(messageStore, agent.id),
    collectRoomSignal(chatStore, agent.id, sinceIso),
    collectAutoClaimCandidateIds(taskStore, agent, autoClaimSnapshotManager),
  ]);

  if (inbox.unreadTotal === null) {
    throw new Error(`wake-signal probe: no authoritative message store for ${agent.id}`);
  }

  return {
    inboxUnreadTotal: inbox.unreadTotal,
    roomEntryIds: rooms.entries.flatMap((entry) => entry.messages.map((message) => message.id)),
    steeringCommentIds: assignedTasks.flatMap((task) => (task.steeringComments ?? []).map((comment) => comment.id)),
    boardState: boardStateFrom(assignedTasks, agent, autoClaimCandidates),
  };
}

function boardStateFrom(
  assignedTasks: Awaited<ReturnType<TaskStore["getTasksByAssignedAgent"]>>,
  agent: Agent,
  autoClaimCandidates: string[],
): HeartbeatBoardState {
  return {
    assignedTaskId: agent.taskId ?? null,
    assignedTaskState: assignedTasks.find((task) => task.id === agent.taskId)?.column ?? null,
    assignedRows: assignedTasks.map((task) => `${task.id}:${task.column}`),
    autoClaimCandidates,
  };
}

/** True when the fresh snapshot holds anything the acknowledged cursor did not already cover. */
export function hasFresherWakeSignal(cursor: HeartbeatWakeCursor, snapshot: WakeSignalSnapshot): boolean {
  if (snapshot.inboxUnreadTotal > 0) return true;
  if (snapshot.roomEntryIds.some((id) => !cursor.roomEntryIds.includes(id))) return true;
  if (snapshot.steeringCommentIds.some((id) => !cursor.surfacedCommentIds.includes(id))) return true;
  if (!sameIdSet(cursor.boardState.assignedRows, snapshot.boardState.assignedRows)) return true;
  if (cursor.boardState.assignedTaskState !== snapshot.boardState.assignedTaskState) return true;
  return !sameIdSet(cursor.boardState.autoClaimCandidates, snapshot.boardState.autoClaimCandidates);
}

/**
 * The auto-claim candidate ids the run would have advertised. Returns [] for an agent that already
 * has an assignment, matching the prompt path that only shows candidates to a no-task agent.
 */
async function collectAutoClaimCandidateIds(
  taskStore: TaskStore,
  agent: Agent,
  snapshotManager: AutoClaimSnapshotManager | undefined,
): Promise<string[]> {
  if (agent.taskId || !snapshotManager) return [];
  const snapshot = await snapshotManager.getSnapshot();
  const freshCandidates = await resolveFreshAutoClaimCandidates(taskStore, snapshot.tasks);
  return freshCandidates.map((candidate) => candidate.id).sort();
}

function sameIdSet(cursorIds: string[], snapshotIds: string[]): boolean {
  if (cursorIds.length !== snapshotIds.length) return false;
  const known = new Set(cursorIds);
  return snapshotIds.every((id) => known.has(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}
