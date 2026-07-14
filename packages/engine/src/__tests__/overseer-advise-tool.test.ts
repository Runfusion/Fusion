import { describe, expect, it, vi } from "vitest";
import { OverseerAdviseRecorder, parseAdvisorReplyForAdvice } from "../overseer-advise-tool.js";

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
