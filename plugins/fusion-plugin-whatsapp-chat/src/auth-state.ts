import { BufferJSON, initAuthCreds, type AuthenticationState, type AuthenticationCreds, type SignalDataSet, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import type { WhatsAppPersistence } from "./persistence.js";

type AuthStateResult = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
};

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

/**
 * FNXC:WhatsAppPostgresPersistence 2026-07-14-18:05:
 * Baileys auth callbacks use the asynchronous persistence contract supplied by the project-bound PostgreSQL layer. No auth helper accepts a synchronous plugin database, so credentials and Signal keys cannot re-enter removed SQLite state through tests or older host shims.
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
