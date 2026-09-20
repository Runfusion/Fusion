import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

export const DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS = 10 * 60_000;
export const MAX_FUSION_BROWSER_IDLE_TIMEOUT_MS = 60 * 60_000;

export function resolveFusionBrowserIdleTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_FUSION_BROWSER_IDLE_TIMEOUT_MS;
  return Math.min(Math.trunc(timeout), MAX_FUSION_BROWSER_IDLE_TIMEOUT_MS);
}

/**
 * FNXC:AgentBrowserOwnership 2026-09-20-00:56:
 * The packed launcher only changes behavior when Fusion supplied an opaque lease.
 * Direct operator use retains upstream compatibility, while managed invocations renew
 * their exact lease and force a finite native idle deadline before starting the daemon.
 */
export function prepareFusionManagedBrowserEnv(env = process.env, now = Date.now()) {
  const sessionId = env.FUSION_AGENT_BROWSER_SESSION_ID;
  const leasePath = env.FUSION_AGENT_BROWSER_LEASE_PATH;
  if (!sessionId || !leasePath || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return env;
  const idleTimeoutMs = resolveFusionBrowserIdleTimeout(env.AGENT_BROWSER_IDLE_TIMEOUT_MS);
  try {
    const current = JSON.parse(awaitedRead(leasePath));
    if (current?.version !== 1 || current.sessionId !== sessionId || current.retiredAt !== undefined) return env;
    const lease = { ...current, heartbeatAt: now, expiresAt: now + idleTimeoutMs };
    mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 });
    const temporary = `${leasePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, leasePath);
  } catch {
    // An unreadable lease is deliberately fail-closed: do not claim Fusion ownership.
    return env;
  }
  return { ...env, AGENT_BROWSER_SESSION: sessionId, AGENT_BROWSER_IDLE_TIMEOUT_MS: String(idleTimeoutMs) };
}

function awaitedRead(path) {
  // stat first rejects directories before the bounded synchronous lease read.
  if (!statSync(path).isFile()) throw new Error("lease is not a file");
  return requireReadFile(path);
}

function requireReadFile(path) {
  return readFileSync(path, "utf8");
}
