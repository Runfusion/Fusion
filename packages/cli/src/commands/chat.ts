import { AgentStore } from "@fusion/core";
import type { Message } from "@fusion/core";
import { createMessageStore, formatParticipant, formatTime, CLI_USER_ID } from "./message.js";
import { resolveAgentStoreBase } from "../project-context.js";
import { createInterface } from "node:readline/promises";

const MAX_MESSAGE_LENGTH = 8192;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_REPLY_TIMEOUT_MS = 60_000;
const HISTORY_LIMIT = 20;

/**
 * FNXC:CliChatConversation 2026-07-20-12:00:
 * CLI chats use a durable MessageStore thread per CLI-user/agent pair.
 */
export function buildCliChatConversationId(agentId: string, override?: string): string {
  return override ?? `cli-chat:${CLI_USER_ID}:${agentId}`;
}

export interface ChatInteractiveOptions {
  project?: string;
  conversationId?: string;
  pollIntervalMs?: number;
  replyTimeoutMs?: number;
  once?: boolean;
  nonInteractive?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

interface PendingReply {
  outboundMessageId: string;
  sentAt: number;
  deadlineAt: number;
  preview: string;
}

export type ChatCliArgs = Pick<ChatInteractiveOptions, "conversationId" | "pollIntervalMs" | "replyTimeoutMs" | "once" | "nonInteractive"> & {
  agentId: string;
  contentArg: string;
};

/** Parse chat-only argv after the `chat` command for dispatch and unit tests. */
export function parseChatCliArgs(args: string[]): ChatCliArgs | { error: string } {
  const usage = "Usage: fn chat <agent-id> [message…] [--once] [--non-interactive] [--poll-ms <n>] [--reply-timeout-ms <n>] [--conversation-id <id>]";
  const agentId = args[0];
  if (!agentId) return { error: usage };
  const readPositiveFlag = (flag: string) => {
    const index = args.indexOf(flag);
    const value = index === -1 ? undefined : args[index + 1];
    const parsed = value === undefined ? undefined : Number.parseInt(value, 10);
    return { index, parsed, valid: index === -1 || (!!value && !value.startsWith("--") && Number.isFinite(parsed) && (parsed ?? 0) > 0) };
  };
  const poll = readPositiveFlag("--poll-ms");
  const timeout = readPositiveFlag("--reply-timeout-ms");
  if (!poll.valid || !timeout.valid) return { error: usage };
  let conversationId: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--conversation-id") continue;
    const value = args[index + 1];
    if (conversationId !== undefined || !value || value.startsWith("--")) return { error: usage };
    conversationId = value;
    index += 1;
  }
  const flagsWithValues = new Set(["--poll-ms", "--reply-timeout-ms", "--conversation-id"]);
  const contentArg = args.slice(1).filter((arg, index, values) =>
    arg !== "--once" && arg !== "--non-interactive" && !flagsWithValues.has(arg)
      && !(index > 0 && flagsWithValues.has(values[index - 1] ?? "")),
  ).join(" ").trim();
  return { agentId, conversationId, pollIntervalMs: poll.parsed, replyTimeoutMs: timeout.parsed, contentArg,
    once: args.includes("--once") || contentArg.length > 0,
    nonInteractive: args.includes("--non-interactive") || contentArg.length > 0 };
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

function parsePositiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : fallback;
}

function parsePollMs(options: ChatInteractiveOptions): number {
  const envValue = process.env.FUSION_CHAT_POLL_MS;
  const envPollMs = envValue ? Number.parseInt(envValue, 10) : Number.NaN;
  return parsePositiveMs(options.pollIntervalMs ?? envPollMs, DEFAULT_POLL_MS);
}

function parseReplyTimeoutMs(options: ChatInteractiveOptions): number {
  const envValue = process.env.FUSION_CHAT_REPLY_TIMEOUT_MS;
  const envTimeoutMs = envValue ? Number.parseInt(envValue, 10) : Number.NaN;
  return parsePositiveMs(options.replyTimeoutMs ?? envTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS);
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
  for (const message of messages) printMessage(output, message);
}

/**
 * FNXC:CliChatConversation 2026-07-20-14:30:
 * Participant queries are not conversation-scoped; only thread-tagged mail or
 * replies to known thread messages may be displayed or marked read.
 */
function collectConversationMessages(messages: Message[], conversationId: string, threadMessageIds = new Set<string>()): Message[] {
  const includedIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (includedIds.has(message.id)) continue;
      const directMatch = message.metadata?.conversationId === conversationId;
      const replyMatch = typeof message.metadata?.replyTo?.messageId === "string" && threadMessageIds.has(message.metadata.replyTo.messageId);
      if (!threadMessageIds.has(message.id) && !directMatch && !replyMatch) continue;
      includedIds.add(message.id);
      if (!threadMessageIds.has(message.id)) { threadMessageIds.add(message.id); changed = true; }
    }
  }
  return messages.filter((message) => includedIds.has(message.id));
}

