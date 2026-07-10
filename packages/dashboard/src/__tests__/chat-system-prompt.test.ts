import { describe, expect, it } from "vitest";
import { FUSION_RUNTIME_SELF_AWARENESS } from "@fusion/core";
import { CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE, CHAT_SYSTEM_PROMPT } from "../chat.js";

describe("chat system prompt guidance", () => {
  it.each(["short", "crisp", "few sentences"])("includes brevity direction: %s", (token) => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain(token);
  });

  it("includes long-form follow-up path via fn_send_message", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("fn_send_message");
    expect(CHAT_SYSTEM_PROMPT).toContain('type: "agent-to-user"');
    expect(CHAT_SYSTEM_PROMPT).toContain('to_id: "dashboard"');
  });

  it("combined guidance enforces additive mailbox follow-ups, not mirroring", () => {
    const combined = `${CHAT_SYSTEM_PROMPT}\n\n${CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE}`;

    expect(combined).toContain("fn_send_message");
    expect(combined).toContain('to_id: "dashboard"');
    expect(combined.toLowerCase()).toContain("must not duplicate");
    expect(combined.toLowerCase()).toContain("additive");
    expect(combined.toLowerCase()).toContain("do not also call");
  });
});

// ---------------------------------------------------------------------------
// Runtime self-awareness preamble (FN-7675)
// ---------------------------------------------------------------------------

describe("chat system prompt runtime self-awareness", () => {
  it("prepends the shared FUSION_RUNTIME_SELF_AWARENESS preamble", () => {
    expect(CHAT_SYSTEM_PROMPT.startsWith(FUSION_RUNTIME_SELF_AWARENESS)).toBe(true);
  });

  it("carries the shutdown-boundary clauses", () => {
    const lower = CHAT_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("cannot** perform any action after fusion is shut down".toLowerCase());
    expect(lower).toContain("standalone artifact the user runs themselves");
  });
});
