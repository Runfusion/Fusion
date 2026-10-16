/*
STAS-259: a read that failed must not be handed to the agent as ordinary payload text.

`AgentLogger.onToolEnd` records `tool_error` only when the result carries `isError`, so an unflagged store failure
is indistinguishable, in the card's own log, from a read that succeeded. `fn_read_messages` was the site STAS-256
missed: its one catch covered the inbox read *and* the reply-context read, so a pool that could not answer produced
`ERROR: Failed to read messages: …` as a plain `tool_result` row — the agent sees a mailbox it cannot prove is empty.

The invariant has two halves, and the green pins below are the other half: a mailbox that is genuinely empty, and a
guard that refuses a call before the store seam, are facts about the request or the board. Flagging those would
teach agents to retry a refusal and to doubt an empty inbox, which is how STAS-251's second lie started.

The logging consequence is asserted through the real `AgentLogger.onToolEnd` seam, the same way STAS-258 pins the
write lane, because `isError` exists precisely to move that row's type.
*/
import { describe, expect, it, vi } from "vitest";
import { TaskNotFoundError, type AgentStore, type Message, type MessageStore, type TaskStore } from "@fusion/core";
import { createListAgentsTool, createReadMessagesTool, createTaskLogsReadTool, createTaskShowTool } from "../agent-tools.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { STORE_RETRY_GUIDANCE, storeErrorResult } from "../tool-store-errors.js";

const SENTINEL = "STAS-259 sentinel: inbox read refused";
const AGENT_ID = "agent-259";
/** Read from the composer at run time so this file copies no literal — the shape is owned by tool-store-errors.ts. */
const SHARED_SHAPE = storeErrorResult("probe", new Error("probe"));
const SHARED_CODE = SHARED_SHAPE.details.code;

type ToolResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean };

const textOf = (result: ToolResult) => result.content.map((part) => part.text).join("\n");

function inboxMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-259",
    fromId: "user",
    fromType: "user",
    toId: AGENT_ID,
    toType: "agent",
    content: "Is the board back?",
    type: "user-to-agent",
    read: false,
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    ...overrides,
  } as Message;
}

function messageStoreOver(getInbox: () => Promise<Message[]>, getMessage?: () => Promise<Message | null>) {
  return {
    getInbox: vi.fn(getInbox),
    getMessage: vi.fn(getMessage ?? (async () => null)),
  } as unknown as MessageStore;
}

