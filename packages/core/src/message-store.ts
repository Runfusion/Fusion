/**
 * MessageStore - Filesystem-based persistence for the messaging system.
 *
 * Messages are stored at `.fusion/messages/{messageId}.json` with their metadata.
 * An index file at `.fusion/messages/index.json` provides efficient mailbox lookups.
 *
 * File Structure:
 * - messages/{messageId}.json: Individual message data
 * - messages/index.json: Owner-to-message index for inbox/outbox queries
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Message,
  MessageCreateInput,
  MessageFilter,
  MessageType,
  Mailbox,
  ParticipantType,
} from "./types.js";

/** Events emitted by MessageStore */
export interface MessageStoreEvents {
  /** Emitted when a new message is created and sent */
  "message:sent": (message: Message) => void;
  /** Emitted when a message is received by a participant */
  "message:received": (message: Message) => void;
  /** Emitted when a message is marked as read */
  "message:read": (message: Message) => void;
  /** Emitted when a message is deleted */
  "message:deleted": (messageId: string) => void;
}

/** Options for MessageStore constructor */
export interface MessageStoreOptions {
  /** Root directory for kb data (default: .fusion) */
  rootDir?: string;
}

/** Index structure for mailbox lookups */
interface MessageIndex {
  /** Map of "type:id" -> { inbox: [msgId, ...], outbox: [msgId, ...] } */
  byOwner: Record<string, { inbox: string[]; outbox: string[] }>;
}

/**
 * MessageStore manages messages between agents, users, and the system.
 * Uses filesystem-based persistence following the AgentStore pattern.
 */
export class MessageStore extends EventEmitter {
  private rootDir: string;
  private messagesDir: string;
  private indexPath: string;

  constructor(options: MessageStoreOptions = {}) {
    super();
    this.rootDir = options.rootDir ?? ".fusion";
    this.messagesDir = join(this.rootDir, "messages");
    this.indexPath = join(this.messagesDir, "index.json");
  }

