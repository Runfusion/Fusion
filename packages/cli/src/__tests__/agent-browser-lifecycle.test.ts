import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS,
  MAX_FUSION_BROWSER_IDLE_TIMEOUT_MS,
  prepareFusionManagedBrowserEnv,
  resolveFusionBrowserIdleTimeout,
} from "../../agent-browser-lifecycle.mjs";

describe("Fusion agent-browser launcher lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [undefined, DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS],
    ["garbage", DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS],
    ["0", DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS],
    ["-1", DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS],
    ["1234", 1234],
    [String(MAX_FUSION_BROWSER_IDLE_TIMEOUT_MS + 1), MAX_FUSION_BROWSER_IDLE_TIMEOUT_MS],
  ])("bounds managed idle timeout %s", (value, expected) => {
    expect(resolveFusionBrowserIdleTimeout(value)).toBe(expected);
  });

  it("leaves unmanaged external invocation untouched", () => {
    const env = { AGENT_BROWSER_IDLE_TIMEOUT_MS: "0" };
    expect(prepareFusionManagedBrowserEnv(env, 100)).toBe(env);
  });

  it("refuses to revive a retired Fusion lease", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-retired-launcher-"));
    const leasePath = join(root, "lease.json");
    writeFileSync(leasePath, JSON.stringify({ version: 1, sessionId: "fusion_retired", retiredAt: 1 }));
    const env = {
      FUSION_AGENT_BROWSER_SESSION_ID: "fusion_retired",
      FUSION_AGENT_BROWSER_LEASE_PATH: leasePath,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000",
    };
    expect(prepareFusionManagedBrowserEnv(env, 500)).toBe(env);
  });

  it("renews only the matching opaque Fusion lease", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-launcher-"));
    const leasePath = join(root, "lease.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(leasePath, JSON.stringify({ version: 1, sessionId: "fusion_test", heartbeatAt: 1, expiresAt: 2 }));
    const result = prepareFusionManagedBrowserEnv({
      FUSION_AGENT_BROWSER_SESSION_ID: "fusion_test",
      FUSION_AGENT_BROWSER_LEASE_PATH: leasePath,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000",
    }, 500);
    expect(result).toMatchObject({ AGENT_BROWSER_SESSION: "fusion_test", AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000" });
    expect(JSON.parse(readFileSync(leasePath, "utf8"))).toMatchObject({ heartbeatAt: 500, expiresAt: 1500 });
  });
});
