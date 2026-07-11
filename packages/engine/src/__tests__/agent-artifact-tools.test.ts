import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, ArtifactType, ArtifactWithTask, MessageStore, TaskStore } from "@fusion/core";
import { DASHBOARD_USER_ID } from "@fusion/core";
import {
  createArtifactListTool,
  createArtifactRegisterTool,
  createArtifactViewTool,
  createChatArtifactTools,
} from "../agent-tools.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>());
});

const TASK_ID = "FN-6778";
const AUTHOR_ID = "agent-007";
const PNG_IMAGE_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

type ArtifactStore = Pick<TaskStore, "registerArtifact" | "getArtifact" | "listArtifacts">;

type ArtifactMessageStore = Pick<MessageStore, "sendMessage">;

function createMockArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-1",
    type: "document",
    title: "Implementation notes",
    description: "Artifact description",
    mimeType: "text/markdown",
    content: "# Notes\nInline content",
    authorId: AUTHOR_ID,
    authorType: "agent",
    taskId: TASK_ID,
    createdAt: "2026-06-21T06:50:00.000Z",
    updatedAt: "2026-06-21T06:50:00.000Z",
    ...overrides,
  };
}

function createMockStore(overrides: Partial<ArtifactStore> = {}) {
  const registerArtifact = vi.fn<ArtifactStore["registerArtifact"]>();
  const getArtifact = vi.fn<ArtifactStore["getArtifact"]>();
  const listArtifacts = vi.fn<ArtifactStore["listArtifacts"]>();

  const store: TaskStore = {
    registerArtifact,
    getArtifact,
    listArtifacts,
    ...overrides,
  } as unknown as TaskStore;

  return { store, registerArtifact, getArtifact, listArtifacts };
}

function createMockMessageStore() {
  const sendMessage = vi.fn<ArtifactMessageStore["sendMessage"]>((input) => ({
    id: "msg-1",
    ...input,
    fromId: input.fromId ?? "system",
    read: false,
    createdAt: "2026-06-21T06:50:00.000Z",
    updatedAt: "2026-06-21T06:50:00.000Z",
  }));
  const messageStore = { sendMessage } as unknown as MessageStore;
  return { messageStore, sendMessage };
}

async function runTool(
  tool: { execute: (...args: any[]) => Promise<any> },
  callId: string,
  params: Record<string, unknown>,
) {
  return tool.execute(callId, params, undefined as any, undefined as any, undefined as any);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}



type RealTaskStoreModule = typeof import("@fusion/core");

async function createRealTaskStore() {
  const { TaskStore: RealTaskStore } = await vi.importActual<RealTaskStoreModule>("@fusion/core");
  const rootDir = mkdtempSync(join(tmpdir(), "agent-artifact-tools-root-"));
  const globalDir = mkdtempSync(join(tmpdir(), "agent-artifact-tools-global-"));
  const store = new RealTaskStore(rootDir, globalDir, { inMemoryDb: true });
  await store.init();
  return { store, rootDir, globalDir };
}

function getArtifactId(result: any): string {
  const artifactId = result?.details?.artifactId;
  expect(typeof artifactId).toBe("string");
  return artifactId;
}

const ARTIFACT_TYPES: ArtifactType[] = ["document", "image", "video", "audio", "other"];

function mimeFor(type: ArtifactType, variant: "content" | "uri" | "dataBase64"): string {
  if (variant === "dataBase64") return "image/png";
  if (variant === "content") return type === "document" ? "text/markdown" : "text/plain";
  switch (type) {
    case "document": return "application/pdf";
    case "image": return "image/png";
    case "video": return "video/mp4";
    case "audio": return "audio/mpeg";
    case "other": return "application/octet-stream";
  }
}