  /**
   * Initialize the store by creating necessary directories and index file.
   * Should be called before other operations.
   */
  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      await this.writeIndex({ byOwner: {} });
    }
  }

  /**
   * Create and store a new message.
   * @param input - Message creation parameters
   * @returns The created message
   */
  async sendMessage(input: MessageCreateInput): Promise<Message> {
    const now = new Date().toISOString();
    const messageId = `msg-${randomUUID().slice(0, 8)}`;

    const fromId = input.fromId ?? "system";
    const fromType = input.fromType ?? "system";

    const message: Message = {
      id: messageId,
      fromId,
      fromType,
      toId: input.toId,
      toType: input.toType,
      content: input.content,
      type: input.type,
      read: false,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    // Write message file
    await this.writeMessageFile(message);

    // Update index
    await this.addToIndex(message);

    this.emit("message:sent", message);
    this.emit("message:received", message);

    return message;
  }

  /**
   * Get a single message by ID.
   * @param id - The message ID
   * @returns The message, or null if not found
   */
  async getMessage(id: string): Promise<Message | null> {
    try {
      const path = join(this.messagesDir, `${id}.json`);
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as Message;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get inbox messages for a participant (messages where they are the recipient).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  async getInbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Promise<Message[]> {
    const index = await this.readIndex();
    const key = `${ownerType}:${ownerId}`;
    const inboxIds = index.byOwner[key]?.inbox ?? [];

    const messages = await this.loadMessagesByIds(inboxIds);
    return this.applyFilter(messages, filter);
  }

  /**
   * Get outbox messages for a participant (messages they sent).
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @param filter - Optional filter criteria
   * @returns Array of messages (newest first)
   */
  async getOutbox(
    ownerId: string,
    ownerType: ParticipantType,
    filter?: MessageFilter,
  ): Promise<Message[]> {
    const index = await this.readIndex();
    const key = `${ownerType}:${ownerId}`;
    const outboxIds = index.byOwner[key]?.outbox ?? [];

    const messages = await this.loadMessagesByIds(outboxIds);
    return this.applyFilter(messages, filter);
  }

  /**
   * Mark a message as read.
   * @param messageId - The message ID
   * @returns The updated message
   * @throws Error if message not found
   */
  async markAsRead(messageId: string): Promise<Message> {
    const message = await this.getMessage(messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    if (message.read) return message;

    const updated: Message = {
      ...message,
      read: true,
      updatedAt: new Date().toISOString(),
    };

    await this.writeMessageFile(updated);
    this.emit("message:read", updated);

    return updated;
  }

  /**
   * Mark all inbox messages as read for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Number of messages marked as read
   */
  async markAllAsRead(
    ownerId: string,
    ownerType: ParticipantType,
  ): Promise<number> {
    const inbox = await this.getInbox(ownerId, ownerType);
    const unread = inbox.filter((m) => !m.read);

    let count = 0;
    for (const message of unread) {
      await this.markAsRead(message.id);
      count++;
    }

    return count;
  }

  /**
   * Delete a message by ID.
   * @param id - The message ID
   * @throws Error if message not found
   */
  async deleteMessage(id: string): Promise<void> {
    const message = await this.getMessage(id);
    if (!message) {
      throw new Error(`Message ${id} not found`);
    }

    // Remove message file
    const path = join(this.messagesDir, `${id}.json`);
    await unlink(path);

    // Remove from index
    await this.removeFromIndex(message);

    this.emit("message:deleted", id);
  }

  /**
   * Get all messages between two participants (conversation view).
   * @param participantA - First participant
   * @param participantB - Second participant
   * @returns Array of messages (oldest first for conversation ordering)
   */
  async getConversation(
    participantA: { id: string; type: ParticipantType },
    participantB: { id: string; type: ParticipantType },
  ): Promise<Message[]> {
    const index = await this.readIndex();
    const keyA = `${participantA.type}:${participantA.id}`;
    const keyB = `${participantB.type}:${participantB.id}`;

    const aInbox = index.byOwner[keyA]?.inbox ?? [];
    const aOutbox = index.byOwner[keyA]?.outbox ?? [];
    const allA = new Set([...aInbox, ...aOutbox]);

    const bInbox = index.byOwner[keyB]?.inbox ?? [];
    const bOutbox = index.byOwner[keyB]?.outbox ?? [];
    const allB = new Set([...bInbox, ...bOutbox]);

    // Find intersection: messages both participants have
    const conversationIds = [...allA].filter((id) => allB.has(id));

    const messages = await this.loadMessagesByIds(conversationIds);
    // Conversation order: oldest first
    return [...messages].reverse();
  }

  /**
   * Get mailbox summary for a participant.
   * @param ownerId - The participant ID
   * @param ownerType - The participant type
   * @returns Mailbox summary with unread count and last message
   */
  async getMailbox(
    ownerId: string,
    ownerType: ParticipantType,
  ): Promise<Mailbox> {
    const inbox = await this.getInbox(ownerId, ownerType);
    const unreadCount = inbox.filter((m) => !m.read).length;
    const lastMessage = inbox.length > 0 ? inbox[0] : undefined;

    return {
      ownerId,
      ownerType,
      unreadCount,
      lastMessage,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async writeMessageFile(message: Message): Promise<void> {
    const path = join(this.messagesDir, `${message.id}.json`);
    const tempPath = `${path}.tmp.${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(message, null, 2));
    await rename(tempPath, path);
  }

  private async readIndex(): Promise<MessageIndex> {
    try {
      const content = await readFile(this.indexPath, "utf-8");
      return JSON.parse(content) as MessageIndex;
    } catch {
      return { byOwner: {} };
    }
  }

  private async writeIndex(index: MessageIndex): Promise<void> {
    const tempPath = `${this.indexPath}.tmp.${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(index, null, 2));
    await rename(tempPath, this.indexPath);
  }

  private async addToIndex(message: Message): Promise<void> {
    const index = await this.readIndex();

    // Add to recipient's inbox
    const toKey = `${message.toType}:${message.toId}`;
    if (!index.byOwner[toKey]) {
      index.byOwner[toKey] = { inbox: [], outbox: [] };
    }
    index.byOwner[toKey].inbox.unshift(message.id);

    // Add to sender's outbox
    const fromKey = `${message.fromType}:${message.fromId}`;
    if (!index.byOwner[fromKey]) {
      index.byOwner[fromKey] = { inbox: [], outbox: [] };
    }
    index.byOwner[fromKey].outbox.unshift(message.id);

    await this.writeIndex(index);
  }

  private async removeFromIndex(message: Message): Promise<void> {
    const index = await this.readIndex();

    // Remove from recipient's inbox
    const toKey = `${message.toType}:${message.toId}`;
    if (index.byOwner[toKey]) {
      index.byOwner[toKey].inbox = index.byOwner[toKey].inbox.filter((id) => id !== message.id);
      index.byOwner[toKey].outbox = index.byOwner[toKey].outbox.filter((id) => id !== message.id);
    }

    // Remove from sender's outbox
    const fromKey = `${message.fromType}:${message.fromId}`;
    if (index.byOwner[fromKey]) {
      index.byOwner[fromKey].inbox = index.byOwner[fromKey].inbox.filter((id) => id !== message.id);
      index.byOwner[fromKey].outbox = index.byOwner[fromKey].outbox.filter((id) => id !== message.id);
    }

    await this.writeIndex(index);
  }

  private async loadMessagesByIds(ids: string[]): Promise<Message[]> {
    const messages: Message[] = [];
    for (const id of ids) {
      const message = await this.getMessage(id);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }

  private applyFilter(messages: Message[], filter?: MessageFilter): Message[] {
    let result = messages;

    if (filter?.type) {
      result = result.filter((m) => m.type === filter.type);
    }

    if (filter?.read !== undefined) {
      result = result.filter((m) => m.read === filter.read);
    }

    // Apply pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? result.length;
    result = result.slice(offset, offset + limit);

    return result;
  }
}
