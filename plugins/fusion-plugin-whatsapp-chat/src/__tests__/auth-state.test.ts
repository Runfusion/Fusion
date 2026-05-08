import { describe, expect, it } from "vitest";
import { clearAuthState, createPluginDbAuthState } from "../auth-state.js";

function createInMemoryDb() {
  const creds = new Map<string, string>();
  const keys = new Map<string, string>();
  const makeKey = (category: string, id: string) => `${category}:${id}`;

  return {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes("FROM whatsapp_auth_creds")) {
            const value = creds.get("creds");
            return value ? { value } : undefined;
          }
          if (sql.includes("FROM whatsapp_auth_keys")) {
            const key = makeKey(args[0] as string, args[1] as string);
            const value = keys.get(key);
            return value ? { value } : undefined;
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (sql.includes("INSERT INTO whatsapp_auth_creds")) {
            creds.set("creds", args[0] as string);
          }
          if (sql.includes("DELETE FROM whatsapp_auth_creds")) {
            creds.clear();
          }
          if (sql.includes("INSERT INTO whatsapp_auth_keys")) {
            keys.set(makeKey(args[0] as string, args[1] as string), args[2] as string);
          }
          if (sql.includes("DELETE FROM whatsapp_auth_keys WHERE category")) {
            keys.delete(makeKey(args[0] as string, args[1] as string));
          }
          if (sql.includes("DELETE FROM whatsapp_auth_keys")) {
            keys.clear();
          }
        },
      };
    },
    exec() {},
    _creds: creds,
    _keys: keys,
  };
}

describe("auth-state", () => {
  it("round-trips creds", async () => {
    const db = createInMemoryDb();
    const auth = createPluginDbAuthState(db as any);
    auth.state.creds.me = { id: "123@s.whatsapp.net", name: "Fusion" } as any;
    await auth.saveCreds();

    const next = createPluginDbAuthState(db as any);
    expect(next.state.creds.me?.id).toBe("123@s.whatsapp.net");
  });

  it("sets, gets, and deletes key categories", async () => {
    const db = createInMemoryDb();
    const auth = createPluginDbAuthState(db as any);

    await auth.state.keys.set({
      session: { alpha: { foo: "bar" } as any },
      "sender-key": { beta: { baz: "qux" } as any },
    });

    const loaded = await auth.state.keys.get("session", ["alpha", "missing"]);
    expect((loaded as any).alpha.foo).toBe("bar");
    expect((loaded as any).missing).toBeUndefined();

    await auth.state.keys.set({ session: { alpha: null } });
    const removed = await auth.state.keys.get("session", ["alpha"]);
    expect((removed as any).alpha).toBeUndefined();
  });

  it("clears auth state", async () => {
    const db = createInMemoryDb();
    const auth = createPluginDbAuthState(db as any);
    auth.state.creds.me = { id: "123@s.whatsapp.net", name: "Fusion" } as any;
    await auth.saveCreds();
    await auth.state.keys.set({ session: { alpha: { ok: true } as any } });

    clearAuthState(db as any);

    expect(db._creds.size).toBe(0);
    expect(db._keys.size).toBe(0);
  });

  it("handles corrupt json gracefully", async () => {
    const db = createInMemoryDb();
    db._keys.set("session:bad", "not-json");

    const auth = createPluginDbAuthState(db as any);
    const loaded = await auth.state.keys.get("session", ["bad"]);
    expect((loaded as any).bad).toBeUndefined();
  });
});