function findChatTool(name: "fn_artifact_register" | "fn_artifact_list" | "fn_artifact_view", store: TaskStore, messageStore?: MessageStore) {
  const tool = createChatArtifactTools(store, messageStore).find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("artifact register tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decodes base64 image bytes before calling store.registerArtifact", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({
      id: "art-image",
      type: "image",
      title: "Screenshot",
      mimeType: "image/png",
      uri: "artifacts/screenshot.png",
      content: undefined,
    }));

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-register-image", {
      type: "image",
      title: "Screenshot",
      mimeType: "image/png",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
      taskId: TASK_ID,
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      type: "image",
      title: "Screenshot",
      mimeType: "image/png",
      taskId: TASK_ID,
      content: undefined,
      uri: undefined,
      data: PNG_IMAGE_BYTES,
    }));
    expect(getText(result)).toContain("Registered artifact");
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("rejects empty, non-image, and arbitrary-byte base64 payloads without registering", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID);

    const emptyResult = await runTool(tool, "call-empty-image", {
      type: "image",
      title: "Empty screenshot",
      mimeType: "image/png",
      dataBase64: "   ",
      taskId: TASK_ID,
    });
    const documentResult = await runTool(tool, "call-document-base64", {
      type: "document",
      title: "Document bytes",
      mimeType: "text/plain",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
      taskId: TASK_ID,
    });
    const arbitraryBytesResult = await runTool(tool, "call-arbitrary-image", {
      type: "image",
      title: "Text pretending to be PNG",
      mimeType: "image/png",
      dataBase64: Buffer.from("not-a-real-png").toString("base64"),
      taskId: TASK_ID,
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(emptyResult)).toContain("dataBase64 must decode to non-empty artifact bytes");
    expect(getText(documentResult)).toContain("dataBase64 is only supported for image artifacts");
    expect(getText(arbitraryBytesResult)).toContain("dataBase64 must decode to valid image bytes matching mimeType");
  });

  it("returns an ERROR response without registering malformed base64 image payloads", async () => {
    const { store, registerArtifact } = createMockStore();

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-register-invalid-image", {
      type: "image",
      title: "Broken screenshot",
      mimeType: "image/png",
      dataBase64: "not valid base64!",
      taskId: TASK_ID,
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("ERROR: Failed to register artifact");
    expect(getText(result)).toContain("dataBase64 must be valid base64");
  });

  it("requires an image MIME type for base64 image registration", async () => {
    const { store, registerArtifact } = createMockStore();

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-register-missing-mime", {
      type: "image",
      title: "No MIME screenshot",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
      taskId: TASK_ID,
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("image artifacts registered with dataBase64 require an image/* mimeType");
  });

  it("calls store.registerArtifact with mapped agent author input", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-register" }));

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-register", {
      type: "document",
      title: "Implementation notes",
      description: "A markdown report",
      mimeType: "text/markdown",
      content: "# Report",
      taskId: TASK_ID,
    });

    expect(registerArtifact).toHaveBeenCalledWith({
      type: "document",
      title: "Implementation notes",
      description: "A markdown report",
      mimeType: "text/markdown",
      uri: undefined,
      content: "# Report",
      authorId: AUTHOR_ID,
      authorType: "agent",
      taskId: TASK_ID,
    });
    expect(getText(result)).toContain("Registered artifact");
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("sends exactly one system-to-user inbox notification with artifact metadata", async () => {
    const { store, registerArtifact } = createMockStore();
    const artifact = createMockArtifact({ id: "art-notify", type: "image", title: "Screenshot", uri: "artifacts/screenshot.png", content: undefined });
    registerArtifact.mockResolvedValue(artifact);
    const { messageStore, sendMessage } = createMockMessageStore();

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, messageStore);
    await runTool(tool, "call-notify", {
      type: "image",
      title: "Screenshot",
      uri: "artifacts/screenshot.png",
      taskId: TASK_ID,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromType: "system",
      toType: "user",
      toId: DASHBOARD_USER_ID,
      type: "system",
      metadata: expect.objectContaining({
        artifactId: "art-notify",
        artifactType: "image",
        title: "Screenshot",
        authorId: AUTHOR_ID,
        taskId: TASK_ID,
      }),
    }));
  });

  it("still succeeds when notification sendMessage throws", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-best-effort" }));
    const { messageStore, sendMessage } = createMockMessageStore();
    sendMessage.mockImplementation(() => {
      throw new Error("inbox unavailable");
    });

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, messageStore);
    const result = await runTool(tool, "call-best-effort", {
      type: "document",
      title: "Best effort artifact",
      content: "body",
    });

    expect(registerArtifact).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getText(result)).toContain("Registered artifact");
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("succeeds with no message store provided", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-no-message-store" }));

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-no-message-store", {
      type: "document",
      title: "No notification",
      content: "body",
    });

    expect(registerArtifact).toHaveBeenCalledTimes(1);
    expect(getText(result)).toContain("Registered artifact");
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("returns ERROR-prefixed text for store failures", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockRejectedValue(new Error("database temporarily unavailable"));

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-store-error", {
      type: "document",
      title: "Broken artifact",
      content: "body",
    });

    expect(getText(result)).toContain("ERROR: Failed to register artifact");
    expect(getText(result)).toContain("database temporarily unavailable");
  });
});

