import type { ChatRoomMember, ChatRoomMessage } from "@fusion/core";

/**
 * FN-5425: prompt-layer multi-agent coordination advisory for explicit task-filing room messages.
 * This module stays deterministic and fail-open: it only detects intent + suggests claim/defer
 * prompt branches, while authoritative duplicate prevention remains in intake safeguards.
 */
export interface TaskFilingIntentDetection {
  isTaskFilingIntent: boolean;
  cues: string[];
  subject: string | null;
}

export interface RoomCoordinationDecision {
  branch: "claim" | "defer-suggested";
  memberCount: number;
  detection: TaskFilingIntentDetection;
  priorClaimMessageId?: string;
  priorClaimSenderId?: string | null;
  priorTaskId?: string;
}

export interface RenderCoordinationOptions {
  deicticMessageId?: never;
  pendingMessageId: string;
}

const MAX_INTENT_CONTENT_LENGTH = 800;
const MAX_SUBJECT_LENGTH = 140;
const DEICTIC_NOUN_FOLLOWUP_PATTERN = /\b(?:it|that|this)\s+(?:as|for|to)\b/i;
const TASK_ID_PATTERN = /\b(FN-\d{1,6})\b/i;
const PRIOR_CLAIM_RE = /^\s*claiming[:-]/i;
const TASK_ANNOUNCED_RE = /\b(?:filed|created|opened|tracked|added)\b[\s\S]{0,60}?\b(FN-\d{1,6})\b|\b(FN-\d{1,6})\b[\s\S]{0,60}?\b(?:filed|created|opened|tracked|added)\b/i;

const TASK_CONTEXT_SUFFIX = "(?=$|[.?!,:;-]|\\s+(?:for|about|to|on|regarding)\\b)";

