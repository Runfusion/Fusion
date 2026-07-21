/**
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Messaging domain types peeled from types.ts.
 *
 * FNXC:CodeOrganization 2026-07-18-00:35:
 * Main landed task-proposal metadata and ephemeral task-creation policy on the
 * mailbox contract. Keep those symbols in this peel so types.ts only re-exports.
 */

import type { TaskPriority } from "./board.js";
import type { NativeStructureRef } from "../types.js";

export type ParticipantType = "agent" | "user" | "system";

/** Canonical recipient ID for dashboard user mailbox routing. */
export const DASHBOARD_USER_ID = "dashboard";

const DASHBOARD_USER_ALIASES = new Set([DASHBOARD_USER_ID, "user", "user:dashboard", "User: user:dashboard"]);

/** Normalize participant identity for durable mailbox routing. */
export function normalizeMessageParticipant(id: string, type: ParticipantType): { id: string; type: ParticipantType } {
  if (type !== "user") {
    return { id, type };
  }

  if (DASHBOARD_USER_ALIASES.has(id)) {
    return { id: DASHBOARD_USER_ID, type };
  }

  return { id, type };
}

/** Message types/categories */
export type MessageType = "agent-to-agent" | "agent-to-user" | "user-to-agent" | "system";

/** Stable metadata contract for linking a reply to an earlier message. */
export interface MessageReplyReference {
  /** ID of the message this one is replying to. */
  messageId: string;
}

/** Optional metadata attached to mailbox messages. */
export type EphemeralTaskCreationPolicy = "allow" | "upon_validation" | "deny";

/** Resolve the non-default policy without masking legacy persisted settings. */
export function resolveEphemeralTaskCreationPolicy(settings: {
  ephemeralAgentTaskCreationPolicy?: EphemeralTaskCreationPolicy;
  ephemeralAgentsCanCreateTasks?: boolean;
}): EphemeralTaskCreationPolicy {
  if (
    settings.ephemeralAgentTaskCreationPolicy === "allow" ||
    settings.ephemeralAgentTaskCreationPolicy === "upon_validation" ||
    settings.ephemeralAgentTaskCreationPolicy === "deny"
  ) {
    return settings.ephemeralAgentTaskCreationPolicy;
  }
  return settings.ephemeralAgentsCanCreateTasks === false ? "deny" : "allow";
}

export interface ProposedTaskMetadata {
  title: string;
  description: string;
  priority?: TaskPriority;
  workflowId?: string;
  dependencies?: string[];
}

/**
 * FNXC:NativeStructureEmbed 2026-07-20-12:00:
 * Mail persists a compact native-structure reference with an optional attach-time label. The
 * shared dashboard preview resolves current content lazily so metadata never stores stale cards.
 */
export type NativeStructureEmbed = NativeStructureRef & { label?: string };

export interface MessageMetadata extends Record<string, unknown> {
  /** Optional link to the original message when this message is a reply. */
  replyTo?: MessageReplyReference;
  /**
   * If true, the recipient agent is woken immediately on receipt regardless
   * of their own `messageResponseMode` setting. Sender-initiated override —
   * use sparingly for urgent messages. Ignored when recipient is a user.
   */
  wakeRecipient?: boolean;
  /** Structured operator-approved follow-up task proposal. */
  kind?: string;
  /** Related task for mailbox messages that require an operator response. */
  taskId?: string;
  /** Persisted Planning Mode session for a planning-clarification message. */
  sessionId?: string;
  /** Planning question that produced a planning-clarification message. */
  questionId?: string;
  /**
   * FNXC:CliChatConversation 2026-07-20-12:00:
   * CLI-to-agent mailbox chat needs a durable thread identity because MessageStore
   * inbox delivery is not a dashboard ChatView session or a multi-agent room.
   */
  conversationId?: string;
  proposedTask?: ProposedTaskMetadata;
  proposalStatus?: "pending" | "creating" | "created" | "dismissed";
  createdTaskId?: string;
  /** Stable proposal key issued at send time and never rotated across reclaims. */
  proposalIdempotencyKey?: string;
  /** Transient owner token for the current creating lease only. */
  claimOwnerToken?: string;
  /** Durable ISO timestamp used to reclaim a creator that died before task persistence. */
  claimStartedAt?: string;
  /**
   * FNXC:NativeStructureEmbed 2026-07-20-12:00:
   * First-class report/approval attachments. Each reference stays small and the label gives an
   * unavailable target a human-readable fallback after lazy preview resolution.
   */
  nativeStructures?: NativeStructureEmbed[];
}

/** Message record stored in the system */
export interface Message {
  /** Unique identifier */
  id: string;
  /** Sender identifier */
  fromId: string;
  /** Sender type */
  fromType: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Whether the recipient has read this message */
  read: boolean;
  /** Optional extra data */
  metadata?: MessageMetadata;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input for creating a new message */
export interface MessageCreateInput {
  /** Sender identifier (auto-filled by the transport layer if omitted) */
  fromId?: string;
  /** Sender type (auto-filled by the transport layer if omitted) */
  fromType?: ParticipantType;
  /** Recipient identifier */
  toId: string;
  /** Recipient type */
  toType: ParticipantType;
  /** Message body */
  content: string;
  /** Message category */
  type: MessageType;
  /** Optional extra data */
  metadata?: MessageMetadata;
}

/** Filter options for querying messages */
export interface MessageFilter {
  /** Filter by message type */
  type?: MessageType;
  /** Filter by read status */
  read?: boolean;
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip (for pagination) */
  offset?: number;
}
