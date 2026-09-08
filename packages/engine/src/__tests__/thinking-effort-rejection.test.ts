import { describe, it, expect } from "vitest";
import { degradeThinkingLevel, isReasoningEffortRejectionError } from "../errors/thinking-effort-rejection.js";

// FNXC:ThinkingEffortFallback 2026-08-26 (review follow-up): a bare Codex
// "[1210] Invalid API parameter" envelope can mean an UNRELATED invalid
// parameter. Degradation must not trigger unless the error names the
// effort/thinking parameter, otherwise Fusion would silently lower the
// reasoning level for an unrelated 1210 and retry with changed behavior.
describe("isReasoningEffortRejectionError", () => {
  it("accepts effort-specific rejections", () => {
    expect(isReasoningEffortRejectionError("400 Invalid API parameter: reasoning_effort must be one of: low, high")).toBe(true);
    expect(isReasoningEffortRejectionError('{"type":"server_error","message":"[1210] Invalid API parameter: reasoning_effort"}')).toBe(true);
    expect(isReasoningEffortRejectionError("400 invalid_request_error: Unsupported value for 'reasoning_effort'")).toBe(true);
  });

  it("treats any [1210] Invalid-API-parameter envelope as recoverable", () => {
    // The OBSERVED production loop (PR description) is a BARE envelope with no
    // effort token — it must fire the ladder. A false positive on an unrelated
    // 1210 costs at most one bounded degradation + one fallback swap, while a
    // false negative re-admits the infinite retry this PR exists to kill.
    // FNXC:ThinkingEffortFallback 2026-08-26-22:05 (Devin ANALYSIS-0001).
    expect(isReasoningEffortRejectionError("Console): Upstream request failed: [1210] Invalid API parameter, please check the documentation.")).toBe(true);
    expect(isReasoningEffortRejectionError("[1210] Invalid API parameter")).toBe(true);
    // Non-1210 / non-envelope messages stay out of the effort family.
    expect(isReasoningEffortRejectionError("Model is unavailable")).toBe(false);
    expect(isReasoningEffortRejectionError("")).toBe(false);
  });
});

describe("degradeThinkingLevel", () => {
  it("walks the ladder down one rung and stops at the bottom", () => {
    // Every adjacent transition of the ordered ladder, highest → lowest.
    // FNXC:ThinkingEffortFallback 2026-08-26-21:30 (Devin BUG-0001): canonical
    // order has `max` above `xhigh` — degradation must never move UP.
    expect(degradeThinkingLevel("max")).toBe("xhigh");
    expect(degradeThinkingLevel("xhigh")).toBe("high");
    expect(degradeThinkingLevel("high")).toBe("medium");
    expect(degradeThinkingLevel("medium")).toBe("low");
    expect(degradeThinkingLevel("low")).toBe("minimal");
    expect(degradeThinkingLevel("minimal")).toBe("off");
    // Bottom rung and unknown/custom labels have nothing left to drop to.
    expect(degradeThinkingLevel("off")).toBeNull();
    expect(degradeThinkingLevel("none")).toBeNull();
    expect(degradeThinkingLevel("ultra-think")).toBeNull();
  });
});
