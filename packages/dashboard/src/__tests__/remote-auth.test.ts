import { describe, it, expect, beforeEach } from "vitest";
import type { RemoteAccessProjectSettings } from "@fusion/core";
import {
  __resetRemoteAuthStateForTests,
  constantTimeEqual,
  issueRemoteAuthToken,
  maskRemoteToken,
  validateRemoteAuthToken,
} from "../remote-auth.js";

function createRemoteSettings(overrides: Partial<RemoteAccessProjectSettings> = {}): RemoteAccessProjectSettings {
  return {
    enabled: true,
    activeProvider: "tailscale",
    providers: {
      tailscale: {
        enabled: true,
        hostname: "tail.example.ts.net",
        targetPort: 4040,
        acceptRoutes: false,
      },
      cloudflare: {
        enabled: false,
        tunnelName: "",
        tunnelToken: null,
        ingressUrl: "",
      },
    },
    tokenStrategy: {
      persistent: {
        enabled: true,
        token: "frt_persistent_token",
      },
      shortLived: {
        enabled: true,
        ttlMs: 120_000,
        maxTtlMs: 86_400_000,
      },
    },
    lifecycle: {
      rememberLastRunning: false,
      wasRunningOnShutdown: false,
      lastRunningProvider: null,
    },
    ...overrides,
  };
}

describe("remote-auth", () => {
  beforeEach(() => {
    __resetRemoteAuthStateForTests();
  });

  it("compares tokens with constant-time helper", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
  });

  it("returns missing when token is absent", () => {
    const result = validateRemoteAuthToken(undefined, createRemoteSettings());
    expect(result).toEqual({ status: "missing" });
  });

  it("returns disabled when remote access or token strategy is disabled", () => {
    const disabledRemote = validateRemoteAuthToken("anything", createRemoteSettings({ enabled: false }));
    expect(disabledRemote).toEqual({ status: "disabled" });

    const disabledStrategies = validateRemoteAuthToken(
      "anything",
      createRemoteSettings({
        tokenStrategy: {
          persistent: { enabled: false, token: null },
          shortLived: { enabled: false, ttlMs: 120_000, maxTtlMs: 86_400_000 },
        },
      }),
    );
    expect(disabledStrategies).toEqual({ status: "disabled" });
  });

  it("validates persistent token when configured", () => {
    const result = validateRemoteAuthToken("frt_persistent_token", createRemoteSettings());
    expect(result).toEqual({ status: "valid", tokenType: "persistent" });
  });

  it("issues and validates short-lived token before expiry", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const settings = createRemoteSettings();

    const issued = issueRemoteAuthToken("short-lived", settings, now);
    const result = validateRemoteAuthToken(issued.token, settings, now + 30_000);

    expect(issued.tokenType).toBe("short-lived");
    expect(issued.expiresAt).toBeDefined();
    expect(result.status).toBe("valid");
    expect(result.tokenType).toBe("short-lived");
  });

  it("marks short-lived token expired by expiresAt", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const settings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 60_000, maxTtlMs: 86_400_000 },
      },
    });

    const issued = issueRemoteAuthToken("short-lived", settings, now);
    const result = validateRemoteAuthToken(issued.token, settings, now + 60_001);

    expect(result.status).toBe("expired");
    expect(result.tokenType).toBe("short-lived");
  });

  it("enforces configured ttl when validating existing short-lived tokens", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const longTtlSettings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 180_000, maxTtlMs: 86_400_000 },
      },
    });

    const issued = issueRemoteAuthToken("short-lived", longTtlSettings, now);

    const shorterTtlSettings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 60_000, maxTtlMs: 86_400_000 },
      },
    });

    const result = validateRemoteAuthToken(issued.token, shorterTtlSettings, now + 61_000);
    expect(result.status).toBe("expired");
  });

  it("returns invalid for unknown tokens", () => {
    const result = validateRemoteAuthToken("frt_unknown", createRemoteSettings());
    expect(result).toEqual({ status: "invalid" });
  });

  it("masks remote token values in diagnostics", () => {
    expect(maskRemoteToken("12345678")).toBe("********");
    expect(maskRemoteToken("frt_abcdefghijklmnop")).toBe("frt_…mnop");
  });
});
