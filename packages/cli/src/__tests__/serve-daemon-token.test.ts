// @vitest-environment node

/*
FNXC:ServeSecureByDefault 2026-07-26-17:35:
`fn serve` must be authenticated BY DEFAULT: resolveServeDaemonToken returns a token in
every configuration except the explicit `--no-auth` opt-out. A plain `fn serve` used to
resolve no token (only `--daemon` did), leaving the entire API — including the
approval-decision route — unauthenticated. Resolution priority (matching fn daemon /
fn dashboard): env FUSION_DAEMON_TOKEN > stored token (getOrCreateToken) > getToken()
> generateToken(). Pure DI unit tests — no disk, no settings store, no server.
*/

import { describe, it, expect, vi } from "vitest";
import { resolveServeDaemonToken, type ServeTokenManagerLike } from "../commands/serve-daemon-token.js";

function makeManager(overrides: Partial<ServeTokenManagerLike> = {}): ServeTokenManagerLike {
  return {
    getToken: vi.fn(async () => undefined),
    generateToken: vi.fn(async () => "generated-token"),
    ...overrides,
  };
}

describe("resolveServeDaemonToken", () => {
  it("returns undefined ONLY for the explicit --no-auth opt-out, even when an env token exists", async () => {
    const manager = makeManager();
    const token = await resolveServeDaemonToken(
      { noAuth: true },
      { env: { FUSION_DAEMON_TOKEN: "env-token" }, createTokenManager: () => manager },
    );

    expect(token).toBeUndefined();
    expect(manager.getToken).not.toHaveBeenCalled();
    expect(manager.generateToken).not.toHaveBeenCalled();
  });

  it("prefers the FUSION_DAEMON_TOKEN env var over the stored token", async () => {
    const manager = makeManager({ getOrCreateToken: vi.fn(async () => "stored-token") });
    const token = await resolveServeDaemonToken(
      {},
      { env: { FUSION_DAEMON_TOKEN: "env-token" }, createTokenManager: () => manager },
    );

    expect(token).toBe("env-token");
    expect(manager.getOrCreateToken).not.toHaveBeenCalled();
  });

  it("uses getOrCreateToken when the manager provides it (dashboard parity)", async () => {
    const manager = makeManager({ getOrCreateToken: vi.fn(async () => "stored-or-minted-token") });
    const token = await resolveServeDaemonToken({}, { env: {}, createTokenManager: () => manager });

    expect(token).toBe("stored-or-minted-token");
    expect(manager.getToken).not.toHaveBeenCalled();
    expect(manager.generateToken).not.toHaveBeenCalled();
  });

  it("falls back to an existing stored token when getOrCreateToken is unavailable", async () => {
    const manager = makeManager({ getToken: vi.fn(async () => "legacy-stored-token") });
    const token = await resolveServeDaemonToken({}, { env: {}, createTokenManager: () => manager });

    expect(token).toBe("legacy-stored-token");
    expect(manager.generateToken).not.toHaveBeenCalled();
  });

  it("mints and persists a new token when nothing is configured — plain `fn serve` is authenticated by default", async () => {
    const manager = makeManager();
    const token = await resolveServeDaemonToken({}, { env: {}, createTokenManager: () => manager });

    expect(token).toBe("generated-token");
    expect(manager.generateToken).toHaveBeenCalledTimes(1);
  });

  it("resolves a token when noAuth is absent/false (never silently unauthenticated)", async () => {
    const manager = makeManager();
    const token = await resolveServeDaemonToken({ noAuth: false }, { env: {}, createTokenManager: () => manager });

    expect(token).toBe("generated-token");
  });
});
