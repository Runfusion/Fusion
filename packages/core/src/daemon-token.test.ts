import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { GlobalSettingsStore } from "./global-settings.js";
import {
  DaemonTokenManager,
  DAEMON_TOKEN_PREFIX,
  DAEMON_TOKEN_HEX_LENGTH,
  isDaemonTokenFormat,
} from "./daemon-token.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-daemon-token-test-"));
}

describe("isDaemonTokenFormat", () => {
  it("returns true for valid format", () => {
    expect(isDaemonTokenFormat("fn_a1b2c3d4e5f6789012345678abcdef01")).toBe(true);
  });

  it("returns true for all lowercase hex", () => {
    expect(isDaemonTokenFormat("fn_0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("returns false for missing prefix", () => {
    expect(isDaemonTokenFormat("a1b2c3d4e5f6789012345678abcdef01")).toBe(false);
  });

  it("returns false for wrong prefix", () => {
    expect(isDaemonTokenFormat("fn__a1b2c3d4e5f6789012345678abcdef01")).toBe(false);
  });

  it("returns false for wrong length (too short)", () => {
    expect(isDaemonTokenFormat("fn_a1b2c3d4e5f6789012345678abcdef0")).toBe(false);
  });

  it("returns false for wrong length (too long)", () => {
    expect(isDaemonTokenFormat("fn_a1b2c3d4e5f6789012345678abcdef012")).toBe(false);
  });

  it("returns false for uppercase hex", () => {
    expect(isDaemonTokenFormat("fn_A1B2C3D4E5F6789012345678ABCDEF01")).toBe(false);
  });

  it("returns false for mixed case hex", () => {
    expect(isDaemonTokenFormat("fn_A1b2C3d4E5f6789012345678AbCdEf01")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isDaemonTokenFormat("")).toBe(false);
  });

  it("returns false for special characters", () => {
    expect(isDaemonTokenFormat("fn_a1b2c3d4e5f6789012345678abcdef0!")).toBe(false);
  });

  it("returns false for prefix only", () => {
    expect(isDaemonTokenFormat("fn_")).toBe(false);
  });
});

describe("DaemonTokenManager", () => {
  let dir: string;
  let store: GlobalSettingsStore;
  let manager: DaemonTokenManager;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new GlobalSettingsStore(dir);
    manager = new DaemonTokenManager(store);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("generateToken()", () => {
    it("generates a token with correct format", async () => {
      const token = await manager.generateToken();

      expect(token).toMatch(/^fn_[0-9a-f]{32}$/);
      expect(token.startsWith(DAEMON_TOKEN_PREFIX)).toBe(true);
      expect(token.length).toBe(DAEMON_TOKEN_PREFIX.length + DAEMON_TOKEN_HEX_LENGTH);
    });

    it("stores the token in settings", async () => {
      const token = await manager.generateToken();
      const settings = await store.getSettings();

      expect(settings.daemonToken).toBe(token);
    });

    it("returns the generated token", async () => {
      const token = await manager.generateToken();

      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("throws if token already exists", async () => {
      await manager.generateToken();

      await expect(manager.generateToken()).rejects.toThrow(
        "Daemon token already exists. Use rotateToken() to replace it.",
      );
    });

    it("generates unique tokens on each call", async () => {
      // First, rotate to get an existing token
      const firstToken = await manager.rotateToken();

      // Rotate again to get a second token
      const secondToken = await manager.rotateToken();

      expect(firstToken).not.toBe(secondToken);
    });
  });

  describe("getToken()", () => {
    it("returns undefined when no token", async () => {
      const token = await manager.getToken();

      expect(token).toBeUndefined();
    });

    it("returns stored token after generation", async () => {
      const generated = await manager.generateToken();

      const retrieved = await manager.getToken();

      expect(retrieved).toBe(generated);
    });

    it("returns stored token after rotation", async () => {
      await manager.rotateToken();

      const retrieved = await manager.getToken();

      expect(retrieved).toMatch(/^fn_[0-9a-f]{32}$/);
    });
  });

  describe("validateToken()", () => {
    it("returns true for valid token", async () => {
      const token = await manager.generateToken();

      const isValid = await manager.validateToken(token);

      expect(isValid).toBe(true);
    });

    it("returns false for wrong token", async () => {
      await manager.generateToken();

      const isValid = await manager.validateToken(
        "fn_00000000000000000000000000000001",
      );

      expect(isValid).toBe(false);
    });

    it("returns false when no token stored", async () => {
      const isValid = await manager.validateToken(
        "fn_a1b2c3d4e5f6789012345678abcdef01",
      );

      expect(isValid).toBe(false);
    });

    it("returns false for empty string", async () => {
      await manager.generateToken();

      const isValid = await manager.validateToken("");

      expect(isValid).toBe(false);
    });

    it("returns false for wrong length token", async () => {
      await manager.generateToken();

      const isValid = await manager.validateToken(
        "fn_a1b2c3d4e5f6789012345678abcdef0", // one char short
      );

      expect(isValid).toBe(false);
    });

    it("handles timing-safe comparison correctly", async () => {
      const token = await manager.generateToken();

      // Valid token should return true
      expect(await manager.validateToken(token)).toBe(true);

      // Invalid token should return false
      expect(await manager.validateToken("fn_00000000000000000000000000000001")).toBe(false);
    });
  });

  describe("rotateToken()", () => {
    it("generates new token replacing old", async () => {
      const oldToken = await manager.generateToken();

      const newToken = await manager.rotateToken();

      expect(newToken).not.toBe(oldToken);
      expect(newToken).toMatch(/^fn_[0-9a-f]{32}$/);
    });

    it("returns different token each call", async () => {
      const tokens = new Set<string>();

      for (let i = 0; i < 5; i++) {
        tokens.add(await manager.rotateToken());
      }

      // All tokens should be unique
      expect(tokens.size).toBe(5);
    });

    it("works when no existing token", async () => {
      const token = await manager.rotateToken();

      expect(token).toMatch(/^fn_[0-9a-f]{32}$/);
      expect(await manager.getToken()).toBe(token);
    });

    it("stores new token after rotation", async () => {
      await manager.generateToken();

      await manager.rotateToken();

      const stored = await manager.getToken();
      expect(stored).toMatch(/^fn_[0-9a-f]{32}$/);
    });
  });

  describe("integration: full lifecycle", () => {
    it("generate → validate → rotate → validate new → old token fails", async () => {
      // Generate a token
      const token = await manager.generateToken();

      // Validate the original token
      expect(await manager.validateToken(token)).toBe(true);

      // Rotate to get a new token
      const newToken = await manager.rotateToken();

      // Old token should no longer be valid
      expect(await manager.validateToken(token)).toBe(false);

      // New token should be valid
      expect(await manager.validateToken(newToken)).toBe(true);

      // New token should be different from old
      expect(newToken).not.toBe(token);
    });
  });

  describe("token format specifics", () => {
    it("generated token has correct prefix", async () => {
      const token = await manager.generateToken();

      expect(token.startsWith(DAEMON_TOKEN_PREFIX)).toBe(true);
    });

    it("generated token has exactly 32 lowercase hex chars", async () => {
      const token = await manager.generateToken();

      const hexPart = token.slice(DAEMON_TOKEN_PREFIX.length);
      expect(hexPart).toMatch(/^[0-9a-f]{32}$/);
    });

    it("generated token has correct total length", async () => {
      const token = await manager.generateToken();

      expect(token.length).toBe(DAEMON_TOKEN_PREFIX.length + DAEMON_TOKEN_HEX_LENGTH);
    });
  });

  describe("DAEMON_TOKEN_PREFIX constant", () => {
    it("is fn_", () => {
      expect(DAEMON_TOKEN_PREFIX).toBe("fn_");
    });
  });

  describe("DAEMON_TOKEN_HEX_LENGTH constant", () => {
    it("is 32", () => {
      expect(DAEMON_TOKEN_HEX_LENGTH).toBe(32);
    });
  });
});