function isConversationReply(message: Message, conversationId: string, threadMessageIds: Set<string>): boolean {
  return collectConversationMessages([message], conversationId, threadMessageIds).length > 0;
}

function isCliReply(message: Message, agentId: string): boolean {
  return message.fromId === agentId
    && message.fromType === "agent"
    && message.toId === CLI_USER_ID
    && message.toType === "user";
}

function replyToId(message: Message): string | undefined {
  return message.metadata?.replyTo?.messageId;
}

function findPendingReply(pendingReplies: Map<string, PendingReply>, message: Message): PendingReply | undefined {
  const threaded = replyToId(message);
  if (threaded) return pendingReplies.get(threaded);
  // Replies without metadata retain useful behavior by consuming the oldest open request once.
  return [...pendingReplies.values()].sort((a, b) => a.sentAt - b.sentAt)[0];
}

async function getChatReplies(
  messageStore: Awaited<ReturnType<typeof createMessageStore>>["store"],
  agentId: string,
  conversationId: string,
  threadMessageIds: Set<string>,
): Promise<Message[]> {
  // Conversation lookup sees replies already marked read by another CLI process; inbox keeps the normal unread path cheap.
  const [conversation, inbox] = await Promise.all([
    messageStore.getConversation({ id: CLI_USER_ID, type: "user" }, { id: agentId, type: "agent" }, { limit: 50 }),
    messageStore.getInbox(CLI_USER_ID, "user", { limit: 50 }),
  ]);
  const messages = new Map<string, Message>();
  for (const message of [...conversation, ...inbox]) {
    if (isCliReply(message, agentId) && isConversationReply(message, conversationId, threadMessageIds)) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function sleep(ms: number, signal?: AbortSignal, wake?: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void wake?.then(done);
  });
}

export async function waitForReply(
  messageStore: Awaited<ReturnType<typeof createMessageStore>>["store"],
  agentId: string,
  printedIds: Set<string>,
  output: NodeJS.WritableStream,
  pollIntervalMs: number,
  timeoutMs: number,
  conversationId: string,
  threadMessageIds: Set<string>,
): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    for (const message of await getChatReplies(messageStore, agentId, conversationId, threadMessageIds)) {
      if (printedIds.has(message.id)) continue;
      printedIds.add(message.id);
      printMessage(output, message);
      await messageStore.markAsRead(message.id);
      return true;
    }

    const remainingTimeoutMs = Math.max(0, deadlineAt - Date.now());
    if (remainingTimeoutMs === 0) return false;
    /*
    FNXC:CliChatReplyRouting 2026-07-20-12:00:
    A user-selected poll interval must not postpone a one-shot reply timeout.
    Bound every sleep to the remaining deadline so --poll-ms 300000 still exits
    at the configured reply timeout rather than minutes later.
    */
    await sleep(Math.min(pollIntervalMs, remainingTimeoutMs));
  }
}

function expirePendingReplies(pendingReplies: Map<string, PendingReply>, output: NodeJS.WritableStream, now: number): void {
  for (const [id, pending] of pendingReplies) {
    if (now < pending.deadlineAt) continue;
    pendingReplies.delete(id);
    output.write(`No reply within ${Math.ceil((pending.deadlineAt - pending.sentAt) / 1000)}s for: ${pending.preview}\n`);
  }
}

function nearestPendingSleep(pendingReplies: Map<string, PendingReply>, pollIntervalMs: number, now: number): number {
  const nearestDeadline = Math.min(...[...pendingReplies.values()].map((pending) => pending.deadlineAt));
  return Number.isFinite(nearestDeadline)
    ? Math.min(pollIntervalMs, Math.max(0, nearestDeadline - now))
    : pollIntervalMs;
}

