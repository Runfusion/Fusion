const CHAT_PENDING_MESSAGE_STORAGE_PREFIX = "fusion:chat-pending:";

export function getChatPendingMessageKey(sessionId: string | null | undefined): string | null {
  if (!sessionId) {
    return null;
  }

  return `${CHAT_PENDING_MESSAGE_STORAGE_PREFIX}${sessionId}`;
}

export function getPersistedPendingChatMessages(sessionId: string | null | undefined): string[] {
  const key = getChatPendingMessageKey(sessionId);
  if (!key || typeof window === "undefined") {
    return [];
  }

  try {
    const value = localStorage.getItem(key);
    if (!value) {
      return [];
    }

    /*
    FNXC:ChatComposer 2026-06-27-00:00:
    Queued chat messages persist as a JSON array so reloads retain FIFO order. Legacy single-string values are coerced to a one-item queue so pre-array in-flight messages are not dropped.
    */
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      }
    } catch {
      // Fall through to legacy single-string handling.
    }

    const legacyMessage = value.trim();
    return legacyMessage ? [legacyMessage] : [];
  } catch {
    return [];
  }
}

export function setPersistedPendingChatMessages(sessionId: string | null | undefined, messages: string[]): void {
  const key = getChatPendingMessageKey(sessionId);
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    const normalizedMessages = messages.filter((message) => message.trim().length > 0);
    if (normalizedMessages.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(normalizedMessages));
  } catch {
    // Ignore localStorage failures so chat queuing still works in-memory.
  }
}

export function removePersistedPendingChatMessages(sessionId: string | null | undefined): void {
  const key = getChatPendingMessageKey(sessionId);
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore localStorage failures so cleanup paths do not throw.
  }
}
