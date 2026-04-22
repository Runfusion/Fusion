import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
function getHomeDir() {
    return process.env.HOME || process.env.USERPROFILE || homedir();
}
export function getFusionAuthPath(home = getHomeDir()) {
    return join(home, ".fusion", "agent", "auth.json");
}
export function getFusionModelsPath(home = getHomeDir()) {
    return join(home, ".fusion", "agent", "models.json");
}
function getLegacyAuthPaths(home = getHomeDir()) {
    return [
        join(home, ".pi", "agent", "auth.json"),
        join(home, ".pi", "auth.json"),
    ];
}
function getLegacyModelsPaths(home = getHomeDir()) {
    return [
        join(home, ".pi", "agent", "models.json"),
        join(home, ".pi", "models.json"),
    ];
}
export function getModelRegistryModelsPath(home = getHomeDir()) {
    const fusionModelsPath = getFusionModelsPath(home);
    if (existsSync(fusionModelsPath)) {
        return fusionModelsPath;
    }
    return getLegacyModelsPaths(home).find((modelsPath) => existsSync(modelsPath)) ?? fusionModelsPath;
}
function readLegacyCredentials(authPaths = getLegacyAuthPaths()) {
    const credentials = {};
    for (const authPath of authPaths) {
        if (!existsSync(authPath)) {
            continue;
        }
        try {
            const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
            for (const [provider, credential] of Object.entries(parsed)) {
                credentials[provider] ??= credential;
            }
        }
        catch {
            // Ignore invalid legacy auth files and continue with other candidates.
        }
    }
    return credentials;
}
function resolveStoredApiKey(key) {
    if (!key)
        return undefined;
    return process.env[key] ?? key;
}
function resolveOAuthApiKey(providerId, credential) {
    if (credential.type !== "oauth" ||
        typeof credential.access !== "string" ||
        typeof credential.refresh !== "string" ||
        typeof credential.expires !== "number" ||
        Date.now() >= credential.expires) {
        return undefined;
    }
    return getOAuthProvider(providerId)?.getApiKey(credential);
}
function resolveStoredCredentialApiKey(providerId, credential) {
    if (credential?.type === "api_key") {
        return resolveStoredApiKey(credential.key);
    }
    if (credential?.type === "oauth") {
        return resolveOAuthApiKey(providerId, credential);
    }
    return undefined;
}
export function createFusionAuthStorage() {
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
                return (provider) => target.get(provider) ?? legacyCredentials[provider];
            }
            if (prop === "has") {
                return (provider) => target.has(provider) || provider in legacyCredentials;
            }
            if (prop === "hasAuth") {
                return (provider) => target.hasAuth(provider) || Boolean(legacyCredentials[provider]);
            }
            if (prop === "getAll") {
                return () => ({ ...legacyCredentials, ...target.getAll() });
            }
            if (prop === "list") {
                return () => Array.from(new Set([...Object.keys(legacyCredentials), ...target.list()]));
            }
            if (prop === "getApiKey") {
                return async (provider) => {
                    const primaryKey = await target.getApiKey(provider);
                    if (primaryKey)
                        return primaryKey;
                    return resolveStoredCredentialApiKey(provider, legacyCredentials[provider]);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}
//# sourceMappingURL=auth-storage.js.map