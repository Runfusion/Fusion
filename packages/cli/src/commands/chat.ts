import { AgentStore } from "@fusion/core";
import type { Message } from "@fusion/core";
import { createMessageStore, formatParticipant, formatTime, CLI_USER_ID } from "./message.js";
import { resolveAgentStoreBase } from "../project-context.js";
import { createInterface } from "node:readline/promises";

const MAX_MESSAGE_LENGTH = 8192;
const DEFAULT_POLL_MS = 1000;
const HISTORY_LIMIT = 20;

export interface ChatInteractiveOptions {
  project?: string;
  pollIntervalMs?: number;
  replyTimeoutMs?: number;
  once?: boolean;
  nonInteractive?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/*
FNXC:PostgresCutover 2026-07-05-12:00:
Borrow the PostgreSQL AsyncDataLayer from the resolved project store so the
chat AgentStore runs in backend mode (the SQLite runtime was removed under
VAL-REMOVAL-005), mirroring agent.ts/extension.ts createAgentStore.
*/
async function createAgentStore(projectName?: string): Promise<{ store: AgentStore; cleanup: () => Promise<void> }> {
  const base = await resolveAgentStoreBase(projectName);
  const store = new AgentStore({ rootDir: `${base.rootDir}/.fusion`, asyncLayer: base.asyncLayer });
  try {
    await store.init();
    return { store, cleanup: base.cleanup };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      store.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await base.cleanup();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "AgentStore initialization and cleanup failed");
  }
}

function parsePollMs(options: ChatInteractiveOptions): number {
  const envValue = process.env.FUSION_CHAT_POLL_MS;
  const envPollMs = envValue ? Number.parseInt(envValue, 10) : Number.NaN;
  const candidate = options.pollIntervalMs ?? (Number.isFinite(envPollMs) ? envPollMs : DEFAULT_POLL_MS);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_POLL_MS;
}

function printMessage(output: NodeJS.WritableStream, message: Message): void {
  const fromLabel = formatParticipant(message.fromId, message.fromType);
  const time = formatTime(message.createdAt);
  output.write(`${fromLabel} — ${time}\n`);
  output.write(`${message.content}\n\n`);
}

function printConversationTail(output: NodeJS.WritableStream, messages: Message[]): void {
  if (messages.length === 0) {
    output.write("\nNo messages yet.\n\n");
    return;
  }

  output.write("\nRecent conversation:\n\n");
  for (const message of messages) {
    printMessage(output, message);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForReply(
  messageStore: Awaited<ReturnType<typeof createMessageStore>>["store"],
  agentId: string,
  printedIds: Set<string>,
  output: NodeJS.WritableStream,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const inbox = await messageStore.getInbox(CLI_USER_ID, "user", { limit: 50 });
    for (const message of inbox.slice().reverse()) {
      if (message.fromId !== agentId || message.fromType !== "agent") continue;
      if (printedIds.has(message.id)) continue;
      printedIds.add(message.id);
      printMessage(output, message);
      await messageStore.markAsRead(message.id);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

export async function runChatInteractive(agentId: string, options: ChatInteractiveOptions = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const pollIntervalMs = parsePollMs(options);

  const ownedAgentStore = await createAgentStore(options.project);
  const agentStore = ownedAgentStore.store;
  let messageOwner: Awaited<ReturnType<typeof createMessageStore>> | undefined;
  let commandFailure: unknown;
  try {
    const agent = await agentStore.getAgent(agentId);
    if (!agent) {
      console.error(`Agent ${agentId} not found`);
      return 1;
    }

    messageOwner = await createMessageStore(options.project);
    const messageStore = messageOwner.store;
    const printedIds = new Set<string>();

    const conversation = await messageStore.getConversation(
    { id: CLI_USER_ID, type: "user" },
    { id: agentId, type: "agent" },
  );
    const tail = conversation.slice(-HISTORY_LIMIT);
    for (const message of tail) printedIds.add(message.id);

    output.write(`Chat with Agent ${agentId} — type /exit or Ctrl-C to quit, /help for commands\n`);
    output.write("Replies appear when this project's engine is running (fn dashboard or fn serve).\n");
    printConversationTail(output, tail);

    const runOnce = options.once === true;
    if (runOnce) {
      const content = await readSingleMessage(input, output, options.nonInteractive);
      if (!content.trim()) return 0;

      if (content.length > MAX_MESSAGE_LENGTH) {
        console.error(`Message too long; max ${MAX_MESSAGE_LENGTH} chars`);
        return 0;
      }

      await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content,
        type: "user-to-agent",
        metadata: { wakeRecipient: true },
      });

      output.write(`you → ${agentId}: ${content}\n`);
      const timeoutMs = options.replyTimeoutMs ?? Math.max(pollIntervalMs * 10, 30_000);
      const replied = await waitForReply(messageStore, agentId, printedIds, output, pollIntervalMs, timeoutMs);
      if (!replied) {
        console.error(`No reply within ${Math.ceil(timeoutMs / 1000)}s`);
      }
      return 0;
    }

    const abortController = new AbortController();
    const poller = (async () => {
      while (!abortController.signal.aborted) {
        const inbox = await messageStore.getInbox(CLI_USER_ID, "user", { limit: 50 });
        for (const message of inbox.slice().reverse()) {
          if (message.fromId !== agentId || message.fromType !== "agent") continue;
          if (printedIds.has(message.id)) continue;
          printedIds.add(message.id);
          printMessage(output, message);
          await messageStore.markAsRead(message.id);
        }
        await sleep(pollIntervalMs, abortController.signal);
      }
    })().catch(() => undefined);

    const rl = createInterface({ input, output });
    rl.on("close", () => abortController.abort());

    while (true) {
      let line: string;
      try {
        line = (await rl.question("> ")).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        output.write("Commands: /help, /history, /clear, /exit, /quit\n");
        continue;
      }
      if (line === "/history") {
        const history = (await messageStore.getConversation(
          { id: CLI_USER_ID, type: "user" },
          { id: agentId, type: "agent" },
        )).slice(-HISTORY_LIMIT);
        for (const message of history) printedIds.add(message.id);
        printConversationTail(output, history);
        continue;
      }
      if (line === "/clear") {
        output.write("\x1b[2J\x1b[H");
        continue;
      }
      if (line.length > MAX_MESSAGE_LENGTH) {
        console.error(`Message too long; max ${MAX_MESSAGE_LENGTH} chars`);
        continue;
      }

      await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content: line,
        type: "user-to-agent",
        metadata: { wakeRecipient: true },
      });
      output.write(`you → ${agentId}: ${line}\n`);
    }

    abortController.abort();
    rl.close();
    await poller;
    return 0;
  } catch (error) {
    commandFailure = error;
    throw error;
  } finally {
    /* FNXC:PostgresCliLifecycle 2026-07-14-22:55: Chat owns three independently-failing resources. Always attempt AgentStore, message database, and borrowed project teardown; report all cleanup failures without discarding an earlier command failure. */
    const cleanupFailures: unknown[] = [];
    try {
      agentStore.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await messageOwner?.db.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await ownedAgentStore.cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      // eslint-disable-next-line no-unsafe-finally -- cleanup must aggregate with, rather than silently lose, the active command failure.
      throw new AggregateError(
        commandFailure === undefined ? cleanupFailures : [commandFailure, ...cleanupFailures],
        "Chat command cleanup failed",
      );
    }
  }
}

async function readSingleMessage(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  nonInteractive?: boolean,
): Promise<string> {
  if (nonInteractive) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8").trimEnd();
  }

  const rl = createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}
