import { MessageStore, createDatabase } from "@fusion/core";
import type { Database, ParticipantType } from "@fusion/core";
import { resolveProject } from "../project-context.js";

/**
 * Get the project path for message operations.
 * Falls back to process.cwd() if no project is specified.
 */
async function getProjectPath(projectName?: string): Promise<string> {
  if (projectName) {
    const context = await resolveProject(projectName);
    return context.projectPath;
  }

  try {
    const context = await resolveProject(undefined);
    return context.projectPath;
  } catch {
    return process.cwd();
  }
}

/**
 * Create a MessageStore for the given project.
 * Returns both the store and database for proper cleanup.
 */
async function createMessageStore(projectName?: string): Promise<{ store: MessageStore; db: Database }> {
  const projectPath = await getProjectPath(projectName);
  const kbDir = projectPath + "/.fusion";
  const db = createDatabase(kbDir);
  db.init();
  const store = new MessageStore(db);
  return { store, db };
}

/** User ID for CLI-originated messages */
const CLI_USER_ID = "cli";

/**
 * List inbox messages.
 */
export async function runMessageInbox(projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    const mailbox = store.getMailbox(CLI_USER_ID, "user");
    const messages = store.getInbox(CLI_USER_ID, "user", { limit: 20 });

    console.log();
    console.log(`  📬 Inbox (${mailbox.unreadCount} unread)`);
    console.log();

    if (messages.length === 0) {
      console.log("  No messages");
      console.log();
      return;
    }

    for (const msg of messages) {
      const readMarker = msg.read ? "  " : "● ";
      const fromLabel = msg.fromType === "agent" ? `Agent ${msg.fromId}` : msg.fromId;
      const timeStr = formatTime(msg.createdAt);
      const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + "…" : msg.content;
      console.log(`  ${readMarker}${fromLabel} — ${timeStr}`);
      console.log(`    ${preview}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

/**
 * List sent messages.
 */
export async function runMessageOutbox(projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    const messages = store.getOutbox(CLI_USER_ID, "user", { limit: 20 });

    console.log();
    console.log("  📤 Outbox");
    console.log();

    if (messages.length === 0) {
      console.log("  No sent messages");
      console.log();
      return;
    }

    for (const msg of messages) {
      const toLabel = msg.toType === "agent" ? `Agent ${msg.toId}` : msg.toId;
      const timeStr = formatTime(msg.createdAt);
      const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + "…" : msg.content;
      console.log(`  To: ${toLabel} — ${timeStr}`);
      console.log(`    ${preview}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

/**
 * Send a message to an agent.
 */
export async function runMessageSend(toId: string, content: string, projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    const message = store.sendMessage({
      fromId: CLI_USER_ID,
      fromType: "user",
      toId,
      toType: "agent",
      content,
      type: "user-to-agent",
    });

    console.log();
    console.log(`  ✓ Message sent: ${message.id}`);
    console.log(`    To: Agent ${toId}`);
    console.log();
  } finally {
    db.close();
  }
}

/**
 * Read and display a specific message.
 */
export async function runMessageRead(id: string, projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    const message = store.getMessage(id);

    if (!message) {
      console.error(`Message ${id} not found`);
      process.exit(1);
    }

    // Mark as read
    if (!message.read) {
      store.markAsRead(id);
    }

    const fromLabel = formatParticipant(message.fromId, message.fromType);
    const toLabel = formatParticipant(message.toId, message.toType);
    const timeStr = new Date(message.createdAt).toLocaleString();

    console.log();
    console.log(`  Message: ${message.id}`);
    console.log(`  Type:    ${message.type}`);
    console.log(`  From:    ${fromLabel}`);
    console.log(`  To:      ${toLabel}`);
    console.log(`  Time:    ${timeStr}`);
    console.log();
    console.log(`  ${message.content}`);
    console.log();
  } finally {
    db.close();
  }
}

/**
 * Delete a message.
 */
export async function runMessageDelete(id: string, projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    store.deleteMessage(id);

    console.log();
    console.log(`  ✓ Message ${id} deleted`);
    console.log();
  } finally {
    db.close();
  }
}

/**
 * View an agent's mailbox.
 */
export async function runAgentMailbox(agentId: string, projectName?: string): Promise<void> {
  const { store, db } = await createMessageStore(projectName);
  try {
    const mailbox = store.getMailbox(agentId, "agent");
    const messages = store.getInbox(agentId, "agent", { limit: 20 });

    console.log();
    console.log(`  🤖 Agent Mailbox: ${agentId} (${mailbox.unreadCount} unread)`);
    console.log();

    if (messages.length === 0) {
      console.log("  No messages");
      console.log();
      return;
    }

    for (const msg of messages) {
      const readMarker = msg.read ? "  " : "● ";
      const fromLabel = formatParticipant(msg.fromId, msg.fromType);
      const timeStr = formatTime(msg.createdAt);
      const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + "…" : msg.content;
      console.log(`  ${readMarker}From: ${fromLabel} — ${timeStr}`);
      console.log(`    ${preview}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatParticipant(id: string, type: ParticipantType): string {
  switch (type) {
    case "agent": return `Agent ${id}`;
    case "user": return id === "cli" ? "You (CLI)" : id === "dashboard" ? "You (Dashboard)" : `User ${id}`;
    case "system": return "System";
  }
}

function formatTime(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
