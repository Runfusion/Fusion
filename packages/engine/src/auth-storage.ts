import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

type StoredCredential = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
};

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function getFusionAuthPath(home = getHomeDir()): string {
  return join(home, ".fusion", "agent", "auth.json");
}

function getLegacyAuthPaths(home = getHomeDir()): string[] {
  return [
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];
}

function readLegacyCredentials(authPaths = getLegacyAuthPaths()): Record<string, StoredCredential> {
  const credentials: Record<string, StoredCredential> = {};

  for (const authPath of authPaths) {
    if (!existsSync(authPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, StoredCredential>;
      for (const [provider, credential] of Object.entries(parsed)) {
        credentials[provider] ??= credential;
      }
    } catch {
      // Ignore invalid legacy auth files and continue with other candidates.
    }
  }

  return credentials;
}

function resolveStoredApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return process.env[key] ?? key;
}

function resolveOAuthApiKey(providerId: string, credential: StoredCredential): string | undefined {
  if (
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    typeof credential.refresh !== "string" ||
    typeof credential.expires !== "number" ||
    Date.now() >= credential.expires
  ) {
    return undefined;
  }

  return getOAuthProvider(providerId)?.getApiKey(credential as OAuthCredentials);
}

function resolveStoredCredentialApiKey(providerId: string, credential: StoredCredential | undefined): string | undefined {
  if (credential?.type === "api_key") {
    return resolveStoredApiKey(credential.key);
  }
  if (credential?.type === "oauth") {
    return resolveOAuthApiKey(providerId, credential);
  }
  return undefined;
}

export function createFusionAuthStorage(): AuthStorage {
  const primary = AuthStorage.create(getFusionAuthPath());
  let legacyCredentials = readLegacyCredentials();

  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (prop === "reload") {
        return () => {
          target.reload();
          legacyCredentials = readLegacyCredentials();
        };
      }

      if (prop === "get") {
        return (provider: string) => target.get(provider) ?? legacyCredentials[provider];
      }

      if (prop === "has") {
        return (provider: string) => target.has(provider) || provider in legacyCredentials;
      }

      if (prop === "hasAuth") {
        return (provider: string) => target.hasAuth(provider) || Boolean(legacyCredentials[provider]);
      }

      if (prop === "getAll") {
        return () => ({ ...legacyCredentials, ...target.getAll() });
      }

      if (prop === "list") {
        return () => Array.from(new Set([...Object.keys(legacyCredentials), ...target.list()]));
      }

      if (prop === "getApiKey") {
        return async (provider: string) => {
          const primaryKey = await target.getApiKey(provider);
          if (primaryKey) return primaryKey;

          return resolveStoredCredentialApiKey(provider, legacyCredentials[provider]);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as AuthStorage;
}