/*
FNXC:ArtifactRegistry 2026-07-10-14:30:
Agents save screenshots/wireframes/mocks as files in their worktree; `path` registration is the practical ingestion route (inline base64 for real screenshots is impractical). These tests pin: worktree-relative resolution via baseDir, defaultTaskId fallback for executor-lane runs, MIME inference from extension, image signature validation (including SVG text sniff), and payload-source exclusivity.
*/
describe("artifact register tool path payloads", () => {
  let baseDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    baseDir = mkdtempSync(join(tmpdir(), "agent-artifact-path-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("registers an image from a worktree-relative path with inferred mimeType and default task", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-path", type: "image", mimeType: "image/png", content: undefined, uri: "artifacts/after.png" }));
    mkdirSync(join(baseDir, "screenshots"), { recursive: true });
    writeFileSync(join(baseDir, "screenshots", "after.png"), PNG_IMAGE_BYTES);

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    const result = await runTool(tool, "call-path-relative", {
      type: "image",
      title: "After screenshot",
      path: "screenshots/after.png",
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      type: "image",
      title: "After screenshot",
      mimeType: "image/png",
      taskId: TASK_ID,
      data: PNG_IMAGE_BYTES,
    }));
    expect(getText(result)).toContain("Registered artifact");
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("prefers an explicit taskId over the defaultTaskId", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-path-explicit", type: "image", taskId: "FN-9999" }));
    writeFileSync(join(baseDir, "shot.png"), PNG_IMAGE_BYTES);

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    await runTool(tool, "call-path-explicit-task", {
      type: "image",
      title: "Explicit task screenshot",
      path: "shot.png",
      taskId: "FN-9999",
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-9999" }));
  });

  it("registers an absolute-path SVG wireframe via text sniffing", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-svg", type: "image", mimeType: "image/svg+xml", content: undefined, uri: "artifacts/wireframe.svg" }));
    const svgPath = join(baseDir, "wireframe.svg");
    writeFileSync(svgPath, `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>`);

    const tool = createArtifactRegisterTool(store, AUTHOR_ID);
    const result = await runTool(tool, "call-path-svg", {
      type: "image",
      title: "Login wireframe",
      path: svgPath,
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/svg+xml" }));
    expect(getText(result)).not.toContain("ERROR:");
  });

  it("rejects a missing file, non-image bytes for image type, and unknown extensions without mimeType", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir });
    writeFileSync(join(baseDir, "fake.png"), "not a real png");
    writeFileSync(join(baseDir, "blob.xyz"), "opaque bytes");

    const missingResult = await runTool(tool, "call-path-missing", { type: "image", title: "Missing", path: "nope.png" });
    const fakeResult = await runTool(tool, "call-path-fake", { type: "image", title: "Fake PNG", path: "fake.png" });
    const unknownResult = await runTool(tool, "call-path-unknown", { type: "other", title: "Blob", path: "blob.xyz" });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(missingResult)).toContain("does not exist or is not readable");
    expect(getText(fakeResult)).toContain("does not contain valid image bytes");
    expect(getText(unknownResult)).toContain("Could not infer a MIME type");
  });

  it("rejects combining path with other payload sources", async () => {
    const { store, registerArtifact } = createMockStore();
    writeFileSync(join(baseDir, "shot.png"), PNG_IMAGE_BYTES);
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir });

    const result = await runTool(tool, "call-path-conflict", {
      type: "image",
      title: "Conflicting payloads",
      path: "shot.png",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("path cannot be combined with uri, content, or dataBase64");
  });

  it("rejects combining content with uri", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir });

    const result = await runTool(tool, "call-content-uri-conflict", {
      type: "document",
      title: "Conflicting payloads",
      content: "# inline",
      uri: "https://example.com/doc.md",
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("provide exactly one artifact payload source: content, uri, dataBase64, or path");
  });

  /*
  FNXC:ArtifactRegistry 2026-07-11-10:05:
  Containment coverage: `path` must never read files outside the session workspace directory or
  the OS temp directory (realpath-canonicalized, so `../` and symlink escapes are caught), and
  no-baseDir lanes must reject relative paths instead of resolving against process.cwd().
  macOS note: tmpdir() is /var/folders/... which realpaths to /private/var/...; these tests rely
  on the implementation comparing canonical roots.
  */
  it("rejects a relative path that escapes the baseDir via ../ segments", async () => {
    const { store, registerArtifact } = createMockStore();
    const outsideDir = mkdtempSync(join(tmpdir(), "agent-artifact-outside-"));
    try {
      writeFileSync(join(outsideDir, "escape.png"), PNG_IMAGE_BYTES);
      const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });

      const result = await runTool(tool, "call-path-escape", {
        type: "image",
        title: "Escaped screenshot",
        path: join("..", outsideDir.split("/").pop()!, "escape.png"),
      });

      expect(registerArtifact).not.toHaveBeenCalled();
      expect(getText(result)).toContain("escapes the session workspace directory");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink inside the baseDir that targets a file outside the allowed roots", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    const outsideTarget = join(process.cwd(), "package.json");
    symlinkSync(outsideTarget, join(baseDir, "sneaky.json"));

    const result = await runTool(tool, "call-symlink-escape", {
      type: "document",
      title: "Sneaky symlink",
      path: "sneaky.json",
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("escapes the session workspace directory");
  });

  it("rejects an absolute path outside both baseDir and the OS temp directory, naming the allowed roots", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    // package.json of the engine package: exists, but lives outside tmpdir and outside baseDir.
    const outsideAbsolute = join(process.cwd(), "package.json");

    const result = await runTool(tool, "call-absolute-outside", {
      type: "document",
      title: "Server file grab",
      path: outsideAbsolute,
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("outside the allowed roots");
    expect(getText(result)).toContain("OS temp directory");
  });

  it("rejects a relative path when no baseDir is configured instead of resolving against process.cwd()", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID);

    const result = await runTool(tool, "call-relative-no-basedir", {
      type: "image",
      title: "CWD-relative screenshot",
      path: "package.json",
    });

    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(result)).toContain("relative path requires a workspace directory");
  });

  it("accepts an absolute path under the OS temp directory when no baseDir is configured", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-tmp", type: "image", mimeType: "image/png", content: undefined }));
    const captureDir = mkdtempSync(join(tmpdir(), "agent-artifact-capture-"));
    try {
      const capturePath = join(captureDir, "capture.png");
      writeFileSync(capturePath, PNG_IMAGE_BYTES);
      const tool = createArtifactRegisterTool(store, AUTHOR_ID);

      const result = await runTool(tool, "call-absolute-tmpdir", {
        type: "image",
        title: "Temp-dir capture",
        path: capturePath,
        taskId: TASK_ID,
      });

      expect(getText(result)).toContain("Registered artifact");
      expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        data: PNG_IMAGE_BYTES,
      }));
    } finally {
      rmSync(captureDir, { recursive: true, force: true });
    }
  });

  it("registers video media from path with extension-inferred mimeType and container signature validation", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-video", type: "video", mimeType: "video/mp4", content: undefined, uri: "artifacts/demo.mp4" }));
    // Minimal ISO BMFF header: 4-byte box size then "ftyp".
    const mp4Bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42-demo-recording")]);
    writeFileSync(join(baseDir, "demo.mp4"), mp4Bytes);

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    const result = await runTool(tool, "call-path-video", {
      type: "video",
      title: "Feature demo recording",
      path: "demo.mp4",
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      type: "video",
      mimeType: "video/mp4",
      taskId: TASK_ID,
      data: mp4Bytes,
    }));
    expect(getText(result)).not.toContain("ERROR:");
  });

  /*
  FNXC:ArtifactRegistry 2026-07-11-10:20:
  Video and PDF path payloads are signature-gated like images so the gallery never receives an unplayable "video" or unrenderable "PDF"; WebM validates via its EBML header, mp4/mov via the ftyp box, PDFs via the %PDF- prefix.
  */
  it("rejects renamed junk for video and pdf payloads but accepts valid containers", async () => {
    const { store, registerArtifact } = createMockStore();
    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir });
    writeFileSync(join(baseDir, "fake.mp4"), "not a real video");
    writeFileSync(join(baseDir, "fake.pdf"), "not a real pdf");
    writeFileSync(join(baseDir, "real.webm"), Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.from("webm-body")]));
    writeFileSync(join(baseDir, "real.pdf"), "%PDF-1.4\nminimal pdf body");

    const fakeVideo = await runTool(tool, "call-fake-video", { type: "video", title: "Fake video", path: "fake.mp4" });
    const fakePdf = await runTool(tool, "call-fake-pdf", { type: "document", title: "Fake PDF", path: "fake.pdf" });
    expect(registerArtifact).not.toHaveBeenCalled();
    expect(getText(fakeVideo)).toContain("does not contain valid video bytes");
    expect(getText(fakePdf)).toContain("does not contain valid PDF bytes");

    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-webm", type: "video", mimeType: "video/webm", content: undefined, uri: "artifacts/real.webm" }));
    const realWebm = await runTool(tool, "call-real-webm", { type: "video", title: "Real WebM", path: "real.webm" });
    expect(getText(realWebm)).not.toContain("ERROR:");

    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-pdf", type: "document", mimeType: "application/pdf", content: undefined, uri: "artifacts/real.pdf" }));
    const realPdf = await runTool(tool, "call-real-pdf", { type: "document", title: "Real PDF", path: "real.pdf" });
    expect(getText(realPdf)).not.toContain("ERROR:");
    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "application/pdf" }));
  });

  it("registers an HTML mockup from path with text/html mimeType inferred", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-html", type: "document", mimeType: "text/html", content: undefined, uri: "artifacts/mock.html" }));
    writeFileSync(join(baseDir, "mock.html"), "<!doctype html><html><body><h1>Login mock</h1></body></html>");

    const tool = createArtifactRegisterTool(store, AUTHOR_ID, undefined, { baseDir, defaultTaskId: TASK_ID });
    const result = await runTool(tool, "call-path-html", {
      type: "document",
      title: "Login page mockup",
      path: "mock.html",
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      type: "document",
      mimeType: "text/html",
      taskId: TASK_ID,
    }));
    expect(getText(result)).not.toContain("ERROR:");
  });
});

