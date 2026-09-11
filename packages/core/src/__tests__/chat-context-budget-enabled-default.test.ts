import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../config/settings-schema.js";

/**
 * RUFU-135 kill switch: the chat context budget (bounded memory inlining +
 * curated chat tool allowlist) is an opt-out project option. The default must
 * stay `true` — the budget is what makes agent chat fit 64K-window models —
 * but operators can set `false` at runtime (project settings) to restore the
 * pre-RUFU-135 prompt shape (unbounded memory injection, full registered tool
 * set) without a redeploy if the budget ever misbehaves in production.
 * The chat runner reads the flag per send via getChatModelSettings(), so the
 * switch is hot (no engine restart required).
 */
describe("chatContextBudgetEnabled project setting (RUFU-135 kill switch)", () => {
  it("defaults on so the chat context budget is active without configuration", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatContextBudgetEnabled).toBe(true);
  });

  it("is declared next to the pre-overflow guard toggle in the schema (both LCM opt-outs)", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatPreOverflowCompactionEnabled).toBe(true);
    expect(DEFAULT_PROJECT_SETTINGS).toHaveProperty("chatContextBudgetEnabled");
  });
});
