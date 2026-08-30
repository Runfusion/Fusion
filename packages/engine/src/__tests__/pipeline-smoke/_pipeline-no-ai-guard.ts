import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import type { PipelineGitFixture } from "./_pipeline-git-fixture.js";

export interface PipelineNoAiGuard {
  assertTestMode(settings: { testMode?: boolean }): void;
  assertMockRuntime(runtimeId: string): void;
  observedRuntimeIds(): readonly string[];
  assertLocalGitRemotes(fixture: PipelineGitFixture): void;
  installNetworkTripwire(): void;
  restore(): void;
}

function destinationAllowed(value: unknown, allowed: URL): boolean {
  if (typeof value === "string") {
    try {
      const candidate = new URL(value, "http://invalid");
      return candidate.hostname === allowed.hostname && (candidate.port === "" || candidate.port === (allowed.port || "5432"));
    } catch {
      return false;
    }
  }
  const candidate = value as { host?: string; hostname?: string; port?: string | number } | undefined;
  const host = candidate?.hostname ?? candidate?.host?.split(":")[0];
  const port = String(candidate?.port ?? "");
  return host === allowed.hostname && (port === "" || port === (allowed.port || "5432"));
}

function socketDestinationAllowed(args: readonly unknown[], allowed: URL): boolean {
  if (typeof args[0] === "number") {
    const host = typeof args[1] === "string" ? args[1] : allowed.hostname;
    return host === allowed.hostname && String(args[0]) === (allowed.port || "5432");
  }
  return destinationAllowed(args[0], allowed);
}

/*
FNXC:PipelineSmoke 2026-08-23-14:18:
FN-182's testMode boundary is only credible when a leaked provider or network path fails loudly.
The PostgreSQL harness endpoint is the sole transport exception; fixture git remotes are required
to be filesystem paths below the disposable fixture root.
*/
export function createPipelineNoAiGuard(testUrl: string): PipelineNoAiGuard {
  const allowed = new URL(testUrl);
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  let installed = false;
  const runtimeIds: string[] = [];
  const reject = (kind: string): never => { throw new Error(`Pipeline no-AI/network guard rejected ${kind}`); };

  return {
    assertTestMode: (settings) => {
      if (settings.testMode !== true) reject("a session without testMode: true");
    },
    assertMockRuntime: (runtimeId) => {
      runtimeIds.push(runtimeId);
      if (runtimeId !== "mock/scripted") reject(`runtime ${runtimeId}`);
    },
    observedRuntimeIds: () => [...runtimeIds],
    assertLocalGitRemotes: (fixture) => {
      const remotes = fixture.git(["remote", "-v"]).split("\n").filter(Boolean);
      if (remotes.length === 0 || remotes.some((line) => line.includes("://") || !line.includes(fixture.rootDir))) {
        reject("non-local git remote");
      }
    },
    installNetworkTripwire: () => {
      if (installed) return;
      installed = true;
      globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
        if (!destinationAllowed(input, allowed)) reject("fetch");
        return originalFetch(input);
      }) as typeof fetch;
      net.Socket.prototype.connect = function (...args: Parameters<typeof originalConnect>) {
        if (!socketDestinationAllowed(args, allowed)) reject("socket connect");
        return originalConnect.apply(this, args);
      };
      http.request = ((input: Parameters<typeof http.request>[0], ...args: unknown[]) => {
        if (!destinationAllowed(input, allowed)) reject("http request");
        return (originalHttpRequest as (...values: unknown[]) => ReturnType<typeof http.request>)(input, ...args);
      }) as typeof http.request;
      https.request = ((input: Parameters<typeof https.request>[0], ...args: unknown[]) => {
        if (!destinationAllowed(input, allowed)) reject("https request");
        return (originalHttpsRequest as (...values: unknown[]) => ReturnType<typeof https.request>)(input, ...args);
      }) as typeof https.request;
    },
    restore: () => {
      if (!installed) return;
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
      installed = false;
    },
  };
}
