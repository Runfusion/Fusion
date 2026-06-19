import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StoredAuthCredential = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  scopes?: string[];
  accountId?: string;
  [key: string]: unknown;
};

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_REFRESH_FALLBACK_WINDOW_MS = 55 * 60 * 1000;

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function getCodexCliAuthPath(home = getHomeDir()): string {
  return join(home, ".codex", "auth.json");
}

export function getClaudeCodeCredentialPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".claude", ".credentials.json"),
    join(home, ".config", "claude", ".credentials.json"),
  ];
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload = ""] = token.split(".", 3);
    if (!payload) {
      return null;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) {
    return undefined;
  }
  const payload = parseJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return undefined;
  }
  return exp * 1000;
}

function getCodexAccountId(accessToken: string, fallbackAccountId: unknown): string | undefined {
  const payload = parseJwtPayload(accessToken);
  const authClaim = payload?.[OPENAI_AUTH_CLAIM];
  const claimAccountId =
    authClaim && typeof authClaim === "object"
      ? (authClaim as Record<string, unknown>).chatgpt_account_id
      : undefined;
  if (typeof claimAccountId === "string" && claimAccountId.trim().length > 0) {
    return claimAccountId;
  }
  if (typeof fallbackAccountId === "string" && fallbackAccountId.trim().length > 0) {
    return fallbackAccountId;
  }
  return undefined;
}

function getLastRefreshFallbackExpiryMs(lastRefresh: unknown): number | undefined {
  if (typeof lastRefresh !== "string" || lastRefresh.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(lastRefresh);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed + CODEX_REFRESH_FALLBACK_WINDOW_MS;
}

function isStoredAuthCredential(value: unknown): value is StoredAuthCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "oauth" || record.type === "api_key";
}

function isValidOauthCredential(credential: StoredAuthCredential | undefined): boolean {
  return credential?.type === "oauth"
    && typeof credential.access === "string"
    && credential.access.length > 0
    && typeof credential.refresh === "string"
    && credential.refresh.length > 0
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires)
    && Date.now() < credential.expires;
}

function isRefreshableOauthCredential(credential: StoredAuthCredential | undefined): boolean {
  return credential?.type === "oauth"
    && typeof credential.refresh === "string"
    && credential.refresh.length > 0
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires);
}

function compareStoredCredentials(
  left: StoredAuthCredential | undefined,
  right: StoredAuthCredential | undefined,
): number {
  if (!left && !right) {
    return 0;
  }
  if (left && !right) {
    return 1;
  }
  if (!left && right) {
    return -1;
  }

  if (left?.type === "api_key" && right?.type !== "api_key") {
    return 1;
  }
  if (right?.type === "api_key" && left?.type !== "api_key") {
    return -1;
  }

  if (left?.type === "oauth" && right?.type === "oauth") {
    const leftValid = isValidOauthCredential(left);
    const rightValid = isValidOauthCredential(right);
    if (leftValid !== rightValid) {
      return leftValid ? 1 : -1;
    }

    const leftRefreshable = isRefreshableOauthCredential(left);
    const rightRefreshable = isRefreshableOauthCredential(right);
    if (leftRefreshable !== rightRefreshable) {
      return leftRefreshable ? 1 : -1;
    }

    const leftExpiry = typeof left.expires === "number" && Number.isFinite(left.expires) ? left.expires : -Infinity;
    const rightExpiry = typeof right.expires === "number" && Number.isFinite(right.expires) ? right.expires : -Infinity;
    if (leftExpiry !== rightExpiry) {
      return leftExpiry > rightExpiry ? 1 : -1;
    }

    const leftAccessLength = typeof left.access === "string" ? left.access.length : 0;
    const rightAccessLength = typeof right.access === "string" ? right.access.length : 0;
    if (leftAccessLength !== rightAccessLength) {
      return leftAccessLength > rightAccessLength ? 1 : -1;
    }
  }

  return 0;
}

export function choosePreferredStoredCredential(
  ...credentials: Array<StoredAuthCredential | undefined>
): StoredAuthCredential | undefined {
  let best: StoredAuthCredential | undefined;
  for (const credential of credentials) {
    if (compareStoredCredentials(credential, best) > 0) {
      best = credential;
    }
  }
  return best;
}

export function shouldHydrateStoredCredential(
  current: StoredAuthCredential | undefined,
  candidate: StoredAuthCredential | undefined,
): boolean {
  if (!candidate || candidate.type !== "oauth") {
    return false;
  }
  if (current?.type === "api_key") {
    return false;
  }
  return compareStoredCredentials(candidate, current) > 0;
}

export function extractCodexCliStoredCredential(raw: unknown): StoredAuthCredential | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return undefined;
  }

  const tokenRecord = tokens as Record<string, unknown>;
  const access = typeof tokenRecord.access_token === "string" ? tokenRecord.access_token : undefined;
  const refresh = typeof tokenRecord.refresh_token === "string" ? tokenRecord.refresh_token : undefined;
  if (!access || !refresh) {
    return undefined;
  }

  const expires =
    getJwtExpiryMs(access)
    ?? getJwtExpiryMs(typeof tokenRecord.id_token === "string" ? tokenRecord.id_token : undefined)
    ?? getLastRefreshFallbackExpiryMs(record.last_refresh);
  if (typeof expires !== "number" || !Number.isFinite(expires)) {
    return undefined;
  }

  const accountId = getCodexAccountId(access, tokenRecord.account_id);

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

export function extractClaudeCliStoredCredential(raw: unknown): StoredAuthCredential | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const oauthRecord =
    record.claudeAiOauth && typeof record.claudeAiOauth === "object" && !Array.isArray(record.claudeAiOauth)
      ? (record.claudeAiOauth as Record<string, unknown>)
      : record;

  const access = typeof oauthRecord.accessToken === "string" ? oauthRecord.accessToken : undefined;
  const refresh = typeof oauthRecord.refreshToken === "string" ? oauthRecord.refreshToken : undefined;
  const expiresRaw = oauthRecord.expiresAt;
  const expires = typeof expiresRaw === "number" && Number.isFinite(expiresRaw) ? expiresRaw : undefined;
  const scopes = Array.isArray(oauthRecord.scopes)
    ? oauthRecord.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
    : undefined;

  if (!access || !refresh || expires === undefined) {
    return undefined;
  }

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

export function readStoredCredentialsFromAuthFile(authPath: string): Record<string, StoredAuthCredential> {
  if (!existsSync(authPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
    const codexCliCredential = extractCodexCliStoredCredential(parsed);
    if (codexCliCredential) {
      return { "openai-codex": codexCliCredential };
    }

    const claudeCliCredential = extractClaudeCliStoredCredential(parsed);
    if (claudeCliCredential) {
      return { anthropic: claudeCliCredential };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const credentials: Record<string, StoredAuthCredential> = {};
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isStoredAuthCredential(value)) {
        continue;
      }
      credentials[providerId] = value;
    }
    return credentials;
  } catch {
    return {};
  }
}
