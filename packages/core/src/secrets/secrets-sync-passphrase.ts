import { SecretsStore, SecretsStoreError } from "./secrets-store.js";

export const RESERVED_SYNC_PASSPHRASE_KEY = "__sync_passphrase__";

const RESERVED_DESCRIPTION = "Internal: cross-node secrets sync passphrase. Do not edit.";

async function findReservedRecord(store: SecretsStore) {
  return store.listSecrets("global").then((records) => records.find((record) => record.key === RESERVED_SYNC_PASSPHRASE_KEY) ?? null);
}

export async function getSyncPassphrase(store: SecretsStore): Promise<string | null> {
  const record = await findReservedRecord(store);
  if (!record) {
    return null;
  }

  try {
    const revealed = await store.revealSecret(record.id, "global", { agentId: null, userId: null });
    return revealed.plaintextValue;
  } catch (error) {
    if (error instanceof SecretsStoreError && error.code === "not-found") {
      return null;
    }
    throw error;
  }
}

export async function setSyncPassphrase(store: SecretsStore, passphrase: string): Promise<void> {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
    throw new Error("Sync passphrase must be a non-empty string");
  }

  const existing = await findReservedRecord(store);
  if (existing) {
    await store.updateSecret(existing.id, "global", {
      plaintextValue: passphrase,
      accessPolicy: "deny",
      envExportable: false,
      description: RESERVED_DESCRIPTION,
    });
    return;
  }

  await store.createSecret({
    scope: "global",
    key: RESERVED_SYNC_PASSPHRASE_KEY,
    plaintextValue: passphrase,
    accessPolicy: "deny",
    envExportable: false,
    description: RESERVED_DESCRIPTION,
  });
}

export async function clearSyncPassphrase(store: SecretsStore): Promise<void> {
  const existing = await findReservedRecord(store);
  if (!existing) {
    return;
  }

  await store.deleteSecret(existing.id, "global");
}

export async function hasSyncPassphraseConfigured(store: SecretsStore): Promise<boolean> {
  return (await findReservedRecord(store)) !== null;
}
