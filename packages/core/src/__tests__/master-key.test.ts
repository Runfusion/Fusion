import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("keytar", () => {
  throw new Error("MODULE_NOT_FOUND");
});

import {
  MASTER_KEY_FILENAME,
  MasterKeyCorruptError,
  MasterKeyManager,
  MasterKeyPermissionError,
  type KeytarLike,
} from "../secrets/master-key.js";

type MutableKeytar = KeytarLike & { writes: number; stored: string | null };

function createKeytar(initial?: Buffer): MutableKeytar {
  let stored = initial ? initial.toString("base64") : null;
  return {
    writes: 0,
    get stored() {
      return stored;
    },
    set stored(v: string | null) {
      stored = v;
    },
    async getPassword() {
      return stored;
    },
    async setPassword(_s, _a, value) {
      stored = value;
      this.writes += 1;
    },
    async deletePassword() {
      stored = null;
      return true;
    },
  };
}

describe("MasterKeyManager", () => {
  let globalDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "fn-master-key-test-"));
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("uses keychain on first run", async () => {
    const keytar = createKeytar();
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    await expect(fs.stat(join(globalDir, MASTER_KEY_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.getBackend()).resolves.toBe("keychain");
  });

  it("falls back to file when keychain unavailable", async () => {
    const failing: KeytarLike = {
      async getPassword() {
        throw new Error("keychain unavailable");
      },
      async setPassword() {
        throw new Error("keychain unavailable");
      },
      async deletePassword() {
        throw new Error("keychain unavailable");
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: failing });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    const keyPath = join(globalDir, MASTER_KEY_FILENAME);
    const fileStat = await fs.stat(keyPath);
    expect(fileStat.size).toBe(32);
    expect(fileStat.mode & 0o777).toBe(0o600);
    await expect(manager.getBackend()).resolves.toBe("file");
  });

  it("is idempotent on keychain", async () => {
    const original = Buffer.alloc(32, 7);
    const keytar = createKeytar(original);
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const a = await manager.getOrCreateKey();
    const b = await manager.getOrCreateKey();

    expect(a.equals(original)).toBe(true);
    expect(b.equals(original)).toBe(true);
    expect(keytar.writes).toBe(0);
  });

  it("is idempotent on file backend", async () => {
    const failing = {
      async getPassword() {
        throw new Error("unavailable");
      },
      async setPassword() {
        throw new Error("unavailable");
      },
      async deletePassword() {
        throw new Error("unavailable");
      },
    } satisfies KeytarLike;
    const manager = new MasterKeyManager({ globalDir, keytarModule: failing });

    const a = await manager.getOrCreateKey();
    const b = await manager.getOrCreateKey();

    expect(a.equals(b)).toBe(true);
  });

  it("handles race by returning externally written keychain value", async () => {
    const external = Buffer.alloc(32, 9).toString("base64");
    let stored: string | null = null;
    const keytar: KeytarLike = {
      async getPassword() {
        return stored;
      },
      async setPassword() {
        stored = external;
        throw new Error("write lost race");
      },
      async deletePassword() {
        return true;
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const key = await manager.getOrCreateKey();
    expect(key.equals(Buffer.from(external, "base64"))).toBe(true);
  });

  it("throws on corrupt keychain entry", async () => {
    const keytar = createKeytar();
    keytar.stored = Buffer.alloc(10).toString("base64");
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyCorruptError);
  });

  it("throws on corrupt file entry", async () => {
    writeFileSync(join(globalDir, MASTER_KEY_FILENAME), Buffer.alloc(10));
    const manager = new MasterKeyManager({ globalDir });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyCorruptError);
  });

  it("throws when file permission verification fails", async () => {
    const failing: KeytarLike = {
      async getPassword() {
        throw new Error("no keychain");
      },
      async setPassword() {
        throw new Error("no keychain");
      },
      async deletePassword() {
        return true;
      },
    };
    const manager = new MasterKeyManager({
      globalDir,
      keytarModule: failing,
      fsModule: {
        ...fs,
        stat: async (path) => ({ ...(await fs.stat(path)), mode: 0o644 }),
      },
    });

    await expect(manager.getOrCreateKey()).rejects.toBeInstanceOf(MasterKeyPermissionError);
  });

  it("rotates key and persists to active backend", async () => {
    const keytar = createKeytar();
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    const before = await manager.getOrCreateKey();
    const rotated = await manager.rotateKey();
    const after = await manager.getOrCreateKey();

    expect(rotated.equals(before)).toBe(false);
    expect(after.equals(rotated)).toBe(true);
    await expect(manager.getBackend()).resolves.toBe("keychain");
  });

  it("throws if active keychain backend cannot be updated during rotation", async () => {
    const original = Buffer.alloc(32, 5).toString("base64");
    const keytar: KeytarLike = {
      async getPassword() {
        return original;
      },
      async setPassword() {
        throw new Error("keychain unavailable");
      },
      async deletePassword() {
        return false;
      },
    };
    const manager = new MasterKeyManager({ globalDir, keytarModule: keytar });

    await expect(manager.rotateKey()).rejects.toThrow(
      "unable to rotate master key in active keychain backend",
    );
  });

  it("falls back to file when keytar import is missing", async () => {
    const manager = new MasterKeyManager({ globalDir });

    const key = await manager.getOrCreateKey();
    expect(key).toHaveLength(32);
    await expect(fs.stat(join(globalDir, MASTER_KEY_FILENAME))).resolves.toBeTruthy();
    await expect(manager.getBackend()).resolves.toBe("file");
  });
});
