import { describe, expect, it } from "vitest";
import { CHAT_REPORT_MAX_BODY, buildChatReportHandoff } from "../chatReportHandoff";

describe("buildChatReportHandoff", () => {
  it("rejects blank mail and always derives a usable title", () => {
    expect(buildChatReportHandoff("  \n", "Fallback")).toEqual({ handoff: null, truncated: false });
    expect(buildChatReportHandoff("```ts\nconst x = 1;\n```", "Fallback").handoff?.title).toBe("Fallback");
    expect(buildChatReportHandoff("```md\n# A code heading\n```", "Fallback").handoff?.title).toBe("Fallback");
    expect(buildChatReportHandoff("~~~md\n# Another code heading\n~~~", "Fallback").handoff?.title).toBe("Fallback");
    expect(buildChatReportHandoff("!!!", "Fallback").handoff?.title).toBe("Fallback");
  });

  it("uses headings and bounds report bodies to the composer limit", () => {
    expect(buildChatReportHandoff("# Delivery update\nBody", "Fallback").handoff?.title).toBe("Delivery update");
    const result = buildChatReportHandoff("x".repeat(CHAT_REPORT_MAX_BODY + 1), "Fallback");
    expect(result.truncated).toBe(true);
    expect(result.handoff?.body).toHaveLength(CHAT_REPORT_MAX_BODY);
    expect(buildChatReportHandoff("x".repeat(CHAT_REPORT_MAX_BODY), "Fallback").truncated).toBe(false);
  });

  it("limits a prose-derived title without turning a degenerate message into a blank title", () => {
    const prose = "Release ".repeat(20);
    expect(buildChatReportHandoff(prose, "Fallback").handoff?.title).toHaveLength(79);
    expect(buildChatReportHandoff("...\n---", "Fallback").handoff?.title).toBe("Fallback");
  });
});
