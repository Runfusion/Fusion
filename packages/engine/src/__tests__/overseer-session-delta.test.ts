import { describe, expect, it } from "vitest";
import { formatOverseerSessionDelta, isOverseerSelfAdvisoryText } from "../overseer/overseer-session-delta.js";

describe("isOverseerSelfAdvisoryText", () => {
  it("detects planner-oversight and advisory markers", () => {
    expect(isOverseerSelfAdvisoryText("[planner-oversight] stuck")).toBe(true);
    expect(isOverseerSelfAdvisoryText('[session-advisor] severity="concern" note')).toBe(true);
    expect(isOverseerSelfAdvisoryText("<advisory severity=\"blocker\">stop</advisory>")).toBe(true);
    expect(isOverseerSelfAdvisoryText("Edited packages/engine/src/foo.ts")).toBe(false);
  });
});

describe("formatOverseerSessionDelta", () => {
  it("returns null for empty input", () => {
    expect(formatOverseerSessionDelta([])).toBeNull();
  });

  it("renders text and tool entries and filters self-advisories", () => {
    const md = formatOverseerSessionDelta([
      { type: "text", text: "I will edit the dashboard now.", agent: "executor" },
      { type: "text", text: "[planner-oversight] Stage stuck", agent: "agent" },
      { type: "tool", text: "read", detail: "packages/engine/src/foo.ts", agent: "executor" },
      { type: "text", text: "done", agent: "overseer" },
    ]);
    expect(md).toContain("### Session update");
    expect(md).toContain("I will edit the dashboard now.");
    expect(md).toContain("read");
    expect(md).not.toContain("[planner-oversight]");
    expect(md).not.toMatch(/#### overseer/);
  });

  it("returns null when every entry is filtered", () => {
    expect(
      formatOverseerSessionDelta([{ type: "text", text: "[session-advisor] note", agent: "executor" }]),
    ).toBeNull();
  });
});
