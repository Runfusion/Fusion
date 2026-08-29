import { describe, it, expect } from "vitest";
import {
  CliAdapterRegistry,
  DuplicateCliAdapterError,
  UnknownCliAdapterError,
  type CliAgentAdapter,
} from "../adapter.js";

function makeAdapter(id: string, overrides: Partial<CliAgentAdapter> = {}): CliAgentAdapter {
  return {
    id,
    name: `Adapter ${id}`,
    capabilities: {
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "hooks",
      supportsResume: true,
    },
    buildLaunch: () => ({ command: id, args: [] }),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text) => ({ payload: `${text}\r` }),
    ...overrides,
  };
}

describe("CliAdapterRegistry", () => {
  it("registers and retrieves an adapter by id", () => {
    const registry = new CliAdapterRegistry();
    const adapter = makeAdapter("claude-code");
    registry.register(adapter);

    expect(registry.get("claude-code")).toBe(adapter);
    expect(registry.has("claude-code")).toBe(true);
    expect(registry.ids()).toEqual(["claude-code"]);
    expect(registry.all()).toEqual([adapter]);
  });

  it("throws UnknownCliAdapterError for an unregistered id", () => {
    const registry = new CliAdapterRegistry();
    expect(() => registry.get("nope")).toThrow(UnknownCliAdapterError);
    try {
      registry.get("nope");
    } catch (err) {
      expect((err as UnknownCliAdapterError).code).toBe("UNKNOWN_CLI_ADAPTER");
      expect((err as UnknownCliAdapterError).adapterId).toBe("nope");
    }
  });

  it("tryGet returns undefined instead of throwing", () => {
    const registry = new CliAdapterRegistry();
    expect(registry.tryGet("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("rejects duplicate registration of the same id", () => {
    const registry = new CliAdapterRegistry();
    registry.register(makeAdapter("codex"));
    expect(() => registry.register(makeAdapter("codex"))).toThrow(DuplicateCliAdapterError);
    try {
      registry.register(makeAdapter("codex"));
    } catch (err) {
      expect((err as DuplicateCliAdapterError).code).toBe("DUPLICATE_CLI_ADAPTER");
    }
  });

  it("supports multiple adapters with distinct ids", () => {
    const registry = new CliAdapterRegistry();
    registry.register(makeAdapter("claude-code"));
    registry.register(makeAdapter("codex"));
    registry.register(
      makeAdapter("generic", {
        capabilities: {
          nativeDone: false,
          nativeWaiting: false,
          transcriptSource: "none",
          supportsResume: false,
        },
      }),
    );

    expect(registry.ids().sort()).toEqual(["claude-code", "codex", "generic"]);
    expect(registry.get("generic").capabilities.nativeDone).toBe(false);
    expect(registry.get("claude-code").capabilities.nativeDone).toBe(true);
  });

  it("adapters declare honest capability flags read off the registry", () => {
    const registry = new CliAdapterRegistry();
    registry.register(
      makeAdapter("hybrid", {
        capabilities: {
          nativeDone: true,
          nativeWaiting: false, // codex hybrid caveat
          transcriptSource: "jsonl",
          supportsResume: true,
        },
      }),
    );
    const caps = registry.get("hybrid").capabilities;
    expect(caps.nativeWaiting).toBe(false);
    expect(caps.transcriptSource).toBe("jsonl");
  });
});