export async function runChatInteractive(agentId: string, options: ChatInteractiveOptions = {}): Promise<number> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const pollIntervalMs = parsePollMs(options);
  const replyTimeoutMs = parseReplyTimeoutMs(options);
  const conversationId = buildCliChatConversationId(agentId, options.conversationId);

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
    const threadMessageIds = new Set<string>();
    const tail = collectConversationMessages(conversation, conversationId, threadMessageIds).slice(-HISTORY_LIMIT);
    for (const message of tail) printedIds.add(message.id);

    output.write(`Mailbox conversation with Agent ${agentId} — type /exit or Ctrl-C to quit, /help for commands\n`);
    output.write(`conversation-id: ${conversationId}\n`);
    output.write("Delivery: agent inbox (fn_read_messages). Not a dashboard chat session or multi-agent room.\n");
    output.write("Replies appear when this project's engine is running (fn dashboard or fn serve).\n");
    printConversationTail(output, tail);

    if (options.once === true) {
      const content = await readSingleMessage(input, output, options.nonInteractive);
      if (!content.trim()) return 0;
      if (content.length > MAX_MESSAGE_LENGTH) {
        console.error(`Message too long; max ${MAX_MESSAGE_LENGTH} chars`);
        return 0;
      }

      const outbound = await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content,
        type: "user-to-agent",
        metadata: { wakeRecipient: true, kind: "cli-chat", conversationId },
      });
      threadMessageIds.add(outbound.id);
      output.write(`you → ${agentId}: ${content}\n`);
      const replied = await waitForReply(messageStore, agentId, printedIds, output, pollIntervalMs, replyTimeoutMs, conversationId, threadMessageIds);
      if (!replied) console.error(`No reply within ${Math.ceil(replyTimeoutMs / 1000)}s`);
      return 0;
    }

    const abortController = new AbortController();
    const pendingReplies = new Map<string, PendingReply>();
    let wakePoller: (() => void) | undefined;
    const poller = (async () => {
      while (!abortController.signal.aborted) {
        for (const message of await getChatReplies(messageStore, agentId, conversationId, threadMessageIds)) {
          if (printedIds.has(message.id)) continue;
          printedIds.add(message.id);
          const pending = findPendingReply(pendingReplies, message);
          /*
          FNXC:CliChatReplyRouting 2026-07-20-12:00:
          Polling can wake exactly at a pending deadline after a reply was
          already persisted. Match replies created by that deadline before
          expiring requests, otherwise the terminal falsely prints a timeout
          immediately before the reply it has just retrieved.
          */
          if (pending && Date.parse(message.createdAt) <= pending.deadlineAt) {
            pendingReplies.delete(pending.outboundMessageId);
          }
          printMessage(output, message);
          await messageStore.markAsRead(message.id);
        }
        expirePendingReplies(pendingReplies, output, Date.now());
        const delay = nearestPendingSleep(pendingReplies, pollIntervalMs, Date.now());
        let resolveWake: (() => void) | undefined;
        const wake = new Promise<void>((resolve) => { resolveWake = resolve; });
        wakePoller = resolveWake;
        /*
        FNXC:CliChatReplyRouting 2026-07-20-12:00:
        Interactive chat owns independent pending deadlines. Wake a normal poll
        when a new outbound is registered, then cap its sleep at the nearest
        pending deadline; timing out one request only clears that entry and the
        REPL continues polling for later messages.
        */
        await sleep(delay, abortController.signal, wake);
        wakePoller = undefined;
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
        output.write(`Commands: /help, /history, /clear, /exit, /quit\nMailbox delivery to the agent inbox; conversation-id: ${conversationId}\n`);
        continue;
      }
      if (line === "/history") {
        const history = collectConversationMessages(await messageStore.getConversation(
          { id: CLI_USER_ID, type: "user" }, { id: agentId, type: "agent" },
        ), conversationId, threadMessageIds).slice(-HISTORY_LIMIT);
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

      const outbound = await messageStore.sendMessage({
        fromId: CLI_USER_ID,
        fromType: "user",
        toId: agentId,
        toType: "agent",
        content: line,
        type: "user-to-agent",
        metadata: { wakeRecipient: true, kind: "cli-chat", conversationId },
      });
      threadMessageIds.add(outbound.id);
      const sentAt = Date.now();
      pendingReplies.set(outbound.id, {
        outboundMessageId: outbound.id,
        sentAt,
        deadlineAt: sentAt + replyTimeoutMs,
        preview: line.length > 80 ? `${line.slice(0, 80)}…` : line,
      });
      wakePoller?.();
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
    try { agentStore.close(); } catch (error) { cleanupFailures.push(error); }
    try { await messageOwner?.db.close(); } catch (error) { cleanupFailures.push(error); }
    try { await ownedAgentStore.cleanup(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) {
      // eslint-disable-next-line no-unsafe-finally -- cleanup must aggregate with, rather than silently lose, the active command failure.
      throw new AggregateError(
        commandFailure === undefined ? cleanupFailures : [commandFailure, ...cleanupFailures],
        "Chat command cleanup failed",
      );
    }
  }
}

async function readSingleMessage(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, nonInteractive?: boolean): Promise<string> {
  if (nonInteractive) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8").trimEnd();
  }
  const rl = createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}