describe("artifact list tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cross-agent results and forwards filters", async () => {
    const { store, listArtifacts } = createMockStore();
    const artifacts: ArtifactWithTask[] = [
      createMockArtifact({ id: "art-a", authorId: "agent-a", title: "Alpha", taskId: "FN-100" }) as ArtifactWithTask,
      { ...createMockArtifact({ id: "art-b", type: "image", authorId: "agent-b", title: "Beta", taskId: "FN-200", content: undefined, uri: "artifacts/beta.png" }), taskTitle: "Render screenshot" },
    ];
    listArtifacts.mockResolvedValue(artifacts);

    const tool = createArtifactListTool(store);
    const result = await runTool(tool, "call-list", {
      type: "image",
      authorId: "agent-b",
      taskId: "FN-200",
      search: "screenshot",
      limit: 10,
      offset: 5,
    });

    expect(listArtifacts).toHaveBeenCalledWith({
      type: "image",
      authorId: "agent-b",
      taskId: "FN-200",
      search: "screenshot",
      limit: 10,
      offset: 5,
    });
    expect(getText(result)).toContain("art-a [document] Alpha");
    expect(getText(result)).toContain("author: agent-a");
    expect(getText(result)).toContain("art-b [image] Beta");
    expect(getText(result)).toContain("FN-200 (Render screenshot)");
  });

  it("returns empty-state text when no artifacts match", async () => {
    const { store, listArtifacts } = createMockStore();
    listArtifacts.mockResolvedValue([]);

    const tool = createArtifactListTool(store);
    const result = await runTool(tool, "call-list-empty", {});

    expect(listArtifacts).toHaveBeenCalledWith({
      type: undefined,
      authorId: undefined,
      taskId: undefined,
      search: undefined,
      limit: undefined,
      offset: undefined,
    });
    expect(getText(result)).toBe("No artifacts found.");
  });

  it("returns ERROR-prefixed text when listArtifacts throws", async () => {
    const { store, listArtifacts } = createMockStore();
    listArtifacts.mockRejectedValue(new Error("artifact index offline"));

    const tool = createArtifactListTool(store);
    const result = await runTool(tool, "call-list-error", { search: "offline" });

    expect(listArtifacts).toHaveBeenCalledWith(expect.objectContaining({ search: "offline" }));
    expect(getText(result)).toContain("ERROR: Failed to list artifacts");
    expect(getText(result)).toContain("artifact index offline");
  });
});

