import { describe, expect, it, vi } from "vitest";
import {
  OVERSEER_ADVISOR_REPLY_CONTRACT,
  OVERSEER_ADVISOR_SYSTEM_PROMPT,
  OverseerAdviseRecorder,
  extractAdvisorAssistantText,
  parseAdvisorReplyForAdvice,
} from "../overseer-advise-tool.js";

describe("OVERSEER_ADVISOR_SYSTEM_PROMPT", () => {
  it("keeps the JSON reply contract and OMP-style critical silence policy", () => {
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain('{"silence":true}');
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain('"severity":"nit"|"concern"|"blocker"');
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("Look where the agent is NOT");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("NEVER police scope or ambition");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("NEVER advise on intent or process");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("File Scope");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("PROMPT.md");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("<completeness>");
    expect(OVERSEER_ADVISOR_SYSTEM_PROMPT).toContain("<reply-contract>");
    // Alias still points at the full expanded prompt.
    expect(OVERSEER_ADVISOR_REPLY_CONTRACT).toBe(OVERSEER_ADVISOR_SYSTEM_PROMPT);
  });
});

describe("parseAdvisorReplyForAdvice", () => {
  it("parses fenced JSON advice", () => {
    const reply = 'Here:\n```json\n{"note":"Wrong package — File Scope is engine only.","severity":"concern"}\n```';
    expect(parseAdvisorReplyForAdvice(reply)).toEqual({
      note: "Wrong package — File Scope is engine only.",
      severity: "concern",
    });
  });

  it("parses silence object", () => {
    expect(parseAdvisorReplyForAdvice('{"silence":true}')).toBeNull();
  });

  it("parses ADVISE: lines", () => {
    expect(parseAdvisorReplyForAdvice("ADVISE(blocker): Missing regression test for the stall path.")).toEqual({
      note: "Missing regression test for the stall path.",
      severity: "blocker",
    });
  });

  it("returns null for LGTM-style silence", () => {
    expect(parseAdvisorReplyForAdvice("LGTM")).toBeNull();
    expect(parseAdvisorReplyForAdvice("none")).toBeNull();
  });
});

describe("OverseerAdviseRecorder", () => {
  it("records first note and ignores equal-severity duplicate", async () => {
    const onAdvice = vi.fn();
    const rec = new OverseerAdviseRecorder(onAdvice);
    const first = await rec.execute({ note: "Use the pure decidePlannerRecovery path.", severity: "nit" });
    const second = await rec.execute({ note: "Use the pure decidePlannerRecovery path.", severity: "nit" });
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(onAdvice).toHaveBeenCalledTimes(1);
  });
});

describe("extractAdvisorAssistantText", () => {
  it("reads nested state.messages assistant content", () => {
    const session = {
      state: {
        messages: [
          { role: "user", content: "delta" },
          { role: "assistant", content: '{"note":"Scope drift","severity":"concern"}' },
        ],
      },
    };
    expect(extractAdvisorAssistantText(session)).toContain("Scope drift");
  });

  it("returns empty string for unknown session shapes", () => {
    expect(extractAdvisorAssistantText(null)).toBe("");
    expect(extractAdvisorAssistantText({})).toBe("");
  });
});
