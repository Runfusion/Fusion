import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatAttachment } from "@fusion/core";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAT_TEXT_INLINE_LIMIT,
  formatChatAttachmentContents,
  formatChatImageAttachmentHints,
  readChatAttachmentContents,
} from "../chat-attachment-content.js";

const roots: string[] = [];
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50]);
const UNKNOWN_IMAGE_BYTES = Buffer.from([0x01, 0x02, 0x03, 0x04]);

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

  it("converts matching image attachments to base64 content blocks", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "image.png"), PNG_BYTES);
    const expectedPath = join(root, ".fusion", "chat-attachments", "session-1", "image.png");

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "image.png", originalName: "image.png", mimeType: "image/png", size: PNG_BYTES.length }),
    ]);

    expect(result.attachmentContents).toEqual([
      { originalName: "image.png", mimeType: "image/png", text: null },
    ]);
    expect(result.imageContents).toEqual([
      {
        type: "image",
        data: PNG_BYTES.toString("base64"),
        mimeType: "image/png",
        path: expectedPath,
        originalName: "image.png",
      },
    ]);
    expect(formatChatAttachmentContents(result.attachmentContents)).toBe("");
    expect(formatChatImageAttachmentHints(result.imageContents)).toContain(expectedPath);
    expect(formatChatImageAttachmentHints(result.imageContents)).toContain("vision/file tools");
  });

  it("corrects session webp-labeled PNG image blocks to image/png", async () => {
    const root = await makeRoot();
    const diagnostics = { warn: vi.fn() };
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "mismatch.webp"), PNG_BYTES);

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "mismatch.webp", originalName: "mismatch.webp", mimeType: "image/webp", size: PNG_BYTES.length }),
    ], diagnostics);

    expect(result.attachmentContents).toEqual([{ originalName: "mismatch.webp", mimeType: "image/webp", text: null }]);
    expect(result.imageContents).toEqual([
      {
        type: "image",
        data: PNG_BYTES.toString("base64"),
        mimeType: "image/png",
        path: join(root, ".fusion", "chat-attachments", "session-1", "mismatch.webp"),
        originalName: "mismatch.webp",
      },
    ]);
    expect(diagnostics.warn).toHaveBeenCalledWith(expect.stringContaining("from image/webp to image/png"));
  });

  it("corrects room png-labeled WEBP image blocks to image/webp", async () => {
    const root = await makeRoot();
    const diagnostics = { warn: vi.fn() };
    await mkdir(join(root, ".fusion", "chat-room-attachments", "room-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-room-attachments", "room-1", "mismatch.png"), WEBP_BYTES);

    const result = await readChatAttachmentContents(root, { kind: "room", roomId: "room-1" }, [
      attachment({ filename: "mismatch.png", originalName: "mismatch.png", mimeType: "image/png", size: WEBP_BYTES.length }),
    ], diagnostics);

    expect(result.attachmentContents).toEqual([{ originalName: "mismatch.png", mimeType: "image/png", text: null }]);
    expect(result.imageContents).toEqual([
      {
        type: "image",
        data: WEBP_BYTES.toString("base64"),
        mimeType: "image/webp",
        path: join(root, ".fusion", "chat-room-attachments", "room-1", "mismatch.png"),
        originalName: "mismatch.png",
      },
    ]);
    expect(diagnostics.warn).toHaveBeenCalledWith(expect.stringContaining("room room-1 from image/png to image/webp"));
  });

  it("falls back to stored image mime type for unrecognized session bytes", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".fusion", "chat-attachments", "session-1"), { recursive: true });
    await writeFile(join(root, ".fusion", "chat-attachments", "session-1", "unknown.webp"), UNKNOWN_IMAGE_BYTES);

    const result = await readChatAttachmentContents(root, { kind: "session", sessionId: "session-1" }, [
      attachment({ filename: "unknown.webp", originalName: "unknown.webp", mimeType: "image/webp", size: UNKNOWN_IMAGE_BYTES.length }),
    ]);

    expect(result.attachmentContents).toEqual([{ originalName: "unknown.webp", mimeType: "image/webp", text: null }]);
    expect(result.imageContents).toEqual([
      {
        type: "image",
        data: UNKNOWN_IMAGE_BYTES.toString("base64"),
        mimeType: "image/webp",
        path: join(root, ".fusion", "chat-attachments", "session-1", "unknown.webp"),
        originalName: "unknown.webp",
      },
    ]);
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
      {
        type: "image",
        data: Buffer.from("webp").toString("base64"),
        mimeType: "image/webp",
        path: join(root, ".fusion", "chat-room-attachments", "room-1", "photo.webp"),
        originalName: "photo.webp",
      },
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