describe("artifact view tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders inline content artifacts", async () => {
    const { store, getArtifact } = createMockStore();
    getArtifact.mockResolvedValue(createMockArtifact({ id: "art-inline", content: "Inline markdown body" }));

    const tool = createArtifactViewTool(store);
    const result = await runTool(tool, "call-view-inline", { id: "art-inline" });

    expect(getArtifact).toHaveBeenCalledWith("art-inline");
    expect(getText(result)).toContain("Artifact: Implementation notes");
    expect(getText(result)).toContain("Inline markdown body");
  });

  it("renders binary uri artifacts", async () => {
    const { store, getArtifact } = createMockStore();
    getArtifact.mockResolvedValue(createMockArtifact({
      id: "art-binary",
      type: "image",
      title: "Screenshot",
      content: undefined,
      uri: "artifacts/screenshot.png",
      sizeBytes: 2048,
    }));

    const tool = createArtifactViewTool(store);
    const result = await runTool(tool, "call-view-binary", { id: "art-binary" });

    expect(getText(result)).toContain("Artifact: Screenshot");
    expect(getText(result)).toContain("URI: artifacts/screenshot.png");
    expect(getText(result)).toContain("Size: 2048 bytes");
  });

  it("returns not-found text when artifact is missing", async () => {
    const { store, getArtifact } = createMockStore();
    getArtifact.mockResolvedValue(null);

    const tool = createArtifactViewTool(store);
    const result = await runTool(tool, "call-view-missing", { id: "missing-artifact" });

    expect(getArtifact).toHaveBeenCalledWith("missing-artifact");
    expect(getText(result)).toContain("Artifact \"missing-artifact\" not found.");
  });

  it("returns ERROR-prefixed text when getArtifact throws", async () => {
    const { store, getArtifact } = createMockStore();
    getArtifact.mockRejectedValue(new Error("DB read timeout"));

    const tool = createArtifactViewTool(store);
    const result = await runTool(tool, "call-view-error", { id: "art-failing" });

    expect(getArtifact).toHaveBeenCalledWith("art-failing");
    expect(getText(result)).toContain('ERROR: Failed to view artifact "art-failing"');
    expect(getText(result)).toContain("DB read timeout");
  });
});