async function logTypesFor(results: Array<{ tool: string; result: ToolResult }>): Promise<string[]> {
  const store = { appendAgentLog: vi.fn().mockResolvedValue(undefined) } as unknown as TaskStore;
  const logger = new AgentLogger({ store, taskId: "STAS-259", flushSizeBytes: 1 });
  for (const entry of results) {
    logger.onToolEnd(entry.tool, entry.result.isError === true, entry.result);
  }
  await logger.flush();
  return (store.appendAgentLog as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
}

describe("fn_read_messages reports a refused inbox read as a tool error (STAS-259)", () => {
  it("flags a refused getInbox in the shared store-failure shape instead of payload text", async () => {
    const tool = createReadMessagesTool(messageStoreOver(() => Promise.reject(new Error(SENTINEL))), AGENT_ID);

    const result = (await tool.execute("call-1", {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details?.code).toBe(SHARED_CODE);
    const text = textOf(result);
    expect(text).toContain(SENTINEL);
    expect(text).toContain(STORE_RETRY_GUIDANCE);
    /*
    The old branch was unflagged payload text; the two phrasings below are the lies it could have been — an
    outage must never read as an empty mailbox or as absent mail.
    */
    expect(text).not.toMatch(/no messages/i);
    expect(text).not.toMatch(/not found/i);
  });

  it("flags a refused reply-context read, which shares the catch with the inbox read", async () => {
    const store = messageStoreOver(
      async () => [inboxMessage({ metadata: { replyTo: { messageId: "msg-parent" } } })],
      () => Promise.reject(new Error(SENTINEL)),
    );
    const tool = createReadMessagesTool(store, AGENT_ID);

    const result = (await tool.execute("call-1", {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details?.code).toBe(SHARED_CODE);
    expect(store.getMessage).toHaveBeenCalled();
  });

  it("reaches the agent log as a tool_error row when the read failed, and a tool_result row when the inbox is empty", async () => {
    const failed = await (createReadMessagesTool(messageStoreOver(() => Promise.reject(new Error(SENTINEL))), AGENT_ID)
      .execute("call-1", {})) as ToolResult;
    const empty = await (createReadMessagesTool(messageStoreOver(async () => []), AGENT_ID).execute("call-2", {})) as ToolResult;

    expect(await logTypesFor([{ tool: "fn_read_messages", result: failed }, { tool: "fn_read_messages", result: empty }])).toEqual([
      "tool_error",
      "tool_result",
    ]);
  });

  it("keeps a genuinely empty inbox and a delivered inbox unflagged", async () => {
    /*
    Green pins — the other half of the invariant. "No messages" is a fact about the board: flagging it teaches an
    agent to retry a mailbox that is simply empty, which is the retry-storm half of the STAS-251 lesson.
    */
    const empty = (await createReadMessagesTool(messageStoreOver(async () => []), AGENT_ID).execute("call-1", {})) as ToolResult;
    expect(textOf(empty)).toBe("No messages");
    expect(empty.isError).toBeUndefined();
    expect(empty.details?.code).toBeUndefined();

    const delivered = (await createReadMessagesTool(
      messageStoreOver(async () => [inboxMessage()]),
      AGENT_ID,
    ).execute("call-2", {})) as ToolResult;
    expect(textOf(delivered)).toContain("Is the board back?");
    expect(delivered.isError).toBeUndefined();
  });
});

describe("read-path sites that must keep answering without the flag (STAS-259 pins)", () => {
  it("keeps a guard refusal before the store seam as payload text, with no store read attempted", async () => {
    const store = { getAgentLogs: vi.fn(), getAgentLogCount: vi.fn() } as unknown as TaskStore;
    const tool = createTaskLogsReadTool(store, "STAS-259");

    const result = (await tool.execute("call-1", { task_id: "../escape" })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("ERROR:");
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it("keeps the store's typed not-found on fn_task_show informative, and its outage flagged", async () => {
    /*
    STAS-251 landed this split; it is the reference the read-path fixes copy. Pinned here so a later "tidy" that
    merges the two branches back into one catch fails a test owned by this card's class of miss.
    */
    const absent = { getTask: vi.fn().mockRejectedValue(new TaskNotFoundError("STAS-000")) } as unknown as TaskStore;
    const absentResult = (await createTaskShowTool(absent).execute("call-1", { id: "STAS-000" })) as ToolResult;
    expect(textOf(absentResult)).toContain("STAS-000 not found.");
    expect(absentResult.isError).toBeUndefined();

    const unreachable = { getTask: vi.fn().mockRejectedValue(new Error(SENTINEL)) } as unknown as TaskStore;
    const unreachableResult = (await createTaskShowTool(unreachable).execute("call-2", { id: "STAS-000" })) as ToolResult;
    expect(unreachableResult.isError).toBe(true);
    expect(unreachableResult.details?.code).toBe(SHARED_CODE);
    expect(textOf(unreachableResult)).toContain(STORE_RETRY_GUIDANCE);
  });
});

/*
STAS-335: the agent-roster read had no catch at all, so the failure an executor actually saw was the
Drizzle wrapper — the whole SELECT re-printed, the bound project id, and SQLSTATE 42P01 buried in the
`cause` — thrown past the tool boundary as a bare echo. The pins below hold the two halves: the refused
roster arrives in the shared shape naming table + SQLSTATE + operation=read, and a roster that is
simply empty stays an ordinary answer.
*/

/** The failure the driver really throws: a wrapper whose message is the statement and whose cause carries the SQLSTATE. */
function refusedRosterRead(): Error {
  const query = `select "id", "name" from "project"."agents" where "project"."agents"."project_id" = $1`;
  const error = new Error(`${SENTINEL}: Failed query: ${query}`) as Error & { query: string; cause: { code: string } };
  error.query = query;
  error.cause = { code: "42P01" };
  return error;
}

describe("fn_list_agents reports a refused roster read as an attributed tool error (STAS-335)", () => {
  it("names the table, the SQLSTATE and operation=read instead of throwing the raw query", async () => {
    const store = { listAgents: vi.fn(() => Promise.reject(refusedRosterRead())) } as unknown as AgentStore;

    const result = (await createListAgentsTool(store).execute("call-1", {})) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.details?.code).toBe(SHARED_CODE);
    expect(result.details?.operation).toBe("read");
    expect(result.details?.table).toBe("agents");
    expect(result.details?.sqlState).toBe("42P01");
    const text = textOf(result);
    expect(text).toContain(SENTINEL);
    expect(text).toContain(STORE_RETRY_GUIDANCE);
    /* A roster the store refused is not a board with no agents. */
    expect(text).not.toMatch(/no agents found/i);
  });

  it("keeps an empty roster and a populated roster unflagged", async () => {
    const empty = { listAgents: vi.fn(async () => []) } as unknown as AgentStore;
    const emptyResult = (await createListAgentsTool(empty).execute("call-1", {})) as ToolResult;
    expect(textOf(emptyResult)).toContain("No agents found");
    expect(emptyResult.isError).toBeUndefined();

    const listed = {
      listAgents: vi.fn(async () => [
        { id: "agent-335", name: "Executor", role: "executor", state: "idle", createdAt: "", updatedAt: "" },
      ]),
    } as unknown as AgentStore;
    const listedResult = (await createListAgentsTool(listed).execute("call-2", {})) as ToolResult;
    expect(textOf(listedResult)).toContain("agent-335");
    expect(listedResult.isError).toBeUndefined();
  });
});
