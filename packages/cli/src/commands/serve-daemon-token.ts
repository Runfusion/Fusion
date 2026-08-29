import { DaemonTokenManager, GlobalSettingsStore, resolveGlobalDir } from "@fusion/core";

/*
FNXC:ServeSecureByDefault 2026-07-26-16:50:
`fn serve` used to resolve a bearer token only when `--daemon` was passed, so a plain
`fn serve` exposed the entire API — including the approval-decision route an AI agent
used to self-approve deleting a live task — unauthenticated to anything that could reach
the socket. This module makes token resolution unconditional: serve ALWAYS resolves (or
mints and persists) a daemon token unless the operator explicitly opts out with
`--no-auth`. Resolution priority matches `fn daemon` / `fn dashboard`
(resolveDashboardAuthToken): env FUSION_DAEMON_TOKEN > stored global-settings token >
newly generated persisted token.

Kept as a small standalone module (not inside serve.ts) so the resolution policy is
unit-testable without importing serve's heavy dashboard/engine module graph, and so the
token-manager seam can be injected by tests instead of mocking @fusion/core.
*/

/** Minimal token-manager seam; mirrors DaemonTokenManager's surface used here. */
export interface ServeTokenManagerLike {
  getOrCreateToken?: () => Promise<string>;
  getToken(): Promise<string | undefined | null>;
  generateToken(): Promise<string>;
}

export interface ResolveServeDaemonTokenDeps {
  /** Environment source; defaults to process.env. Injectable for tests. */
  env?: Pick<NodeJS.ProcessEnv, "FUSION_DAEMON_TOKEN">;
  /** Token-manager factory; defaults to the real global-settings-backed manager. */
  createTokenManager?: () => ServeTokenManagerLike;
}

function createDefaultTokenManager(): ServeTokenManagerLike {
  const globalDir = resolveGlobalDir();
  const settingsStore = new GlobalSettingsStore(globalDir);
  return new DaemonTokenManager(settingsStore);
}

/**
 * FNXC:ServeSecureByDefault 2026-07-26-16:50:
 * Resolve the bearer token `fn serve` will install auth with. Returns undefined ONLY
 * when the operator explicitly passed `--no-auth`; every other path yields a token so
 * the served API is authenticated by default.
 */
export async function resolveServeDaemonToken(
  opts: { noAuth?: boolean },
  deps: ResolveServeDaemonTokenDeps = {},
): Promise<string | undefined> {
  if (opts.noAuth) {
    return undefined;
  }

  const envToken = (deps.env ?? process.env).FUSION_DAEMON_TOKEN;
  if (envToken) {
    return envToken;
  }

  const tokenManager = (deps.createTokenManager ?? createDefaultTokenManager)();
  if (typeof tokenManager.getOrCreateToken === "function") {
    return tokenManager.getOrCreateToken();
  }

  const existingToken = await tokenManager.getToken();
  if (existingToken) {
    return existingToken;
  }
  return tokenManager.generateToken();
}
