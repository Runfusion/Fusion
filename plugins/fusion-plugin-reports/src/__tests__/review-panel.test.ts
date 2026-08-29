import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAiSessionFactory, PluginContext } from "@fusion/core";
import { __setCreateAiSessionFactory, combineReviews, runReviewPanel } from "../review-panel.js";
import type { ReviewPanelMember } from "../review-types.js";
import { ReviewPanelError } from "../review-types.js";

function createContext(createAiSession?: CreateAiSessionFactory): PluginContext {
  return {
    pluginId: "fusion-plugin-reports",
    taskStore: {} as PluginContext["taskStore"],
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    createAiSession,
  };
}

const panel: ReviewPanelMember[] = [
  { id: "qa", name: "QA", perspective: "Quality" },
  { id: "ops", name: "Ops", perspective: "Operations" },
  { id: "pm", name: "PM", perspective: "Product" },
];

afterEach(() => {
  __setCreateAiSessionFactory(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runReviewPanel", () => {
  it("returns individual and combined reviews for a 3-member panel", async () => {
    const createAiSession = vi.fn(async ({ systemPrompt }) => ({
      session: {
        prompt: vi.fn(async () => {}),
        state: {
          messages: [{ role: "assistant", content: JSON.stringify({ verdict: "approve", summary: systemPrompt, highlights: ["A"], lowlights: ["B"], suggestions: ["C"] }) }],
        },
        dispose: vi.fn(),
      },
    }));

    const result = await runReviewPanel({
      reportDraft: "draft",
      reportMetadata: { reportId: "r-1", cadence: "daily", periodStart: "2026-01-01", periodEnd: "2026-01-02" },
      panel,
      cwd: "/tmp",
    }, createContext(createAiSession));

    expect(result.individual).toHaveLength(3);
    expect(result.failures).toEqual([]);
    expect(result.overallVerdict).toBe("approve");
    expect(result.consensusSummary).toContain("Quality:");
  });

  it("deduplicates merged arrays in first-seen order", () => {
    const merged = combineReviews([
      { memberId: "a", memberName: "A", perspective: "P1", verdict: "approve", summary: "ok", highlights: [" Alpha ", "Beta"], lowlights: ["Lag"], suggestions: ["Fix docs"], rawText: "", durationMs: 1 },
      { memberId: "b", memberName: "B", perspective: "P2", verdict: "approve", summary: "ok", highlights: ["alpha", "Gamma"], lowlights: [" lag "], suggestions: ["fix docs", "Add tests"], rawText: "", durationMs: 1 },
    ], []);

    expect(merged.mergedHighlights).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(merged.mergedLowlights).toEqual(["Lag"]);
    expect(merged.mergedSuggestions).toEqual(["Fix docs", "Add tests"]);
  });

  it("applies verdict precedence", () => {
    const revise = combineReviews([
      { memberId: "a", memberName: "A", perspective: "P1", verdict: "approve", summary: "ok", highlights: [], lowlights: [], suggestions: [], rawText: "", durationMs: 1 },
      { memberId: "b", memberName: "B", perspective: "P2", verdict: "revise", summary: "rev", highlights: [], lowlights: [], suggestions: [], rawText: "", durationMs: 1 },
    ], []);
    expect(revise.overallVerdict).toBe("revise");

    const reject = combineReviews([
      { memberId: "a", memberName: "A", perspective: "P1", verdict: "approve", summary: "ok", highlights: [], lowlights: [], suggestions: [], rawText: "", durationMs: 1 },
      { memberId: "b", memberName: "B", perspective: "P2", verdict: "reject", summary: "no", highlights: [], lowlights: [], suggestions: [], rawText: "", durationMs: 1 },
    ], []);
    expect(reject.overallVerdict).toBe("reject");
  });

  it("records timeout failure without aborting other reviewers", async () => {
    vi.useFakeTimers();
    const createAiSession = vi.fn(async ({ systemPrompt }) => {
      if (systemPrompt.includes("Operations")) {
        return {
          session: {
            prompt: vi.fn(async () => new Promise<void>(() => {})),
            state: { messages: [] },
            dispose: vi.fn<() => void>(),
          },
        };
      }
      return {
        session: {
          prompt: vi.fn(async () => {}),
          state: { messages: [{ role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", highlights: [], lowlights: [], suggestions: [] }) }] },
          dispose: vi.fn<() => void>(),
        },
      };
    });

    const promise = runReviewPanel({
      reportDraft: "draft",
      reportMetadata: { reportId: "r-1", cadence: "daily", periodStart: "2026-01-01", periodEnd: "2026-01-02" },
      panel,
      cwd: "/tmp",
    }, createContext(createAiSession));

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await promise;

    expect(result.individual).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe("timeout");
  });

  it("retries malformed JSON once then reports parse_error", async () => {
    const prompt = vi.fn(async () => {});
    const createAiSession = vi.fn(async () => ({
      session: {
        prompt,
        state: { messages: [{ role: "assistant", content: "not-json" }] },
        dispose: vi.fn(),
      },
    }));

    const result = await runReviewPanel({
      reportDraft: "draft",
      reportMetadata: { reportId: "r-1", cadence: "daily", periodStart: "2026-01-01", periodEnd: "2026-01-02" },
      panel: [panel[0]],
      cwd: "/tmp",
    }, createContext(createAiSession));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(result.individual).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe("parse_error");
  });

  it("throws ReviewPanelError when createAiSession is unavailable", async () => {
    await expect(runReviewPanel({
      reportDraft: "draft",
      reportMetadata: { reportId: "r-1", cadence: "daily", periodStart: "2026-01-01", periodEnd: "2026-01-02" },
      panel,
      cwd: "/tmp",
    }, createContext(undefined))).rejects.toBeInstanceOf(ReviewPanelError);
  });

  it("forwards provider/modelId to createAiSession per member", async () => {
    const createAiSession = vi.fn(async () => ({
      session: {
        prompt: vi.fn(async () => {}),
        state: { messages: [{ role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", highlights: [], lowlights: [], suggestions: [] }) }] },
        dispose: vi.fn(),
      },
    }));

    await runReviewPanel({
      reportDraft: "draft",
      reportMetadata: { reportId: "r-1", cadence: "daily", periodStart: "2026-01-01", periodEnd: "2026-01-02" },
      panel: [{ id: "m1", name: "M1", perspective: "P", provider: "anthropic", modelId: "claude" }],
      cwd: "/tmp",
    }, createContext(createAiSession));

    expect(createAiSession).toHaveBeenCalledWith(expect.objectContaining({ defaultProvider: "anthropic", defaultModelId: "claude" }));
  });
});
