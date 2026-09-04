import { describe, expect, it } from "vitest";
import {
  formatOverseerSessionDelta,
  isOverseerSelfAdvisoryText,
  OVERSEER_LOG_DETAIL_PREVIEW_MAX,
  OVERSEER_SESSION_DELTA_MAX_CHARS,
} from "../overseer/overseer-session-delta.js";

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

  it("bounds oversized tool detail while retaining the tool name", () => {
    const detail = "x".repeat(4_096);
    const delta = formatOverseerSessionDelta([
      { type: "tool", text: "fn_run_verification", detail, agent: "executor" },
    ]);

    expect(delta).toContain("fn_run_verification");
    expect(delta).toContain("characters omitted");
    expect(delta!.length).toBeLessThanOrEqual(
      "### Session update\n\n#### executor · tool\n\nfn_run_verification\n".length + OVERSEER_LOG_DETAIL_PREVIEW_MAX,
    );
  });

  it("bounds an 80-row advisor batch", () => {
    const delta = formatOverseerSessionDelta(Array.from({ length: 80 }, (_, index) => ({
      type: "tool_result",
      text: `tool-${index}`,
      detail: "x".repeat(4_096),
      agent: "executor",
    })));

    expect(delta!.length).toBeLessThanOrEqual(OVERSEER_SESSION_DELTA_MAX_CHARS);
    expect(delta).toContain("session update truncated");
  });

  it("keeps ordinary persisted tool arguments and results bounded with the tool name", () => {
    const delta = formatOverseerSessionDelta([
      { type: "tool", text: "fn_run_verification", detail: "command=pnpm lint, allowFullSuite=false", agent: "executor" },
      { type: "tool_result", text: "fn_run_verification", detail: "ok", agent: "executor" },
    ]);

    expect(delta).toContain("fn_run_verification");
    expect(delta).toContain("command=pnpm lint, allowFullSuite=false");
    expect(delta).toContain("ok");
    expect(delta!.length).toBeLessThanOrEqual(OVERSEER_SESSION_DELTA_MAX_CHARS);
  });

  it("keeps a tool row whose arguments quote an advisory marker", () => {
    const delta = formatOverseerSessionDelta([
      { type: "tool", text: "fn_task_log", detail: 'message=severity="blocker"', agent: "executor" },
    ]);

    expect(delta).toContain("fn_task_log");
    expect(delta).toContain('severity="blocker"');
  });

  it("continues filtering text rows whose combined content quotes an advisory marker", () => {
    expect(formatOverseerSessionDelta([
      { type: "text", text: "ordinary update", detail: 'severity="blocker"', agent: "executor" },
    ])).toBeNull();
  });
});
