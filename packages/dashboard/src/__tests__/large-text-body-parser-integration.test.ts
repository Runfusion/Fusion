// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";

const scopedChatManager = vi.hoisted(() => ({ current: undefined as never }));
vi.mock("../chat-project-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat-project-services.js")>();
  return {
    ...actual,
    getOrCreateScopedChatManager: () => scopedChatManager.current,
    createProjectScopedChatManager: async () => scopedChatManager.current,
  };
});

import { createServer } from "../server.js";
import { MAX_FILE_SIZE } from "../file-service.js";
import { chatStreamManager } from "../chat.js";
import { request } from "../test-request.js";

const LARGE_LOG = "2026-08-21T04:35:00Z INFO repeated log line\n".repeat(3_000).trimEnd();
const LARGE_TASK_MESSAGE = "é".repeat(60_000);
const largeJson = (content = LARGE_LOG) => JSON.stringify({ content });
const taskMessageJson = (field: "text" | "feedback") => JSON.stringify({ [field]: LARGE_TASK_MESSAGE });

/** Minimal production-stack store: route tests intentionally use createServer, not a router. */
class LargeTextParserStore extends EventEmitter {
  private readonly task: { id: string; column: string; worktree: string; comments: never[]; steeringComments: never[] };

  constructor(private readonly rootDir: string) {
    super();
    this.task = { id: "task-1", column: "todo", worktree: rootDir, comments: [], steeringComments: [] };
  }

  getRootDir() { return this.rootDir; }
  getFusionDir() { return join(this.rootDir, ".fusion"); }
  getSettings = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getSettingsFast = this.getSettings;
  getGlobalSettingsStore = () => ({ getSettings: async () => ({}) });
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTask = vi.fn(async () => this.task);
  addSteeringComment = vi.fn(async () => this.task);
  addTaskComment = vi.fn(async () => this.task);
  updateTaskComment = vi.fn(async () => this.task);
  refineTask = vi.fn(async () => ({ ...this.task, id: "task-2" }));
  logEntry = vi.fn(async () => undefined);
  updateTask = vi.fn(async () => this.task);
  moveTask = vi.fn(async () => this.task);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
}

