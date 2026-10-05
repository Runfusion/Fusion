import { describe, expect, it, vi } from "vitest";
import {
  GROK_CLI_PROVIDER_ID,
  projectPiXaiModelsToGrokCli,
} from "../ai/grok-provider.js";

describe("projectPiXaiModelsToGrokCli", () => {
  it("preserves current Pi xAI metadata under the persisted grok-cli provider", () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    projectPiXaiModelsToGrokCli({
      getAll: () => [{
        provider: "xai",
        id: "grok-pi-current",
        name: "Pi current Grok",
        reasoning: true,
        contextWindow: 222_222,
      }],
      registerProvider,
      unregisterProvider,
    });

    expect(unregisterProvider).toHaveBeenCalledWith(GROK_CLI_PROVIDER_ID);
    expect(registerProvider).toHaveBeenCalledWith(GROK_CLI_PROVIDER_ID, expect.objectContaining({
      models: [expect.objectContaining({
        id: "grok-pi-current",
        name: "Pi current Grok",
        reasoning: true,
        contextWindow: 222_222,
      })],
    }));
  });

  it("removes the persisted Grok projection when Pi no longer has xAI models", () => {
    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();
    projectPiXaiModelsToGrokCli({
      getAll: () => [],
      registerProvider,
      unregisterProvider,
    });

    expect(unregisterProvider).toHaveBeenCalledWith(GROK_CLI_PROVIDER_ID);
    expect(registerProvider).not.toHaveBeenCalled();
  });
});
