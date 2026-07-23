import { describe, expect, it } from "vitest";
import { FUSION_RUNTIME_SELF_AWARENESS } from "@fusion/core";
import {
  CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE,
  CHAT_ASK_QUESTION_GUIDANCE,
  CHAT_CODEBASE_ACCURACY_GUIDANCE,
  CHAT_SYSTEM_PROMPT,
} from "../chat.js";

describe("chat system prompt guidance", () => {
  it.each(["short", "crisp", "few sentences"])("includes brevity direction: %s", (token) => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain(token);
  });

  it("includes long-form follow-up path via fn_send_message", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("fn_send_message");
    expect(CHAT_SYSTEM_PROMPT).toContain('type: "agent-to-user"');
    expect(CHAT_SYSTEM_PROMPT).toContain('to_id: "dashboard"');
  });

  it("yields brevity to correctness for repository code questions", () => {
    const lower = CHAT_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("prioritize correctness");
    expect(lower).toContain("cite real paths/symbols");
    expect(lower).toContain("key citations");
  });

  it("authorizes the full coding workspace toolset for user-directed changes", () => {
    const lower = CHAT_SYSTEM_PROMPT.toLowerCase();

    for (const tool of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      expect(lower).toContain(`\`${tool}\``);
    }
    expect(lower).toContain("user-requested code changes");
    expect(lower).toContain("do not claim that you only have read access");
    expect(lower).toContain("pending-approval");
  });

  it("keeps the checked-out branch sticky unless explicitly requested", () => {
    const lower = CHAT_SYSTEM_PROMPT.toLowerCase();

    expect(lower).toContain("branch");
    expect(lower).toContain("git checkout");
    expect(lower).toContain("git switch");
    expect(lower).toContain("unless the user explicitly asks");
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

describe("chat codebase accuracy guidance", () => {
  it("requires tool-grounded investigation for codebase questions", () => {
    const lower = CHAT_CODEBASE_ACCURACY_GUIDANCE.toLowerCase();
    expect(lower).toContain("live checkout");
    expect(lower).toContain("before");
    expect(lower).toContain("grep");
    expect(lower).toContain("read");
    expect(lower).toContain("do not invent");
    expect(lower).toContain("trust the tools");
  });

  it("keeps conversational brevity for non-code questions", () => {
    expect(CHAT_CODEBASE_ACCURACY_GUIDANCE.toLowerCase()).toContain("conversational");
    expect(CHAT_CODEBASE_ACCURACY_GUIDANCE.toLowerCase()).toContain("short/crisp");
  });

  it("does not turn chat into a planning-mode interview", () => {
    const lower = CHAT_CODEBASE_ACCURACY_GUIDANCE.toLowerCase();
    expect(lower).toContain("do **not** start a planning mode interview".toLowerCase());
    expect(lower).toContain("prompt.md");
  });

  it("combined chat guidance keeps mailbox routing, accuracy, and ask-question", () => {
    const combined = [
      CHAT_SYSTEM_PROMPT,
      CHAT_AGENT_MESSAGE_ROUTING_GUIDANCE,
      CHAT_CODEBASE_ACCURACY_GUIDANCE,
      CHAT_ASK_QUESTION_GUIDANCE,
    ].join("\n\n");
    expect(combined).toContain("fn_send_message");
    expect(combined).toContain("## Codebase accuracy");
    expect(combined).toContain("fn_ask_question");
    expect(combined.toLowerCase()).toContain("trust the tools");
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
