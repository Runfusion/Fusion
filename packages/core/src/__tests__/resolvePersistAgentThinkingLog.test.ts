import { describe, expect, it } from "vitest";
import { resolvePersistAgentThinkingLog } from "../types.js";

describe("resolvePersistAgentThinkingLog", () => {
  it("returns false for both kinds when granular and legacy are unset", () => {
    expect(resolvePersistAgentThinkingLog({}, { ephemeral: false })).toBe(false);
    expect(resolvePersistAgentThinkingLog({}, { ephemeral: true })).toBe(false);
  });

  it("uses granular permanent setting when defined", () => {
    expect(
      resolvePersistAgentThinkingLog(
        { persistAgentThinkingLogPermanent: true, persistAgentThinkingLogEphemeral: undefined },
        { ephemeral: false },
      ),
    ).toBe(true);
    expect(
      resolvePersistAgentThinkingLog(
        { persistAgentThinkingLogPermanent: true, persistAgentThinkingLogEphemeral: undefined },
        { ephemeral: true },
      ),
    ).toBe(false);
  });

  it("falls back to legacy setting when granular fields are undefined", () => {
    expect(resolvePersistAgentThinkingLog({ persistAgentThinkingLog: true }, { ephemeral: false })).toBe(true);
    expect(resolvePersistAgentThinkingLog({ persistAgentThinkingLog: true }, { ephemeral: true })).toBe(true);
  });

  it("prioritizes granular setting over legacy fallback", () => {
    expect(
      resolvePersistAgentThinkingLog(
        { persistAgentThinkingLogPermanent: false, persistAgentThinkingLog: true },
        { ephemeral: false },
      ),
    ).toBe(false);
    expect(
      resolvePersistAgentThinkingLog(
        { persistAgentThinkingLogEphemeral: false, persistAgentThinkingLog: true },
        { ephemeral: true },
      ),
    ).toBe(false);
  });
});
