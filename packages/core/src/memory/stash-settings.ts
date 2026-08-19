/**
 * FNXC:RUFU121StashSettingsInCore 2026-08-18-19:53:
 * RUFU-121 Step 3: Stash memory-backend settings + secret resolution, moved
 * VERBATIM from packages/engine/src/executor/memory-capture.ts (RUFU-068
 * origin: FNXC:MemoryCapture 2026-08-13-18:05) into @fusion/core so the
 * dashboard chat-delete sync route — which must not import @fusion/engine —
 * can resolve the SAME settings + secret contract as the engine capture
 * chain. The engine re-exports every symbol from its former location so all
 * existing engine import sites (free-reexports, executor tests) keep working.
 * No behavior change: same key name, same global scope, same row-UUID
 * resolution, same fail-closed empty-key degradation.
 */

/**
 * Structural view of memory-related settings used by capture resolution. Mirrors the domain
 * type consumed by the core capture helper (memory is disabled or not-stash → no-op).
 */
export interface MemoryBackendSettings {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  stashUrl?: string;
  stashApiKey?: string;
  [key: string]: unknown;
}

/**
 * Minimal duck-typed secrets-store surface used by stash-secret resolution.
 * `TaskStore.getSecretsStore()` conforms to this; a store without one (e.g. mock TaskStore
 * helpers in tests) simply has no key and degrades to an empty key (fail-closed, never throws).
 */
export interface StashSecretsReader {
  getSecretsStore?: () => Promise<{
    /**
     * FNXC:StashSecretResolution 2026-08-18-14:46:
     * Optional metadata listing (AsyncSecretsStore exposes it). Used to resolve the
     * secret row UUID so revealSecret can match the `id` column. Mocks/legacy stores
     * may omit it; resolution then falls back to the direct reveal attempt below.
     */
    listSecrets?(scope?: string): Promise<Array<{ id: string; key: string }>>;
    /**
     * FNXC:StashSecretResolution 2026-08-18-14:46:
     * AsyncSecretsStore resolves `id` against the row UUID column (eq(table.id, id)) —
     * a display key name can never match. Callers must pass the row id.
     */
    revealSecret(
      id: string,
      scope: string,
      reader: { agentId?: string | null },
    ): Promise<{ plaintextValue: string }>;
  }>;
}

export const STASH_SECRET_KEY = "stash-api-key";
export const STASH_SECRET_SCOPE = "global";

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * Resolves the Stash API key for a memory-backend settings object. The key is NEVER hardcoded
 * or committed: it is read from the global secrets store (`stash-api-key`) and a per-project
 * `settings.stashApiKey` override wins. Non-stash backends never read secrets. A missing or
 * undecryptable secret degrades to an empty key without throwing (fail-closed), so capture
 * remains a no-op rather than an error.
 */
export async function resolveStashMemorySettings(
  store: StashSecretsReader,
  settings: MemoryBackendSettings | undefined,
): Promise<MemoryBackendSettings | undefined> {
  if (!settings || settings.memoryEnabled === false) return settings;
  if ((settings.memoryBackendType as string | undefined) !== "stash") return settings;
  if (settings.stashApiKey) return settings;
  let apiKey = "";
  try {
    const secrets = await store.getSecretsStore?.();
    if (secrets) {
      /*
      FNXC:StashSecretResolution 2026-08-18-14:46:
      The previous call passed STASH_SECRET_KEY (the display key name) as the
      revealSecret id, but AsyncSecretsStore matches the UUID `id` column
      (eq(table.id, id)) — the name always raised "Secret not found" and the
      catch degraded to an empty key, so every Stash capture failed auth (401)
      silently with no log line (observed 2026-08-18: live chat messages persisted
      but zero Stash events). Resolve the row UUID via listSecrets first; stores
      without listSecrets (test mocks) keep the legacy direct attempt.
      */
      const records = await secrets.listSecrets?.(STASH_SECRET_SCOPE);
      const record = records?.find((r) => r.key === STASH_SECRET_KEY);
      const revealed = record
        ? await secrets.revealSecret(record.id, STASH_SECRET_SCOPE, { agentId: "executor" })
        : await secrets.revealSecret(STASH_SECRET_KEY, STASH_SECRET_SCOPE, { agentId: "executor" });
      apiKey = revealed.plaintextValue;
    }
  } catch {
    // Degrade to empty key — capture stays a no-op rather than failing the run.
    apiKey = "";
  }
  if (!apiKey) return settings;
  return { ...settings, stashApiKey: apiKey };
}
