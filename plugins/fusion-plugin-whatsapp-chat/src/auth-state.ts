import { BufferJSON, initAuthCreds, type AuthenticationState, type AuthenticationCreds, type SignalDataSet, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { createSqliteWhatsAppPersistence, type PluginDb, type WhatsAppPersistence } from "./persistence.js";

type AuthStateResult = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
};

type AuthRow = { value: string };

function parseStoredValue<T>(value: string): T | null {
  try {
    return JSON.parse(value, BufferJSON.reviver) as T;
  } catch {
    return null;
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

export async function clearAuthState(db: PluginDb): Promise<void> {
  await createSqliteWhatsAppPersistence(db).clearAuthState();
}

export async function createPluginDbAuthState(db: PluginDb): Promise<AuthStateResult> {
  return createPersistenceAuthState(createSqliteWhatsAppPersistence(db));
}

/**
 * FNXC:WhatsAppPostgresPersistence 2026-07-13-22:37:
 * Baileys auth callbacks are already asynchronous, so the runtime auth state uses the backend-neutral persistence contract. The legacy PluginDb helper remains for SQLite compatibility tests and older plugin hosts.
 */
export async function createPersistenceAuthState(persistence: WhatsAppPersistence): Promise<AuthStateResult> {
  const storedCredentials = await persistence.loadCredentials();
  const state: AuthenticationState = {
    creds: storedCredentials
      ? parseStoredValue<AuthenticationCreds>(storedCredentials) ?? initAuthCreds()
      : initAuthCreds(),
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const stored = await persistence.loadAuthKeys(type, ids);
        const result: Record<string, SignalDataTypeMap[T]> = {};
        for (const [id, raw] of Object.entries(stored)) {
          const parsed = parseStoredValue<SignalDataTypeMap[T]>(raw);
          if (parsed !== null) result[id] = parsed;
        }
        return result;
      },
      set: async (data: SignalDataSet) => {
        const batch: Record<string, Record<string, string | null>> = {};
        for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
          const entries = data[category];
          if (!entries) continue;
          const values: Record<string, string | null> = {};
          for (const [id, value] of Object.entries(entries)) {
            values[id] = value == null ? null : serialize(value);
          }
          batch[category] = values;
        }
        await persistence.writeAuthKeys(batch);
      },
    },
  };
  return {
    state,
    saveCreds: async () => persistence.saveCredentials(serialize(state.creds)),
  };
}
