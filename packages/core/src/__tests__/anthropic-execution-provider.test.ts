import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_PROVIDER_ID,
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
  toExecutionModelProviderId,
} from "../index.js";

describe("toExecutionModelProviderId", () => {
  it("maps Anthropic auth-surface ids to the direct execution provider", () => {
    expect(toExecutionModelProviderId(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)).toBe(ANTHROPIC_PROVIDER_ID);
    expect(toExecutionModelProviderId(ANTHROPIC_API_KEY_PROVIDER_ID)).toBe(ANTHROPIC_PROVIDER_ID);
  });

  it.each([ANTHROPIC_PROVIDER_ID, "pi-claude-cli", "custom-provider"])("preserves %s", (providerId) => {
    expect(toExecutionModelProviderId(providerId)).toBe(providerId);
  });
});
