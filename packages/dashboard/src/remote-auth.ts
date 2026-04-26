import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ProjectSettings } from "@fusion/core";

export type RemoteTokenValidationStatus = "valid" | "missing" | "invalid" | "expired" | "disabled";
export type RemoteTokenType = "persistent" | "short-lived";

type RemoteAccessSettings = NonNullable<ProjectSettings["remoteAccess"]>;

interface ShortLivedTokenEntry {
  expiresAtMs: number;
  issuedAtMs: number;
}

export interface RemoteTokenValidationResult {
  status: RemoteTokenValidationStatus;
  tokenType?: RemoteTokenType;
  expiresAt?: string;
}

export interface IssueRemoteTokenResult {
  token: string;
  tokenType: RemoteTokenType;
  expiresAt?: string;
}

const DEFAULT_SHORT_LIVED_TTL_MS = 900_000;
const MIN_SHORT_LIVED_TTL_MS = 60_000;
const MAX_SHORT_LIVED_TTL_MS = 86_400_000;

const shortLivedTokens = new Map<string, ShortLivedTokenEntry>();

export function constantTimeEqual(provided: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuffer.length) {
    return false;
  }

  try {
    const providedBuffer = Buffer.from(provided, "utf8");
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function generateRemoteToken(): string {
  return `frt_${randomBytes(20).toString("base64url")}`;
}

export function maskRemoteToken(token: string): string {
  if (token.length <= 8) {
    return "********";
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function resolveEffectiveShortLivedTtlMs(settings: RemoteAccessSettings): number {
  const configured = Number(settings.tokenStrategy.shortLived.ttlMs ?? DEFAULT_SHORT_LIVED_TTL_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_SHORT_LIVED_TTL_MS;
  }

  const maxConfigured = Number(settings.tokenStrategy.shortLived.maxTtlMs ?? MAX_SHORT_LIVED_TTL_MS);
  const boundedMax = Number.isFinite(maxConfigured)
    ? Math.min(Math.max(maxConfigured, MIN_SHORT_LIVED_TTL_MS), MAX_SHORT_LIVED_TTL_MS)
    : MAX_SHORT_LIVED_TTL_MS;

  return Math.min(Math.max(configured, MIN_SHORT_LIVED_TTL_MS), boundedMax);
}

export function issueRemoteAuthToken(
  mode: RemoteTokenType,
  settings: RemoteAccessSettings,
  nowMs: number = Date.now(),
): IssueRemoteTokenResult {
  purgeExpiredRemoteShortLivedTokens(nowMs);
  if (mode === "persistent") {
    const persistentToken = settings.tokenStrategy.persistent.token;
    if (!settings.tokenStrategy.persistent.enabled || !persistentToken) {
      throw new Error("Persistent remote token is not configured");
    }

    return {
      token: persistentToken,
      tokenType: "persistent",
    };
  }

  if (!settings.tokenStrategy.shortLived.enabled) {
    throw new Error("Short-lived token mode is disabled");
  }

  const ttlMs = resolveEffectiveShortLivedTtlMs(settings);
  const token = generateRemoteToken();
  const expiresAtMs = nowMs + ttlMs;

  shortLivedTokens.set(token, { expiresAtMs, issuedAtMs: nowMs });

  return {
    token,
    tokenType: "short-lived",
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function isRemoteAccessTokenStrategyEnabled(settings: RemoteAccessSettings): boolean {
  return settings.tokenStrategy.persistent.enabled || settings.tokenStrategy.shortLived.enabled;
}

function isRemoteProviderEnabled(settings: RemoteAccessSettings): boolean {
  return Boolean(settings.activeProvider != null && settings.providers[settings.activeProvider]?.enabled);
}

export function validateRemoteAuthToken(
  rt: string | null | undefined,
  settings: RemoteAccessSettings,
  nowMs: number = Date.now(),
): RemoteTokenValidationResult {
  if (!isRemoteProviderEnabled(settings) || !isRemoteAccessTokenStrategyEnabled(settings)) {
    return { status: "disabled" };
  }

  if (!rt) {
    return { status: "missing" };
  }

  const persistent = settings.tokenStrategy.persistent;
  if (persistent.enabled && persistent.token && constantTimeEqual(rt, persistent.token)) {
    return { status: "valid", tokenType: "persistent" };
  }

  const shortLived = settings.tokenStrategy.shortLived;
  const issued = shortLivedTokens.get(rt);
  if (shortLived.enabled && issued) {
    const ttlMs = resolveEffectiveShortLivedTtlMs(settings);
    const configuredExpiryMs = issued.issuedAtMs + ttlMs;
    const effectiveExpiryMs = Math.min(issued.expiresAtMs, configuredExpiryMs);
    if (nowMs > effectiveExpiryMs) {
      shortLivedTokens.delete(rt);
      return {
        status: "expired",
        tokenType: "short-lived",
        expiresAt: new Date(effectiveExpiryMs).toISOString(),
      };
    }

    return {
      status: "valid",
      tokenType: "short-lived",
      expiresAt: new Date(effectiveExpiryMs).toISOString(),
    };
  }

  return { status: "invalid" };
}

export function purgeExpiredRemoteShortLivedTokens(nowMs: number = Date.now()): void {
  for (const [token, entry] of shortLivedTokens.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      shortLivedTokens.delete(token);
    }
  }
}

export function __resetRemoteAuthStateForTests(): void {
  shortLivedTokens.clear();
}
