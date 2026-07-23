import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  choosePreferredStoredCredential,
  extractClaudeCliStoredCredential,
  extractCodexCliStoredCredential,
  getClaudeCodeCredentialPaths,
  readStoredCredentialsFromAuthFile,
  shouldHydrateStoredCredential,
} from "../secrets/oauth-credential-interop.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function createJwt(payload: Record<string, unknown>): string {
  return [
    encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    encodeBase64Url(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

describe("oauth credential interop", () => {
  it("extracts Codex CLI OAuth credentials from auth.json token payload", () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = createJwt({
      exp: expiresAtSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });

    const credential = extractCodexCliStoredCredential({
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
      },
    });

    expect(credential).toEqual({
      type: "oauth",
      access: accessToken,
      refresh: "refresh-token",
      expires: expiresAtSeconds * 1000,
      accountId: "acct_123",
    });
  });

  it("falls back to last_refresh when Codex CLI JWT has no exp claim", () => {
    const accessToken = createJwt({
      sub: "user-123",
    });
    const lastRefresh = "2026-05-03T10:00:00.000Z";

    const credential = extractCodexCliStoredCredential({
      last_refresh: lastRefresh,
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: "acct_from_token",
      },
    });

    expect(credential?.type).toBe("oauth");
    expect(credential?.accountId).toBe("acct_from_token");
    expect(credential?.expires).toBe(Date.parse(lastRefresh) + 55 * 60 * 1000);
  });

  it("prefers a valid OAuth credential over an expired one and hydrates only when better", () => {
    const expired = {
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: Date.now() - 60_000,
    } as const;
    const valid = {
      type: "oauth",
      access: "valid-access",
      refresh: "valid-refresh",
      expires: Date.now() + 60_000,
    } as const;

    expect(choosePreferredStoredCredential(expired, valid)).toEqual(valid);
    expect(shouldHydrateStoredCredential(expired, valid)).toBe(true);
    expect(shouldHydrateStoredCredential({ type: "api_key", key: "sk-live" }, valid)).toBe(false);
  });

  it("extracts Claude OAuth credentials from .credentials.json payload", () => {
    const credential = extractClaudeCliStoredCredential({
      claudeAiOauth: {
        accessToken: "claude-access",
        refreshToken: "claude-refresh",
        expiresAt: Date.now() + 3600_000,
        scopes: ["user:profile", "org:create_api_key"],
      },
    });

    expect(credential).toEqual({
      type: "oauth",
      access: "claude-access",
      refresh: "claude-refresh",
      expires: expect.any(Number),
      scopes: ["user:profile", "org:create_api_key"],
    });
  });

  it("reads Claude credentials from auth file as anthropic OAuth", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fusion-oauth-interop-"));

    try {
      const authPath = join(tempDir, ".credentials.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access",
            refreshToken: "claude-refresh",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );

      expect(readStoredCredentialsFromAuthFile(authPath)).toEqual({
        anthropic: {
          type: "oauth",
          access: "claude-access",
          refresh: "claude-refresh",
          expires: expect.any(Number),
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns both supported Claude credential paths", () => {
    expect(getClaudeCodeCredentialPaths("/tmp/home")).toEqual([
      "/tmp/home/.claude/.credentials.json",
      "/tmp/home/.config/claude/.credentials.json",
    ]);
  });

  it("gracefully ignores malformed auth files", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fusion-oauth-interop-"));

    try {
      const malformedPath = join(tempDir, "auth.json");
      writeFileSync(malformedPath, "{ not-json");

      expect(readStoredCredentialsFromAuthFile(malformedPath)).toEqual({});
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
