import { describe, expect, it } from "vitest";
import { MessageStore } from "../stores/message-store.js";
import type { Message } from "../types/messaging/messages.js";

/**
 * FNXC:HeartbeatWakeDiscipline 2026-10-13 (STAS-300):
 * A heartbeat used to mark a recipient's WHOLE inbox as read while only showing the agent a capped
 * preview, so unread mail was silently consumed and the next wake delta under-reported the inbox.
 * Consumption is therefore scoped to the ids that were actually surfaced, and the store — not the
 * caller — decides which of those ids it really consumed: a row addressed to somebody else, a row
 * that is already read or archived, and a row that no longer exists must all come back unconsumed.
 */
type MutableStore = {
  getMessage: (id: string) => Promise<Message | null>;
  markAsRead: (id: string) => Promise<Message>;
};

function storeOverRows(rows: Message[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const marked: string[] = [];
  const store = Object.create(MessageStore.prototype) as unknown as MutableStore & MessageStore;

  store.getMessage = async (id: string) => byId.get(id) ?? null;
  store.markAsRead = async (id: string) => {
    const row = byId.get(id);
    if (!row) throw new Error(`Message ${id} not found`);
    row.read = true;
    marked.push(id);
    return row;
  };

  return { store: store as MessageStore & MutableStore, marked };
}

function row(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: "msg-1",
    fromId: "user-1",
    fromType: "user",
    toId: "agent-1",
    toType: "agent",
    content: "hello",
    type: "user-to-agent",
    read: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("MessageStore.markInboxAsRead", () => {
  it("consumes exactly the surfaced unread rows and reports them", async () => {
    const { store, marked } = storeOverRows([row({ id: "msg-1" }), row({ id: "msg-2" })]);

    await expect(store.markInboxAsRead("agent-1", "agent", ["msg-1", "msg-2"])).resolves.toEqual(["msg-1", "msg-2"]);
    expect(marked).toEqual(["msg-1", "msg-2"]);
  });

  it("leaves a row that was never surfaced untouched", async () => {
    const { store, marked } = storeOverRows([row({ id: "shown" }), row({ id: "hidden" })]);

    await expect(store.markInboxAsRead("agent-1", "agent", ["shown"])).resolves.toEqual(["shown"]);
    expect(marked).toEqual(["shown"]);
  });

  it("refuses to consume another recipient's row, an already-read row, an archived row, or a deleted row", async () => {
    const { store, marked } = storeOverRows([
      row({ id: "other-recipient", toId: "agent-2" }),
      row({ id: "other-recipient-type", toId: "agent-1", toType: "user" }),
      row({ id: "already-read", read: true }),
      row({ id: "archived", archived: true }),
    ]);

    await expect(
      store.markInboxAsRead("agent-1", "agent", ["other-recipient", "other-recipient-type", "already-read", "archived", "deleted"]),
    ).resolves.toEqual([]);
    expect(marked).toEqual([]);
  });

  it("treats the dashboard inbox aliases as the dashboard's own correspondence", async () => {
    const { store, marked } = storeOverRows([
      row({ id: "by-id", toId: "dashboard", toType: "user" }),
      row({ id: "by-alias", toId: "user:dashboard", toType: "user" }),
    ]);

    await expect(store.markInboxAsRead("dashboard", "user", ["by-id", "by-alias"])).resolves.toEqual(["by-id", "by-alias"]);
    expect(marked).toEqual(["by-id", "by-alias"]);
  });
});
