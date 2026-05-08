import { BufferJSON, initAuthCreds, type AuthenticationState, type AuthenticationCreds, type SignalDataSet, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import type { PluginDb } from "./index.js";

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

function loadCreds(db: PluginDb): AuthenticationCreds {
  const row = db.prepare("SELECT value FROM whatsapp_auth_creds WHERE id = 'creds'").get() as AuthRow | undefined;
  if (!row) return initAuthCreds();
  return parseStoredValue<AuthenticationCreds>(row.value) ?? initAuthCreds();
}

export function clearAuthState(db: PluginDb): void {
  db.prepare("DELETE FROM whatsapp_auth_creds").run();
  db.prepare("DELETE FROM whatsapp_auth_keys").run();
}

export function createPluginDbAuthState(db: PluginDb): AuthStateResult {
  const state: AuthenticationState = {
    creds: loadCreds(db),
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: Record<string, SignalDataTypeMap[T]> = {};
        const select = db.prepare("SELECT value FROM whatsapp_auth_keys WHERE category = ? AND keyId = ?");
        for (const id of ids) {
          const row = select.get(type, id) as AuthRow | undefined;
          if (!row) continue;
          const parsed = parseStoredValue<SignalDataTypeMap[T]>(row.value);
          if (parsed != null) {
            result[id] = parsed;
          }
        }
        return result;
      },
      set: async (data: SignalDataSet) => {
        const upsert = db.prepare(`
          INSERT INTO whatsapp_auth_keys(category, keyId, value, updatedAt)
          VALUES(?, ?, ?, ?)
          ON CONFLICT(category, keyId)
          DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
        `);
        const remove = db.prepare("DELETE FROM whatsapp_auth_keys WHERE category = ? AND keyId = ?");
        const now = new Date().toISOString();

        for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
          const categoryEntries = data[category];
          if (!categoryEntries) continue;
          for (const id of Object.keys(categoryEntries)) {
            const value = categoryEntries[id];
            if (value == null) {
              remove.run(category, id);
              continue;
            }
            upsert.run(category, id, serialize(value), now);
          }
        }
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO whatsapp_auth_creds(id, value, updatedAt)
        VALUES('creds', ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
      `).run(serialize(state.creds), now);
    },
  };
}
