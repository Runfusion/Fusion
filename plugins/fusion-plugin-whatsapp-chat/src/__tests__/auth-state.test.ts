import { describe, expect, it } from "vitest";
import { createPersistenceAuthState } from "../auth-state.js";
import type { WhatsAppPersistence } from "../persistence.js";

function createInMemoryPersistence() {
  let credentials: string | null = null;
  let keys = new Map<string, string>();
  let failKeyId: string | null = null;
  let failAuthClear = false;
  const key = (category: string, id: string) => `${category}:${id}`;

  const persistence: WhatsAppPersistence = {
    async loadHistory() { return []; },
    async appendHistory() {},
    async wasProcessed() { return false; },
    async markProcessed() {},
    async claimMessage() { return true; },
    async loadCredentials() { return credentials; },
    async saveCredentials(value) { credentials = value; },
    async loadAuthKeys(category, ids) {
      return Object.fromEntries(ids.flatMap((id) => {
        const value = keys.get(key(category, id));
        return value === undefined ? [] : [[id, value]];
      }));
    },
    async writeAuthKeys(batch) {
      const next = new Map(keys);
      for (const [category, values] of Object.entries(batch)) {
        for (const [id, value] of Object.entries(values)) {
          if (id === failKeyId) throw new Error("injected auth-key write failure");
          if (value === null) next.delete(key(category, id));
          else next.set(key(category, id), value);
        }
      }
      keys = next;
    },
    async clearAuthState() {
      if (failAuthClear) throw new Error("injected auth clear failure");
      credentials = null;
      keys.clear();
    },
  };

  return {
    persistence,
    failAuthKeyWrite(id: string | null) { failKeyId = id; },
    failClear(value: boolean) { failAuthClear = value; },
    setRawKey(category: string, id: string, value: string) { keys.set(key(category, id), value); },
  };
}

describe("auth-state", () => {
  it("round-trips creds", async () => {
    const memory = createInMemoryPersistence();
    const auth = await createPersistenceAuthState(memory.persistence);
    auth.state.creds.me = { id: "123@s.whatsapp.net", name: "Fusion" } as any;
    await auth.saveCreds();
    const next = await createPersistenceAuthState(memory.persistence);
    expect(next.state.creds.me?.id).toBe("123@s.whatsapp.net");
  });

  it("sets, gets, and deletes key categories", async () => {
    const memory = createInMemoryPersistence();
    const auth = await createPersistenceAuthState(memory.persistence);
    await auth.state.keys.set({
      session: { alpha: { foo: "bar" } as any },
      "sender-key": { beta: { baz: "qux" } as any },
    });
    expect(((await auth.state.keys.get("session", ["alpha"])) as any).alpha.foo).toBe("bar");
    await auth.state.keys.set({ session: { alpha: null } });
    expect(((await auth.state.keys.get("session", ["alpha"])) as any).alpha).toBeUndefined();
  });

  it("does not expose partial auth-key batches when persistence rejects", async () => {
    const memory = createInMemoryPersistence();
    const auth = await createPersistenceAuthState(memory.persistence);
    await auth.state.keys.set({ session: { alpha: { version: "old" } as any } });
    memory.failAuthKeyWrite("beta");
    await expect(auth.state.keys.set({
      session: { alpha: { version: "new" } as any },
      "sender-key": { beta: { version: "new" } as any },
    })).rejects.toThrow("injected auth-key write failure");
    const session = await auth.state.keys.get("session", ["alpha"]);
    expect((session as any).alpha).toEqual({ version: "old" });
  });

  it("clears auth state through the async persistence contract", async () => {
    const memory = createInMemoryPersistence();
    const auth = await createPersistenceAuthState(memory.persistence);
    auth.state.creds.me = { id: "123@s.whatsapp.net", name: "Fusion" } as any;
    await auth.saveCreds();
    await auth.state.keys.set({ session: { alpha: { ok: true } as any } });
    await memory.persistence.clearAuthState();
    const cleared = await createPersistenceAuthState(memory.persistence);
    expect(cleared.state.creds.me).toBeUndefined();
    expect((await cleared.state.keys.get("session", ["alpha"]) as any).alpha).toBeUndefined();
  });

  it("preserves auth state when an atomic clear rejects", async () => {
    const memory = createInMemoryPersistence();
    const auth = await createPersistenceAuthState(memory.persistence);
    auth.state.creds.me = { id: "123@s.whatsapp.net", name: "Fusion" } as any;
    await auth.saveCreds();
    memory.failClear(true);
    await expect(memory.persistence.clearAuthState()).rejects.toThrow("injected auth clear failure");
    memory.failClear(false);
    expect((await createPersistenceAuthState(memory.persistence)).state.creds.me?.id).toBe("123@s.whatsapp.net");
  });

  it("handles corrupt json gracefully", async () => {
    const memory = createInMemoryPersistence();
    memory.setRawKey("session", "bad", "not-json");
    const auth = await createPersistenceAuthState(memory.persistence);
    expect(((await auth.state.keys.get("session", ["bad"])) as any).bad).toBeUndefined();
  });
});
