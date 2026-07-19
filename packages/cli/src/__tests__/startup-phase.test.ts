import { describe, it, expect, vi } from "vitest";
import { phaseTime } from "../startup-phase.js";

describe("phaseTime", () => {
  it("logs duration on success", async () => {
    const log = vi.fn();
    const result = await phaseTime("demo", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    }, log, "test");

    expect(result).toBe(42);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase demo: \d+ms$/);
    expect(log.mock.calls[0][1]).toBe("test");
  });

  it("logs duration when the phase throws", async () => {
    const log = vi.fn();
    await expect(
      phaseTime("boom", async () => {
        throw new Error("nope");
      }, log),
    ).rejects.toThrow("nope");

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase boom: \d+ms$/);
  });
});