const roots: string[] = [];
afterEach(async () => {
  chatStreamManager.reset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function app() {
  const root = await mkdtemp(join(tmpdir(), "fusion-large-text-"));
  roots.push(root);
  const store = new LargeTextParserStore(root);
  const chatStore = {
    getSession: vi.fn(async (id: string) => {
      if (id === "session-1") return { id, agentId: "__fn_agent__", projectId: null };
      if (id === "planner-session") return { id, agentId: "task-planner:task-1", projectId: null };
      return undefined;
    }),
    getRoom: vi.fn(async (id: string) => id === "room-1" ? { id, projectId: null } : undefined),
  };
  const chatManager = {
    prepareReplacement: vi.fn(async () => ({ generationId: 1 })),
    beginGeneration: vi.fn(() => ({ generationId: 2, abortController: new AbortController() })),
    isGenerating: vi.fn(() => false),
    sendMessage: vi.fn(async (sessionId: string, content: string, _provider: unknown, _model: unknown, _attachments: unknown, options: { generationId?: number }) => {
      chatStreamManager.broadcast(sessionId, { type: "done", data: { messageId: "assistant-1" } }, { generationId: options.generationId });
    }),
    sendRoomMessage: vi.fn(async (_roomId: string, content: string) => ({ userMessage: { id: "room-message-1", content } })),
  };
  scopedChatManager.current = chatManager as never;
  return {
    root,
    store,
    chatManager,
    app: createServer(store as unknown as TaskStore, {
      noAuth: true,
      chatStore: chatStore as never,
      chatManager: chatManager as never,
    }),
  };
}

/**
 * FNXC:LargeTextPayloads 2026-08-21-04:35:
 * These requests boot the complete server middleware stack because registrar tests cannot prove
 * that the central 100 KiB parser admits only the finite chat and file-save envelopes.
 */
describe("large-text body parser integration", () => {
  it("delivers an exact over-100-KiB log once through direct, planner, and room chat", async () => {
    const server = await app();
    const body = largeJson();
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2 * 1024 * 1024);

    const direct = await request(server.app, "POST", "/api/chat/sessions/session-1/messages", body, { "content-type": "application/json" });
    const planner = await request(server.app, "POST", "/api/chat/sessions/planner-session/messages", JSON.stringify({ content: LARGE_LOG, taskId: "task-1" }), { "content-type": "application/json" });
    const room = await request(server.app, "POST", "/api/chat/rooms/room-1/messages/", body, { "content-type": "application/json" });

    expect(direct.status).toBe(200);
    expect(planner.status).toBe(200);
    expect(room.status).toBe(201);
    expect(server.chatManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(server.chatManager.sendMessage).toHaveBeenNthCalledWith(1, "session-1", LARGE_LOG, undefined, undefined, undefined, { generationId: 2 });
    expect(server.chatManager.sendMessage).toHaveBeenNthCalledWith(2, "planner-session", LARGE_LOG, undefined, undefined, undefined, { generationId: 2 });
    expect(server.chatManager.sendRoomMessage).toHaveBeenCalledTimes(1);
    expect(server.chatManager.sendRoomMessage).toHaveBeenCalledWith("room-1", LARGE_LOG, undefined);
    expect((room.body as { message: { content: string } }).message.content).toBe(LARGE_LOG);
  });

  it("delivers over-100-KiB task messages through each exact task-message route", async () => {
    const server = await app();
    const textBody = taskMessageJson("text");
    const feedbackBody = taskMessageJson("feedback");
    expect(LARGE_TASK_MESSAGE).toHaveLength(60_000);
    expect(Buffer.byteLength(textBody)).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(textBody)).toBeLessThanOrEqual(2 * 1024 * 1024);

    const steer = await request(server.app, "POST", "/api/tasks/task-1/steer/", textBody, { "content-type": "application/json" });
    const comment = await request(server.app, "POST", "/api/tasks/task-1/comments", textBody, { "content-type": "application/json" });
    const editComment = await request(server.app, "PATCH", "/api/tasks/task-1/comments/comment-1/", textBody, { "content-type": "application/json" });
    const refine = await request(server.app, "POST", "/api/tasks/task-1/refine", feedbackBody, { "content-type": "application/json" });
    const revise = await request(server.app, "POST", "/api/tasks/task-1/spec/revise", feedbackBody, { "content-type": "application/json" });

    expect(steer.status).toBe(200);
    expect(comment.status).toBe(200);
    expect(editComment.status).toBe(200);
    expect(refine.status).toBe(201);
    expect(revise.status).toBe(200);
    expect(server.store.addSteeringComment).toHaveBeenCalledWith("task-1", LARGE_TASK_MESSAGE, "user");
    expect(server.store.addTaskComment).toHaveBeenCalledWith("task-1", LARGE_TASK_MESSAGE, "user");
    expect(server.store.updateTaskComment).toHaveBeenCalledWith("task-1", "comment-1", LARGE_TASK_MESSAGE);
    expect(server.store.refineTask).toHaveBeenCalledWith("task-1", LARGE_TASK_MESSAGE);
    expect(server.store.logEntry).toHaveBeenCalledWith("task-1", "AI spec revision requested", LARGE_TASK_MESSAGE);
  });

  it("keeps the task-message transport envelope at 2 MiB", async () => {
    const server = await app();
    const body = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);

    const response = await request(server.app, "POST", "/api/tasks/task-1/steer", body, { "content-type": "application/json" });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "payload-too-large" });
    expect(server.store.addSteeringComment).not.toHaveBeenCalled();
  });

  it("persists over-100-KiB workspace saves exactly, including encoded paths and operation-named files", async () => {
    const server = await app();
    const body = largeJson();
    await mkdir(join(server.root, "src"));
    const encodedPath = await request(server.app, "POST", "/api/files/src%2Fcopy?workspace=project", body, { "content-type": "application/json" });
    const operationNamedFile = await request(server.app, "POST", "/api/files/copy?workspace=project", body, { "content-type": "application/json" });

    expect(encodedPath.status).toBe(200);
    expect(operationNamedFile.status).toBe(200);
    expect(await readFile(join(server.root, "src", "copy"), "utf8")).toBe(LARGE_LOG);
    expect(await readFile(join(server.root, "copy"), "utf8")).toBe(LARGE_LOG);
  });

  it("persists the worst-case escaped 1 MiB content through workspace and task saves", async () => {
    const server = await app();
    const content = "\0".repeat(MAX_FILE_SIZE);
    const body = JSON.stringify({ content });
    const fileLimit = 6 * MAX_FILE_SIZE + 1024;
    expect(Buffer.byteLength(content, "utf8")).toBe(MAX_FILE_SIZE);
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(fileLimit);

    const workspace = await request(server.app, "POST", "/api/files/escaped.txt?workspace=project", body, { "content-type": "application/json" });
    const taskFile = await request(server.app, "POST", "/api/tasks/task-1/files/escaped-task.txt", body, { "content-type": "application/json" });
    expect(workspace.status).toBe(200);
    expect(taskFile.status).toBe(200);
    expect(await readFile(join(server.root, "escaped.txt"))).toEqual(Buffer.from(content));
    expect(await readFile(join(server.root, "escaped-task.txt"))).toEqual(Buffer.from(content));
  });

  it("keeps the 1 MiB file-service cap and finite transport envelope separate", async () => {
    const server = await app();
    const applicationTooLarge = "x".repeat(MAX_FILE_SIZE + 1);
    const applicationBody = JSON.stringify({ content: applicationTooLarge });
    const transportLimit = 6 * MAX_FILE_SIZE + 1024;
    expect(Buffer.byteLength(applicationBody)).toBeLessThanOrEqual(transportLimit);

    const applicationResponse = await request(server.app, "POST", "/api/files/too-large.txt?workspace=project", applicationBody, { "content-type": "application/json" });
    expect(applicationResponse.status).toBe(413);

    const transportBody = JSON.stringify({ content: "", ignoredPadding: "x".repeat(transportLimit) });
    expect(Buffer.byteLength(transportBody)).toBeGreaterThan(transportLimit);
    const transportResponse = await request(server.app, "POST", "/api/files/transport-too-large.txt?workspace=project", transportBody, { "content-type": "application/json" });
    expect(transportResponse.status).toBe(413);
    expect(transportResponse.body).toEqual({ error: "payload-too-large" });
  });

  it.each([
    "/api/files/mkdir",
    "/api/files/mkdir/",
    "/api/files/src%2Findex.ts/copy",
    "/api/files/src%2Findex.ts/move/",
    "/api/files/src%2Findex.ts/delete",
    "/api/files/src%2Findex.ts/rename/",
    "/api/files",
    "/api/files-extra/save",
    "/api/chat/sessions/session-1/messages-extra",
    "/api/tasks/task-1/steer-extra",
    "/api/tasks/task-1/spec/rebuild",
  ])("keeps %s on the default 100-KiB parser", async (path) => {
    const server = await app();
    const response = await request(server.app, "POST", path, largeJson(), { "content-type": "application/json" });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "payload-too-large" });
  });

  it("keeps non-POST chat and file lookalikes on the default parser", async () => {
    const server = await app();
    for (const path of ["/api/chat/sessions/session-1/messages", "/api/files/large.txt"]) {
      const response = await request(server.app, "PUT", path, largeJson(), { "content-type": "application/json" });
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "payload-too-large" });
    }
  });

  it("rejects oversized replacement chat bodies before generation or rewind work", async () => {
    const server = await app();
    const body = JSON.stringify({ content: "x".repeat(2 * 1024 * 1024), replacementMessageId: "message-1" });
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
    const response = await request(server.app, "POST", "/api/chat/sessions/session-1/messages", body, { "content-type": "application/json" });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "payload-too-large" });
    expect(server.chatManager.prepareReplacement).not.toHaveBeenCalled();
    expect(server.chatManager.beginGeneration).not.toHaveBeenCalled();
    expect(server.chatManager.sendMessage).not.toHaveBeenCalled();
  });
});
