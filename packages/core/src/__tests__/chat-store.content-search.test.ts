import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ChatStore } from "../chat-store.js";
import { Database } from "../db.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-chat-store-content-search-test-"));
}

/*
FNXC:ChatSearch 2026-07-07-00:00:
Covers ChatStore.searchSessionsByMessageContent: matches driven purely by message content
(not title), dedup to one session per match, and LIKE-escape correctness for literal `%`/`_`.
*/
describe("ChatStore.searchSessionsByMessageContent", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: ChatStore;

  beforeAll(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new ChatStore(fusionDir, db);
  });

  beforeEach(() => {
    db.exec(`
      DELETE FROM chat_room_messages;
      DELETE FROM chat_room_members;
      DELETE FROM chat_rooms;
      DELETE FROM chat_messages;
      DELETE FROM chat_sessions;
    `);
    store.removeAllListeners();
  });

  afterAll(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestSession(title: string | null = "Untitled") {
    return store.createSession({
      agentId: "agent-001",
      title,
      projectId: null,
      modelProvider: null,
      modelId: null,
    });
  }

  it("matches a session by message content when the title does not contain the query", () => {
    const session = createTestSession("Weekend plans");
    store.addMessage(session.id, { role: "user", content: "Let's talk about the quarterly roadmap" });

    const result = store.searchSessionsByMessageContent("roadmap", [session.id]);

    expect(result.has(session.id)).toBe(true);
    expect(result.get(session.id)).toBe("Let's talk about the quarterly roadmap");
  });

  it("matches when the query appears only in a user message", () => {
    const session = createTestSession();
    store.addMessage(session.id, { role: "user", content: "Remember the unicorn codename" });
    store.addMessage(session.id, { role: "assistant", content: "Sure, noted." });

    const result = store.searchSessionsByMessageContent("unicorn", [session.id]);

    expect(result.get(session.id)).toBe("Remember the unicorn codename");
  });

  it("matches when the query appears only in an assistant message", () => {
    const session = createTestSession();
    store.addMessage(session.id, { role: "user", content: "How do I deploy?" });
    store.addMessage(session.id, { role: "assistant", content: "Use the falcon deploy script" });

    const result = store.searchSessionsByMessageContent("falcon", [session.id]);

    expect(result.get(session.id)).toBe("Use the falcon deploy script");
  });

  it("deduplicates to a single entry per session with multiple matching messages", () => {
    const session = createTestSession();
    store.addMessage(session.id, { role: "user", content: "first mention of gizmo" });
    store.addMessage(session.id, { role: "assistant", content: "second mention of gizmo here" });
    store.addMessage(session.id, { role: "user", content: "third gizmo reference, most recent" });

    const result = store.searchSessionsByMessageContent("gizmo", [session.id]);

    expect(result.size).toBe(1);
    expect(result.get(session.id)).toBe("third gizmo reference, most recent");
  });

  it("returns an empty map when there is no match", () => {
    const session = createTestSession();
    store.addMessage(session.id, { role: "user", content: "totally unrelated content" });

    const result = store.searchSessionsByMessageContent("nonexistent-term", [session.id]);

    expect(result.size).toBe(0);
  });

  it("returns an empty map for an empty/whitespace-only query", () => {
    const session = createTestSession();
    store.addMessage(session.id, { role: "user", content: "some content" });

    expect(store.searchSessionsByMessageContent("", [session.id]).size).toBe(0);
    expect(store.searchSessionsByMessageContent("   ", [session.id]).size).toBe(0);
  });

  it("returns an empty map when sessionIds is empty", () => {
    const result = store.searchSessionsByMessageContent("anything", []);
    expect(result.size).toBe(0);
  });

  it("treats literal % and _ as literal characters, not SQL LIKE wildcards", () => {
    const literalSession = createTestSession();
    store.addMessage(literalSession.id, { role: "user", content: "Discount is 50% off, use code A_B" });

    const otherSession = createTestSession();
    store.addMessage(otherSession.id, { role: "user", content: "Discount is 50X off, use code AZB" });

    // A naive unescaped LIKE '%50%%' would also match "50X" via the wildcard; escaped search must not.
    const percentResult = store.searchSessionsByMessageContent("50%", [literalSession.id, otherSession.id]);
    expect(percentResult.has(literalSession.id)).toBe(true);
    expect(percentResult.has(otherSession.id)).toBe(false);

    // A naive unescaped LIKE '%A_B%' would also match "AZB" via the single-char wildcard.
    const underscoreResult = store.searchSessionsByMessageContent("A_B", [literalSession.id, otherSession.id]);
    expect(underscoreResult.has(literalSession.id)).toBe(true);
    expect(underscoreResult.has(otherSession.id)).toBe(false);
  });

  it("only searches within the provided sessionIds scope", () => {
    const inScope = createTestSession();
    store.addMessage(inScope.id, { role: "user", content: "shared keyword hello" });

    const outOfScope = createTestSession();
    store.addMessage(outOfScope.id, { role: "user", content: "shared keyword hello" });

    const result = store.searchSessionsByMessageContent("keyword", [inScope.id]);

    expect(result.size).toBe(1);
    expect(result.has(inScope.id)).toBe(true);
    expect(result.has(outOfScope.id)).toBe(false);
  });
});
