import { describe, it, expect, vi, afterEach } from "vitest";
import { mapThinkingEffort, isOpusModel } from "../thinking-config";
import type { ThinkingBudgets } from "@mariozechner/pi-ai";

describe("isOpusModel", () => {
  it("returns true for claude-opus-4-6-20260301", () => {
    expect(isOpusModel("claude-opus-4-6-20260301")).toBe(true);
  });

  it("returns false for claude-sonnet-4-5-20250929", () => {
    expect(isOpusModel("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("returns true for future Opus models (forward-compatible)", () => {
    expect(isOpusModel("claude-opus-5-20270101")).toBe(true);
  });

  it("returns false for non-Opus model strings", () => {
    expect(isOpusModel("claude-haiku-3-5-20240307")).toBe(false);
  });
});

describe("mapThinkingEffort", () => {
  describe("undefined reasoning", () => {
    it("returns undefined when reasoning is undefined", () => {
      expect(
        mapThinkingEffort(undefined, "claude-sonnet-4-5", undefined),
      ).toBeUndefined();
    });

    it("returns undefined regardless of model", () => {
      expect(
        mapThinkingEffort(undefined, "claude-opus-4-6-20260301", undefined),
      ).toBeUndefined();
    });
  });

  describe("standard (non-Opus) model mapping", () => {
    const model = "claude-sonnet-4-5";

    it("maps minimal to low", () => {
      expect(mapThinkingEffort("minimal", model, undefined)).toBe("low");
    });

    it("maps low to low", () => {
      expect(mapThinkingEffort("low", model, undefined)).toBe("low");
    });

    it("maps medium to medium", () => {
      expect(mapThinkingEffort("medium", model, undefined)).toBe("medium");
    });

    it("maps high to high", () => {
      expect(mapThinkingEffort("high", model, undefined)).toBe("high");
    });

    it("maps xhigh to high (downgrade for non-Opus)", () => {
      expect(mapThinkingEffort("xhigh", model, undefined)).toBe("high");
    });
  });

  describe("Opus model mapping (elevated)", () => {
    const model = "claude-opus-4-6-20260301";

    it("maps minimal to low", () => {
      expect(mapThinkingEffort("minimal", model, undefined)).toBe("low");
    });

    it("maps low to low", () => {
      expect(mapThinkingEffort("low", model, undefined)).toBe("low");
    });

    it("maps medium to high (shifted up)", () => {
      expect(mapThinkingEffort("medium", model, undefined)).toBe("high");
    });

    it("maps high to max (shifted up)", () => {
      expect(mapThinkingEffort("high", model, undefined)).toBe("max");
    });

    it("maps xhigh to max", () => {
      expect(mapThinkingEffort("xhigh", model, undefined)).toBe("max");
    });
  });

  describe("thinkingBudgets warning", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs console.warn when thinkingBudgets is provided with entries", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };

      mapThinkingEffort("high", "claude-sonnet-4-5", budgets);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("thinkingBudgets are not supported"),
      );
    });

    it("does not warn when thinkingBudgets is undefined", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mapThinkingEffort("high", "claude-sonnet-4-5", undefined);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when thinkingBudgets is empty object", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mapThinkingEffort("high", "claude-sonnet-4-5", {} as ThinkingBudgets);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("still returns correct effort level when budgets trigger warning", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };

      const result = mapThinkingEffort(
        "high",
        "claude-opus-4-6-20260301",
        budgets,
      );
      expect(result).toBe("max");
    });
  });

  describe("no modelId defaults to non-Opus behavior", () => {
    it("uses standard mapping when modelId is undefined", () => {
      expect(mapThinkingEffort("medium", undefined, undefined)).toBe("medium");
    });

    it("does not return max for xhigh when modelId is undefined", () => {
      expect(mapThinkingEffort("xhigh", undefined, undefined)).toBe("high");
    });
  });
});
