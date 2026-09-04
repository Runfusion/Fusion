import { describe, expect, it } from "vitest";
import { buildChatQuotePrefill } from "./chatQuotePrefill";

describe("buildChatQuotePrefill", () => {
  it("creates a mention-compatible agent quote", () => {
    expect(buildChatQuotePrefill({ quotedText: "hello", agentName: "Workflow Planner", existingDraft: "next" }))
      .toBe('"hello" - @Workflow_Planner , next');
  });

  it("normalizes excerpts and replaces an existing prefix", () => {
    const quote = buildChatQuotePrefill({ quotedText: '  a\n"b"  ', existingDraft: '"old" - @Avery , next' });
    expect(quote).toBe('"a \'b\'" - next');
  });

  it("keeps the draft when there is no quoteable content", () => {
    expect(buildChatQuotePrefill({ quotedText: " \n", existingDraft: "draft" })).toBe("draft");
  });
});
