/*
 * FN-9222 regression coverage: the Brain popover's agent switch returned 200
 * while FN-7952's async PostgreSQL update seam dropped agentId. FN-7908 had
 * already shipped this model-to-agent and agent-to-model retarget contract.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { ChatStore } from "../../chat/chat-store.js";
import type { ChatSession } from "../../chat/chat-types.js";
import { createChatSession, getChatSession } from "../../async-stores/async-chat-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:Chat-ModelSwitch 2026-09-01-04:23:
FN-9222 preserves the direct-chat retarget contract in PostgreSQL. These
production-store scenarios cover the popover payload, its reverse direction,
and helper paths that must leave an omitted target unchanged.
*/

const FN_AGENT_ID = "__fn_agent__";
let sessionCounter = 0;

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = "2020-01-01T00:00:00.000Z";
  return {
    id: `chat-agent-target-${++sessionCounter}`,
    agentId: FN_AGENT_ID,
    tags: [],
    title: "Direct chat",
    status: "active",
    projectId: "chat-agent-target",
    modelProvider: "p",
    modelId: "m",
    thinkingLevel: "medium",
    memoryFocus: "targeted",
    createdAt: now,
    updatedAt: now,
    pinnedAt: "2020-01-02T00:00:00.000Z",
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    ...overrides,
  };
}

pgDescribe("async ChatStore agent target switches (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_chat_agent_target",
    projectId: "chat-agent-target",
  });
  let chat: ChatStore;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    chat = new ChatStore(h.layer());
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists the Brain popover model-to-agent payload and advances updatedAt", async () => {
    const session = await createChatSession(h.layer().db, makeSession());

    await chat.updateSession(session.id, {
      agentId: "agent-real",
      modelProvider: null,
      modelId: null,
    });

    const reread = await getChatSession(h.layer().db, session.id);
    expect(reread).toMatchObject({ agentId: "agent-real", modelProvider: null, modelId: null });
    expect(Date.parse(reread!.updatedAt)).toBeGreaterThan(Date.parse(session.updatedAt));
  });

  it("persists agent-to-model retargets and leaves omitted fields intact", async () => {
    const session = await createChatSession(h.layer().db, makeSession({
      agentId: "agent-real",
      modelProvider: null,
      modelId: null,
    }));

    await chat.updateSession(session.id, {
      agentId: FN_AGENT_ID,
      modelProvider: "p2",
      modelId: "m2",
    });
    expect(await getChatSession(h.layer().db, session.id)).toMatchObject({
      agentId: FN_AGENT_ID,
      modelProvider: "p2",
      modelId: "m2",
    });

    await chat.updateSession(session.id, { agentId: "agent-other" });
    expect(await getChatSession(h.layer().db, session.id)).toMatchObject({
      agentId: "agent-other",
      modelProvider: "p2",
      modelId: "m2",
      thinkingLevel: "medium",
      memoryFocus: "targeted",
      pinnedAt: "2020-01-02T00:00:00.000Z",
    });

    await chat.updateSession(session.id, { title: "renamed", thinkingLevel: "high" });
    expect(await getChatSession(h.layer().db, session.id)).toMatchObject({
      agentId: "agent-other",
      title: "renamed",
      thinkingLevel: "high",
    });
  });

  it("preserves the archive transaction and pin helper invariants", async () => {
    const session = await createChatSession(h.layer().db, makeSession({ agentId: "agent-before-archive" }));

    await chat.updateSession(session.id, { agentId: "agent-real", status: "archived" });
    expect(await getChatSession(h.layer().db, session.id)).toMatchObject({
      agentId: "agent-real",
      status: "archived",
      pinnedAt: null,
    });

    const active = await createChatSession(h.layer().db, makeSession({ agentId: "agent-pinned" }));
    await chat.setSessionPinned(active.id, true);
    expect(await getChatSession(h.layer().db, active.id)).toMatchObject({
      agentId: "agent-pinned",
      pinnedAt: expect.any(String),
    });
  });
});
