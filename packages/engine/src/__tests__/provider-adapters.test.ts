import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTunnelProviderAdapter, redactTunnelText } from "../remote-access/provider-adapters.js";

describe("remote-access provider adapters", () => {
  it("builds redacted command previews and masks sensitive values", () => {
    const adapter = getTunnelProviderAdapter("cloudflare");
    const command = adapter.buildCommand({
      provider: "cloudflare",
      executablePath: "cloudflared",
      args: ["tunnel", "--token", "very-secret-token"],
      tokenEnvVar: "CLOUDFLARED_TOKEN",
      env: {
        CLOUDFLARED_TOKEN: "very-secret-token",
      },
    });

    expect(command.redactedPreview).toContain("[REDACTED]");
    expect(command.redactedPreview).not.toContain("very-secret-token");
    expect(redactTunnelText("token=very-secret-token", command.sensitiveValues)).toBe("token=[REDACTED]");
  });

  it("fails config validation when token env var reference is missing", () => {
    const adapter = getTunnelProviderAdapter("tailscale");
    expect(() =>
      adapter.buildCommand({
        provider: "tailscale",
        executablePath: "tailscale",
        args: ["serve", "status"],
        tokenEnvVar: "TS_AUTHKEY",
      }),
    ).toThrow(/invalid_config:missing credential in env var TS_AUTHKEY/);
  });

  it("validates cloudflare credentialsPath when path is provided", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fn-remote-access-"));
    const credentialsPath = join(tempDir, "credentials.json");
    writeFileSync(credentialsPath, "{}", "utf8");

    try {
      const adapter = getTunnelProviderAdapter("cloudflare");
      const command = adapter.buildCommand({
        provider: "cloudflare",
        executablePath: "cloudflared",
        args: ["tunnel", "run"],
        credentialsPath,
      });
      expect(command.command).toBe("cloudflared");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
