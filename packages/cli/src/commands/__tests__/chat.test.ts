import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { AgentStore, MessageStore, createDatabase } from "@fusion/core";

const mockResolveProject = vi.fn();

vi.mock("../../project-context.js", () => ({
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
}));

import { runChatInteractive } from "../chat.js";

function streamToString(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    stream.on("data", (chunk) => {
      text += chunk.toString();
    });
    stream.on("end", () => resolve(text));
  });
}

describe("runChatInteractive", () => {
  let projectDir: string;
  let agentId: string;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "fn-chat-"));
    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectPath: projectDir,
      projectName: "proj-1",
      isRegistered: true,
      store: {},
    });

    const agentStore = new AgentStore({ rootDir: join(projectDir, ".fusion") });
    await agentStore.init();
    const agent = await agentStore.createAgent({
      name: "Chat Agent",
      role: "executor",
      reportsTo: undefined,
    });
    agentId = agent.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function sendAgentReply(content: string, toId = "cli"): Promise<void> {
    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const messageStore = new MessageStore(db);
    messageStore.sendMessage({
      fromId: agentId,
      fromType: "agent",
      toId,
      toType: "user",
      content,
      type: "agent-to-user",
    });
    db.close();
  }

  it("sends a line as a user-to-agent message with wakeRecipient metadata", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputPromise = streamToString(output);

    const runPromise = runChatInteractive(agentId, { input, output, pollIntervalMs: 10 });
    input.write("hello\n");
    input.write("/exit\n");
    input.end();

    const code = await runPromise;
    output.end();
    await outputPromise;

    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const store = new MessageStore(db);
    const outbox = store.getOutbox("cli", "user", { limit: 20 });
    db.close();

    expect(code).toBe(0);
    expect(outbox[0]).toMatchObject({
      fromId: "cli",
      toId: agentId,
      type: "user-to-agent",
      content: "hello",
      metadata: { wakeRecipient: true },
    });
  });

  it("returns 1 for unknown agent and writes no message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runChatInteractive("agent-does-not-exist", {
      once: true,
      nonInteractive: true,
      input: Readable.from("hi"),
    });

    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const store = new MessageStore(db);
    const outbox = store.getOutbox("cli", "user", { limit: 20 });
    db.close();

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Agent agent-does-not-exist not found");
    expect(outbox).toHaveLength(0);
  });

  it("prints existing conversation tail on start", async () => {
    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const store = new MessageStore(db);
    store.sendMessage({
      fromId: "cli",
      fromType: "user",
      toId: agentId,
      toType: "agent",
      content: "first",
      type: "user-to-agent",
    });
    store.sendMessage({
      fromId: agentId,
      fromType: "agent",
      toId: "cli",
      toType: "user",
      content: "second",
      type: "agent-to-user",
    });
    db.close();

    const input = new PassThrough();
    const output = new PassThrough();
    const outputPromise = streamToString(output);

    const runPromise = runChatInteractive(agentId, { input, output, pollIntervalMs: 10 });
    input.write("/exit\n");
    input.end();

    await runPromise;
    output.end();
    const outputText = await outputPromise;
    expect(outputText).toContain("first");
    expect(outputText).toContain("second");
  });

  it("/exit ends loop cleanly", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runChatInteractive(agentId, { input, output, pollIntervalMs: 10 });
    input.write("/exit\n");
    input.end();

    await expect(runPromise).resolves.toBe(0);
  });

  it("poll loop prints new replies and marks them read", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputPromise = streamToString(output);

    const runPromise = runChatInteractive(agentId, { input, output, pollIntervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sendAgentReply("async reply");
    await new Promise((resolve) => setTimeout(resolve, 60));
    input.write("/exit\n");
    input.end();

    await runPromise;
    output.end();
    const outputText = await outputPromise;
    expect(outputText).toContain("async reply");

    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const store = new MessageStore(db);
    const inbox = store.getInbox("cli", "user", { limit: 20 });
    const reply = inbox.find((msg) => msg.content === "async reply");
    db.close();

    expect(reply?.read).toBe(true);
  });

  it("--once sends and waits for one reply", async () => {
    const output = new PassThrough();
    const outputPromise = streamToString(output);

    setTimeout(() => {
      void sendAgentReply("reply once");
    }, 50);

    const code = await runChatInteractive(agentId, {
      once: true,
      nonInteractive: true,
      input: Readable.from("one-shot"),
      output,
      pollIntervalMs: 10,
    });

    output.end();
    const outputText = await outputPromise;
    expect(code).toBe(0);
    expect(outputText).toContain(`you → ${agentId}: one-shot`);
    expect(outputText).toContain("reply once");
  });

  it("--once exits with timeout note when no reply arrives", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const input = new PassThrough();
    input.end("ping");

    const code = await runChatInteractive(agentId, {
      once: true,
      nonInteractive: true,
      input,
      output: new PassThrough(),
      pollIntervalMs: 1000,
    });

    expect(code).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith("No reply within 30s");
  }, 40_000);

  it("refuses oversized messages", async () => {
    const oversized = "x".repeat(8193);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runChatInteractive(agentId, {
      once: true,
      nonInteractive: true,
      input: Readable.from(oversized),
      output: new PassThrough(),
      pollIntervalMs: 5,
    });

    const db = createDatabase(join(projectDir, ".fusion"));
    db.init();
    const store = new MessageStore(db);
    const outbox = store.getOutbox("cli", "user", { limit: 20 });
    db.close();

    expect(code).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith("Message too long; max 8192 chars");
    expect(outbox).toHaveLength(0);
  });
});
