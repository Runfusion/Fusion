/**
 * Daemon token management for fn daemon mode authentication.
 *
 * Daemon tokens are stored in global settings and used to authenticate
 * CLI clients connecting to the daemon server.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { GlobalSettingsStore } from "./global-settings.js";

/** Prefix for daemon authentication tokens. */
export const DAEMON_TOKEN_PREFIX = "fn_";

/** Number of hex characters in the token body (16 bytes = 32 hex chars). */
export const DAEMON_TOKEN_HEX_LENGTH = 32;

/** Regular expression for validating daemon token format. */
const DAEMON_TOKEN_REGEX = /^fn_[0-9a-f]{32}$/;

/**
 * Validate that a string matches the daemon token format (fn_<32 hex chars>).
 *
 * @param value - The string to validate
 * @returns true if the string matches the expected format
 */
export function isDaemonTokenFormat(value: string): boolean {
  return DAEMON_TOKEN_REGEX.test(value);
}

/**
 * Manages daemon authentication token lifecycle: generation, storage, validation, and rotation.
 *
 * Tokens are stored in global settings alongside user preferences. This class
 * provides a clean API for CLI and server components to manage daemon tokens
 * without directly coupling to GlobalSettingsStore.
 */
export class DaemonTokenManager {
  constructor(private readonly settingsStore: GlobalSettingsStore) {}

  /**
   * Generate a new daemon token and store it.
   *
   * @returns The generated token string (e.g., "fn_a1b2c3...")
   * @throws Error if a token already exists. Use rotateToken() to replace.
   */
  async generateToken(): Promise<string> {
    const existing = await this.settingsStore.getSettings();
    if (existing.daemonToken !== undefined) {
      throw new Error("Daemon token already exists. Use rotateToken() to replace it.");
    }

    const token = this.generateTokenValue();
    await this.settingsStore.updateSettings({ daemonToken: token });
    return token;
  }

  /**
   * Retrieve the currently stored daemon token, if any.
   *
   * @returns The stored token or undefined if no token has been generated.
   */
  async getToken(): Promise<string | undefined> {
    const settings = await this.settingsStore.getSettings();
    return settings.daemonToken;
  }

  /**
   * Retrieve the existing daemon token or create/persist one if missing.
   *
   * Safe for concurrent callers: if another process writes the token between
   * the initial read and generateToken(), this method re-reads and returns the
   * persisted token instead of failing.
   */
  async getOrCreateToken(): Promise<string> {
    const existing = await this.getToken();
    if (existing) {
      return existing;
    }

    try {
      return await this.generateToken();
    } catch (error) {
      const afterRace = await this.getToken();
      if (afterRace) {
        return afterRace;
      }
      throw error;
    }
  }

  /**
   * Validate that a provided token matches the stored token.
   *
   * Uses constant-time comparison to prevent timing attacks.
   *
   * @param token - The token to validate
   * @returns true if the token matches the stored token, false otherwise
   */
  async validateToken(token: string): Promise<boolean> {
    const stored = await this.getToken();

    // No stored token means validation fails
    if (stored === undefined) {
      return false;
    }

    // Fast path: check length first to avoid unnecessary crypto calls
    if (token.length !== stored.length) {
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    try {
      const tokenBuffer = Buffer.from(token, "utf8");
      const storedBuffer = Buffer.from(stored, "utf8");
      return timingSafeEqual(tokenBuffer, storedBuffer);
    } catch {
      // Buffer lengths don't match (shouldn't happen if length check passes)
      // or encoding issues - treat as mismatch
      return false;
    }
  }

  /**
   * Generate a new token, replacing any existing token.
   *
   * This method is idempotent: it works whether or not a token currently exists.
   *
   * @returns The newly generated token string
   */
  async rotateToken(): Promise<string> {
    const token = this.generateTokenValue();
    await this.settingsStore.updateSettings({ daemonToken: token });
    return token;
  }

  /**
   * Generate a random token value without storing it.
   *
   * @internal
   * @returns A new token string in the format "fn_<32 hex chars>"
   */
  private generateTokenValue(): string {
    const hexChars = randomBytes(16).toString("hex");
    return `${DAEMON_TOKEN_PREFIX}${hexChars}`;
  }
}