describe("chat artifact tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes canonical artifact tool names for chat agents", () => {
    const { store } = createMockStore();

    expect(createChatArtifactTools(store).map((tool) => tool.name)).toEqual([
      "fn_artifact_register",
      "fn_artifact_list",
      "fn_artifact_view",
    ]);
  });

  it("registers with explicit task_id, decoded image bytes, and fixed dashboard-chat author", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({
      id: "art-chat-image",
      authorId: "dashboard-chat",
      taskId: "FN-3030",
      type: "image",
      title: "Chat screenshot",
      mimeType: "image/png",
      uri: "artifacts/chat-screenshot.png",
      content: undefined,
    }));
    const { messageStore } = createMockMessageStore();

    const tool = findChatTool("fn_artifact_register", store, messageStore);
    const result = await runTool(tool, "call-chat-register-image", {
      task_id: "FN-3030",
      type: "image",
      title: "Chat screenshot",
      mimeType: "image/png",
      dataBase64: PNG_IMAGE_BYTES.toString("base64"),
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-3030",
      authorId: "dashboard-chat",
      authorType: "agent",
      title: "Chat screenshot",
      data: PNG_IMAGE_BYTES,
    }));
    expect(getText(result)).toContain("Registered artifact");
  });

  it("registers with explicit task_id and fixed dashboard-chat author", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-chat", authorId: "dashboard-chat", taskId: "FN-3030" }));
    const { messageStore, sendMessage } = createMockMessageStore();

    const tool = findChatTool("fn_artifact_register", store, messageStore);
    const result = await runTool(tool, "call-chat-register", {
      task_id: "FN-3030",
      type: "document",
      title: "Chat artifact",
      content: "created from chat",
    });

    expect(registerArtifact).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-3030",
      authorId: "dashboard-chat",
      authorType: "agent",
      title: "Chat artifact",
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ authorId: "dashboard-chat", taskId: "FN-3030" }),
    }));
    expect(getText(result)).toContain("Registered artifact");
  });

  it("lists artifacts for the explicit task_id", async () => {
    const { store, listArtifacts } = createMockStore();
    listArtifacts.mockResolvedValue([
      { ...createMockArtifact({ id: "art-chat-list", taskId: "FN-4040", title: "Chat list artifact" }), taskTitle: "Chat target" },
    ]);

    const tool = findChatTool("fn_artifact_list", store);
    const result = await runTool(tool, "call-chat-list", {
      task_id: "FN-4040",
      type: "document",
      authorId: "dashboard-chat",
      search: "Chat",
      limit: 3,
      offset: 1,
    });

    expect(listArtifacts).toHaveBeenCalledWith({
      type: "document",
      authorId: "dashboard-chat",
      taskId: "FN-4040",
      search: "Chat",
      limit: 3,
      offset: 1,
    });
    expect(getText(result)).toContain("art-chat-list [document] Chat list artifact");
  });

  it("passes view calls through to getArtifact", async () => {
    const { store, getArtifact } = createMockStore();
    getArtifact.mockResolvedValue(createMockArtifact({ id: "art-chat-view", title: "Chat view" }));

    const tool = findChatTool("fn_artifact_view", store);
    const result = await runTool(tool, "call-chat-view", { id: "art-chat-view" });

    expect(getArtifact).toHaveBeenCalledWith("art-chat-view");
    expect(getText(result)).toContain("Artifact: Chat view");
  });

  it("returns clean errors for non-existent explicit task registration", async () => {
    const { store, registerArtifact } = createMockStore();
    registerArtifact.mockRejectedValue(new Error("Task FN-404 not found"));

    const tool = findChatTool("fn_artifact_register", store);
    const result = await runTool(tool, "call-chat-register-error", {
      task_id: "FN-404",
      type: "document",
      title: "No target",
      content: "body",
    });

    expect(getText(result)).toContain("ERROR: Failed to register artifact \"No target\"");
    expect(getText(result)).toContain("Task FN-404 not found");
  });

  it("returns clean errors for non-existent explicit task list", async () => {
    const { store, listArtifacts } = createMockStore();
    listArtifacts.mockRejectedValue(new Error("Task FN-405 not found"));

    const tool = findChatTool("fn_artifact_list", store);
    const result = await runTool(tool, "call-chat-list-error", { task_id: "FN-405" });

    expect(getText(result)).toContain("ERROR: Failed to list artifacts");
    expect(getText(result)).toContain("Task FN-405 not found");
  });
});

