import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";
import {
  GROK_CLI_PROVIDER_ID,
  GROK_PROVIDER_REGISTRATION,
  hydrateGrokApiKeyFromUserSettings,
  isGrokApiKeyFusionVisible,
  registerBuiltInGrokProvider,
} from "../ai/grok-provider.js";

const ORIGINAL_ENV = { ...process.env };

function makeFakeRegistry() {
  const registeredProviders = new Map<string, unknown>();
  return {
    registeredProviders,
    registerProvider(providerName: string, config: unknown) {
      registeredProviders.set(providerName, config);
    },
  };
}

/*
FNXC:ProviderAuth 2026-07-09-00:00:
FN-7714 regression coverage for hydrateGrokApiKeyFromUserSettings / registerBuiltInGrokProvider:
mirrors probe.test.ts's fallback/precedence/fail-soft matrix so the $GROK_API_KEY env
reference resolves from ~/.grok/user-settings.json when the env var is unset, without ever
overwriting an operator-provided env value or throwing on a missing/malformed file.
*/
describe("isGrokApiKeyFusionVisible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GROK_API_KEY;
  });

  it("returns true when env is set and does not read the settings file", () => {
    process.env.GROK_API_KEY = " xai-from-env ";

    expect(isGrokApiKeyFusionVisible()).toBe(true);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns true when env is unset and user settings has a non-empty apiKey without mutating env", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: " xai-from-file " }));

    expect(isGrokApiKeyFusionVisible()).toBe(true);
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("returns false for a missing settings file without throwing or mutating env", () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw enoent;
    });

    expect(() => isGrokApiKeyFusionVisible()).not.toThrow();
    expect(isGrokApiKeyFusionVisible()).toBe(false);
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("returns false for empty, malformed, or keyless settings without throwing or mutating env", () => {
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify({ apiKey: "   " }))
      .mockReturnValueOnce("not json")
      .mockReturnValueOnce(JSON.stringify({}));

    expect(isGrokApiKeyFusionVisible()).toBe(false);
    expect(() => isGrokApiKeyFusionVisible()).not.toThrow();
    expect(isGrokApiKeyFusionVisible()).toBe(false);
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });
});

describe("hydrateGrokApiKeyFromUserSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GROK_API_KEY;
  });

  it("reproduces then resolves the original unresolved-key symptom: env unset + file has apiKey", () => {
    // Original symptom: GROK_API_KEY unset means $GROK_API_KEY resolves to nothing.
    expect(process.env.GROK_API_KEY).toBeUndefined();
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "xai-from-file" }));

    hydrateGrokApiKeyFromUserSettings();

    // Assertion it is gone: process.env.GROK_API_KEY is now populated so $GROK_API_KEY resolves.
    expect(process.env.GROK_API_KEY).toBe("xai-from-file");
  });

  it("env set (non-empty) always wins and the file is never read", () => {
    process.env.GROK_API_KEY = "xai-from-env";
    hydrateGrokApiKeyFromUserSettings();

    expect(process.env.GROK_API_KEY).toBe("xai-from-env");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("env set to empty/whitespace is treated as unset, so file fallback applies", () => {
    process.env.GROK_API_KEY = "   ";
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "xai-from-file" }));

    hydrateGrokApiKeyFromUserSettings();

    expect(process.env.GROK_API_KEY).toBe("xai-from-file");
  });

  it("file missing (ENOENT) is fail-soft: no throw, env stays unset", () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw enoent;
    });

    expect(() => hydrateGrokApiKeyFromUserSettings()).not.toThrow();
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("malformed JSON is fail-soft: no throw, env stays unset", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("not json at all");

    expect(() => hydrateGrokApiKeyFromUserSettings()).not.toThrow();
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("apiKey absent is fail-soft: no throw, env stays unset", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({}));

    expect(() => hydrateGrokApiKeyFromUserSettings()).not.toThrow();
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("apiKey empty string is fail-soft: no throw, env stays unset", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "   " }));

    expect(() => hydrateGrokApiKeyFromUserSettings()).not.toThrow();
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });

  it("apiKey non-string is fail-soft: no throw, env stays unset", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: 12345 }));

    expect(() => hydrateGrokApiKeyFromUserSettings()).not.toThrow();
    expect(process.env.GROK_API_KEY).toBeUndefined();
  });
});

describe("registerBuiltInGrokProvider — hydration wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GROK_API_KEY;
  });

  it("hydrates process.env.GROK_API_KEY from the settings file before registering", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "xai-from-file" }));
    const registry = makeFakeRegistry();

    registerBuiltInGrokProvider(registry);

    expect(process.env.GROK_API_KEY).toBe("xai-from-file");
    const registered = registry.registeredProviders.get(GROK_CLI_PROVIDER_ID) as typeof GROK_PROVIDER_REGISTRATION;
    // No displacement: still registers grok-cli with the unchanged $GROK_API_KEY reference.
    expect(registered.apiKey).toBe("$GROK_API_KEY");
    expect(registered).toMatchObject({
      name: "Grok",
      baseUrl: "https://api.x.ai/v1",
      api: "openai-completions",
    });
  });

  it("is idempotent: a second call does not re-read or overwrite an already-hydrated env value", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "xai-from-file" }));
    const registry = makeFakeRegistry();

    registerBuiltInGrokProvider(registry);
    expect(process.env.GROK_API_KEY).toBe("xai-from-file");
    expect(readFileSync).toHaveBeenCalledTimes(1);

    // Second call: env is now set, so the file must not be read again, and the value must
    // not be clobbered even if the (mocked) file would return something else.
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ apiKey: "xai-should-not-be-used" }));
    registerBuiltInGrokProvider(registry);

    expect(process.env.GROK_API_KEY).toBe("xai-from-file");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("leaves an operator-provided GROK_API_KEY untouched", () => {
    process.env.GROK_API_KEY = "xai-operator-provided";
    const registry = makeFakeRegistry();

    registerBuiltInGrokProvider(registry);

    expect(process.env.GROK_API_KEY).toBe("xai-operator-provided");
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
