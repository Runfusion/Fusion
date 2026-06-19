import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatAttachment } from "@fusion/core";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAT_TEXT_INLINE_LIMIT,
  formatChatAttachmentContents,
  readChatAttachmentContents,
} from "../chat-attachment-content.js";

const roots: string[] = [];

function attachment(overrides: Partial<ChatAttachment>): ChatAttachment {
  return {
    id: "att-1",
    filename: "note.txt",
    originalName: "note.txt",
    mimeType: "text/plain",
    size: 4,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ChatAttachment;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fn-chat-attachment-content-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readChatAttachmentContents", () => {
  it("inlines text attachments from the session storage root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "note.txt"), "hello from attachment");

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "note.txt", originalName: "note.txt", mimeType: "text/plain" }),
    ]);

    expect(result.imageContents).toEqual([]);
    expect(result.attachmentContents).toEqual([
      { originalName: "note.txt", mimeType: "text/plain", text: "hello from attachment" },
    ]);
    expect(formatChatAttachmentContents(result.attachmentContents)).toContain("hello from attachment");
  });

  it("converts image attachments to base64 content blocks", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "image.png"), Buffer.from([1, 2, 3, 4]));

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "image.png", originalName: "image.png", mimeType: "image/png", size: 4 }),
    ]);

    expect(result.attachmentContents).toEqual([
      { originalName: "image.png", mimeType: "image/png", text: null },
    ]);
    expect(result.imageContents).toEqual([
      { type: "image", data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "image/png" },
    ]);
    expect(formatChatAttachmentContents(result.attachmentContents)).toBe("");
  });

  it("returns mixed text and image contents together", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-room-attachments", "room-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-room-attachments", "room-1", "data.json"), "{\"ok\":true}");
    await writeFile(join(root, ".fusion", "chat-room-attachments", "room-1", "photo.webp"), Buffer.from("webp"));

    const result = await readChatAttachmentContents(root, { kind: "room", roomId: "room-1" }, [
      attachment({ id: "att-text", filename: "data.json", originalName: "data.json", mimeType: "application/json" }),
      attachment({ id: "att-image", filename: "photo.webp", originalName: "photo.webp", mimeType: "image/webp" }),
    ]);

    expect(formatChatAttachmentContents(result.attachmentContents)).toContain("```json\n{\"ok\":true}\n```");
    expect(result.imageContents).toEqual([
      { type: "image", data: Buffer.from("webp").toString("base64"), mimeType: "image/webp" },
    ]);
  });

  it("skips missing files with a warning", async () => {
    const root = await makeRoot();
    const diagnostics = { warn: vi.fn() };

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "missing.txt", originalName: "missing.txt" }),
    ], diagnostics);

    expect(result).toEqual({ attachmentContents: [], imageContents: [] });
    expect(diagnostics.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to read chat attachment 'missing.txt'"));
  });

  it("truncates oversized text attachments at the triage-compatible limit", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "large.txt"), "a".repeat(CHAT_TEXT_INLINE_LIMIT + 10));

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "large.txt", originalName: "large.txt" }),
    ]);

    expect(result.attachmentContents[0]?.text).toHaveLength(CHAT_TEXT_INLINE_LIMIT + "\n... (truncated at 50KB)".length);
    expect(result.attachmentContents[0]?.text?.endsWith("\n... (truncated at 50KB)")).toBe(true);
  });

  it("uses basename-safe filenames instead of traversing outside the attachment root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "safe.txt"), "safe content");
    await writeFile(join(root, ".fusion", "chat-attachments", "outside.txt"), "outside content");

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "../safe.txt", originalName: "unsafe-name.txt" }),
    ]);

    expect(result.attachmentContents[0]?.text).toBe("safe content");
  });

  it("reads room attachments from the room storage root, not the session root", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "room-1"), { recursive: true });
    await mkdir(join(root, ".fusion", "chat-room-attachments", "room-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "room-1", "note.txt"), "wrong root");
    await writeFile(join(root, ".fusion", "chat-room-attachments", "room-1", "note.txt"), "right room root");

    const result = await readChatAttachmentContents(root, { kind: "room", roomId: "room-1" }, [
      attachment({ filename: "note.txt", originalName: "note.txt" }),
    ]);

    expect(result.attachmentContents[0]?.text).toBe("right room root");
  });
});