describe("artifact tool factory integration", () => {
  it("uses the provided store instance across register, list, and view tools", async () => {
    const { store, registerArtifact, getArtifact, listArtifacts } = createMockStore();
    registerArtifact.mockResolvedValue(createMockArtifact({ id: "art-integration" }));
    getArtifact.mockResolvedValue(createMockArtifact({ id: "art-integration" }));
    listArtifacts.mockResolvedValue([createMockArtifact({ id: "art-integration" }) as ArtifactWithTask]);

    await runTool(createArtifactRegisterTool(store, AUTHOR_ID), "call-integration-register", {
      type: "document",
      title: "Integration artifact",
      content: "body",
    });
    await runTool(createArtifactListTool(store), "call-integration-list", {});
    await runTool(createArtifactViewTool(store), "call-integration-view", { id: "art-integration" });

    expect(registerArtifact).toHaveBeenCalledTimes(1);
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(getArtifact).toHaveBeenCalledTimes(1);
  });
});


describe("artifact tools real-store create/list/view invariant", () => {
  let realStore: TaskStore | null = null;
  let rootDir: string | null = null;
  let globalDir: string | null = null;

  afterEach(() => {
    realStore?.close();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    if (globalDir) rmSync(globalDir, { recursive: true, force: true });
    realStore = null;
    rootDir = null;
    globalDir = null;
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-09-17:35:
   * FN-7764 exists because operators need concrete confidence that artifact creation and viewing work for every supported type and payload variant, not only the previously verified image path. This real-store matrix pins the agent and dashboard-chat tool contract from registration through list/view output so future changes cannot silently break non-image artifact discovery.
   */
  it("creates every artifact type and supported variant through agent and chat tools, then lists and views them", async () => {
    const created = await createRealTaskStore();
    realStore = created.store as unknown as TaskStore;
    rootDir = created.rootDir;
    globalDir = created.globalDir;
    const task = await realStore.createTask({ title: "FN-7764 artifact matrix", description: "Exercise artifact tool invariant" });
    const agentRegister = createArtifactRegisterTool(realStore, AUTHOR_ID);
    const agentList = createArtifactListTool(realStore);
    const agentView = createArtifactViewTool(realStore);
    const chatRegister = findChatTool("fn_artifact_register", realStore);
    const expected: Array<{ id: string; type: ArtifactType; title: string; variant: "content" | "uri" | "dataBase64"; authorId: string }> = [];

    for (const surface of ["agent", "chat"] as const) {
      for (const type of ARTIFACT_TYPES) {
        const contentTitle = `${surface} ${type} inline content`;
        const contentParams = {
          type,
          title: contentTitle,
          description: `${type} inline artifact created by ${surface}`,
          mimeType: mimeFor(type, "content"),
          content: `# ${contentTitle}\nInline ${type} evidence for FN-7764.`,
          ...(surface === "agent" ? { taskId: task.id } : { task_id: task.id }),
        };
        const contentResult = await runTool(surface === "agent" ? agentRegister : chatRegister, `${surface}-${type}-content`, contentParams);
        expect(getText(contentResult)).toContain("Registered artifact");
        expected.push({ id: getArtifactId(contentResult), type, title: contentTitle, variant: "content", authorId: surface === "agent" ? AUTHOR_ID : "dashboard-chat" });

        const uriTitle = `${surface} ${type} uri reference`;
        const uriParams = {
          type,
          title: uriTitle,
          description: `${type} uri artifact created by ${surface}`,
          mimeType: mimeFor(type, "uri"),
          uri: `artifacts/${surface}-${type}-reference.bin`,
          ...(surface === "agent" ? { taskId: task.id } : { task_id: task.id }),
        };
        const uriResult = await runTool(surface === "agent" ? agentRegister : chatRegister, `${surface}-${type}-uri`, uriParams);
        expect(getText(uriResult)).toContain("Registered artifact");
        expected.push({ id: getArtifactId(uriResult), type, title: uriTitle, variant: "uri", authorId: surface === "agent" ? AUTHOR_ID : "dashboard-chat" });
      }

      const imageTitle = `${surface} image dataBase64 bytes`;
      const dataResult = await runTool(surface === "agent" ? agentRegister : chatRegister, `${surface}-image-dataBase64`, {
        type: "image",
        title: imageTitle,
        description: `PNG bytes created by ${surface}`,
        mimeType: "image/png",
        dataBase64: PNG_IMAGE_BYTES.toString("base64"),
        ...(surface === "agent" ? { taskId: task.id } : { task_id: task.id }),
      });
      expect(getText(dataResult)).toContain("Registered artifact");
      expected.push({ id: getArtifactId(dataResult), type: "image", title: imageTitle, variant: "dataBase64", authorId: surface === "agent" ? AUTHOR_ID : "dashboard-chat" });
    }

    const listResult = await runTool(agentList, "matrix-list-all", { taskId: task.id, limit: 50 });
    const listText = getText(listResult);
    for (const item of expected) {
      expect(listText).toContain(`${item.id} [${item.type}] ${item.title}`);
      const viewResult = await runTool(agentView, `view-${item.id}`, { id: item.id });
      const viewText = getText(viewResult);
      expect(viewText).toContain(`Artifact: ${item.title}`);
      expect(viewText).toContain(`Type: ${item.type}`);
      expect(viewText).toContain(`Author: ${item.authorId} (agent)`);
      expect(viewText).toContain(`Task: ${task.id}`);
      if (item.variant === "content") {
        expect(viewText).toContain(`Inline ${item.type} evidence for FN-7764.`);
      } else {
        expect(viewText).toContain("URI: artifacts/");
        expect(viewText).not.toContain("Inline ");
      }
    }

    const imageFilter = await runTool(agentList, "matrix-list-image", { taskId: task.id, type: "image", limit: 20 });
    const imageText = getText(imageFilter);
    expect(imageText).toContain("[image]");
    expect(imageText).not.toContain("[audio]");

    const chatFilter = await runTool(agentList, "matrix-list-chat", { taskId: task.id, authorId: "dashboard-chat", search: "dataBase64", limit: 10 });
    expect(getText(chatFilter)).toContain("dashboard-chat");
    expect(getText(chatFilter)).toContain("image dataBase64 bytes");
  });
});
