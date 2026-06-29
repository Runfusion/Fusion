import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ArtifactWithTask, MessageStore, TaskStore } from "@fusion/core";
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