const TASK_FILING_CUES: ReadonlyArray<[string, RegExp]> = [
  ["file a task", new RegExp(`\\bfile\\w*\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["filed a task", /\bfiled\s+(?:a\s+|the\s+)?task\b/i],
  ["create a task", new RegExp(`\\bcreate\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["open a task", new RegExp(`\\bopen\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["add a task", new RegExp(`\\badd\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["track this/that as a task", new RegExp(`\\btrack\\s+(?:this|that)\\s+(?:as\\s+)?(?:a\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["start a task", new RegExp(`\\bstart\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
  ["make a task", new RegExp(`\\bmake\\s+(?:a\\s+|the\\s+)?task${TASK_CONTEXT_SUFFIX}`, "i")],
];

function normalizeMessageContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(value: string, maxLength = MAX_SUBJECT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function cleanExtractedSubject(subject: string): string {
  return truncateWithEllipsis(
    subject
      .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractSubject(normalized: string): string | null {
  const preferred = normalized.match(
    /(?:file\w*|create|open|add|track|start|make)\s+(?:a\s+|the\s+)?task\s+(?:for|about|to|on|regarding)\s+(.+?)(?:[.?!]|$)/i,
  );
  if (preferred?.[1]) {
    const cleaned = cleanExtractedSubject(preferred[1]);
    return cleaned || null;
  }

  const fallback = normalized.match(
    /(?:file\w*|create|open|add|track|start|make)\s+(?:a\s+|the\s+)?task(?:\s+|\s*[:-]\s*)(.+?)(?:[.?!]|$)/i,
  );
  if (fallback?.[1]) {
    const cleaned = cleanExtractedSubject(fallback[1]);
    return cleaned || null;
  }

  return null;
}

export function detectTaskFilingIntent(content: string): TaskFilingIntentDetection {
  const normalized = normalizeMessageContent(content);
  if (!normalized || normalized.length > MAX_INTENT_CONTENT_LENGTH) {
    return { isTaskFilingIntent: false, cues: [], subject: null };
  }

  const cueMatches: Array<{ cue: string; index: number }> = [];
  for (const [cue, pattern] of TASK_FILING_CUES) {
    const match = pattern.exec(normalized);
    if (match?.index != null) {
      cueMatches.push({ cue, index: match.index });
    }
  }

  if (cueMatches.length === 0) {
    return { isTaskFilingIntent: false, cues: [], subject: null };
  }

  if (/\bfiled\s+(?:a\s+|the\s+)?task\s+report\b/i.test(normalized)) {
    return { isTaskFilingIntent: false, cues: [], subject: null };
  }

  const earliestCueIndex = cueMatches.reduce((min, current) => Math.min(min, current.index), Number.POSITIVE_INFINITY);
  const deicticMatch = DEICTIC_NOUN_FOLLOWUP_PATTERN.exec(normalized);
  const deicticIndex = deicticMatch?.index ?? -1;
  if (deicticIndex >= 0 && deicticIndex < earliestCueIndex) {
    return { isTaskFilingIntent: false, cues: [], subject: null };
  }

  const subject = extractSubject(normalized);

  // Intentional trade-off: the advisory is harmless under occasional tense false positives,
  // and FN-5152/FN-5220 intake dedup remains the deterministic backstop.
  return {
    isTaskFilingIntent: true,
    cues: cueMatches.sort((a, b) => a.index - b.index).map((entry) => entry.cue),
    subject,
  };
}

export function countActiveAgentMembers(members: ChatRoomMember[]): number {
  // ChatStore.removeRoomMember hard-deletes rows, so listRoomMembers is already active-only.
  const uniqueAgentIds = new Set(members.map((member) => member.agentId).filter((agentId): agentId is string => Boolean(agentId)));
  return uniqueAgentIds.size;
}

export function decideRoomCoordination(args: {
  detection: TaskFilingIntentDetection;
  members: ChatRoomMember[];
  recentMessages: ChatRoomMessage[];
  pendingSenderAgentId: string | null;
}): RoomCoordinationDecision | null {
  const { detection, members, recentMessages, pendingSenderAgentId } = args;
  if (!detection.isTaskFilingIntent) {
    return null;
  }

  const memberCount = countActiveAgentMembers(members);
  if (memberCount < 2) {
    return null;
  }

  const lookback = recentMessages.slice(-15);
  let priorClaimMessageId: string | undefined;
  let priorClaimSenderId: string | null | undefined;
  let priorTaskId: string | undefined;

  for (const message of lookback) {
    if (!message.senderAgentId) {
      continue;
    }
    if (pendingSenderAgentId && message.senderAgentId === pendingSenderAgentId) {
      continue;
    }

    const claimMatch = PRIOR_CLAIM_RE.test(message.content);
    const announcedMatch = TASK_ANNOUNCED_RE.exec(message.content);
    if (!claimMatch && !announcedMatch) {
      continue;
    }

    priorClaimMessageId = message.id;
    priorClaimSenderId = message.senderAgentId;
    const captured = announcedMatch?.[1] ?? announcedMatch?.[2] ?? message.content.match(TASK_ID_PATTERN)?.[1];
    priorTaskId = captured?.toUpperCase();
    break;
  }

  return {
    branch: priorClaimMessageId ? "defer-suggested" : "claim",
    memberCount,
    detection,
    priorClaimMessageId,
    priorClaimSenderId,
    priorTaskId,
  };
}

export function renderRoomCoordinationPromptBlock(
  decision: RoomCoordinationDecision,
  pendingMessage: Pick<ChatRoomMessage, "id">,
): string[] {
  if (decision.branch === "claim") {
    return [
      `Multi-agent room (${decision.memberCount} agents). Before calling fn_task_create for this request, coordinate:`,
      `1. Post a ONE-LINE claim to the room first via fn_post_room_message: "Claiming: filing task for <subject>" (reply_to_message_id = ${pendingMessage.id}).`,
      "2. Then call fn_task_create. The deterministic / near-duplicate / explicit-marker intake guards (FN-4918 / FN-4829 / FN-5152 / FN-5220) are your authoritative backstop — do NOT pass acknowledgedDuplicates or bypassDuplicateCheck to silence a duplicate match for a room request.",
      `3. After fn_task_create returns, post the resulting FN-NNNN id back to the room via fn_post_room_message (reply_to_message_id = ${pendingMessage.id}).`,
      `Detected subject: ${decision.detection.subject ?? "(none extracted — restate the user's request in your claim)"}.`,
    ];
  }

  return [
    `Multi-agent room (${decision.memberCount} agents). A peer agent (${decision.priorClaimSenderId ?? "unknown"}) already posted a claim or task announcement in this room (message ${decision.priorClaimMessageId}${decision.priorTaskId ? `, task ${decision.priorTaskId}` : ""}).`,
    `Do NOT call fn_task_create for this request. Reply once via fn_post_room_message (reply_to_message_id = ${pendingMessage.id}) acknowledging the existing claim${decision.priorTaskId ? ` and echoing ${decision.priorTaskId}` : ""}.`,
    "If you believe the peer's task does NOT cover this request, say so explicitly in your reply and wait for human disambiguation rather than filing in parallel.",
  ];
}
