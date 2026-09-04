import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "../auth/auth-storage.js";

const credential = (key: string) => ({ type: "api_key", key });

describe("instance-aware Fusion auth storage", () => {
  const originalHome = process.env.HOME;
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "fusion-auth-instances-")); process.env.HOME = home; });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  const authPath = () => getFusionAuthPath(home);
  const seed = (data: Record<string, unknown>) => { mkdirSync(join(home, ".fusion", "agent"), { recursive: true }); writeFileSync(authPath(), JSON.stringify(data)); };

  it("stores coexisting instances and resolves a pointer before a bare legacy key", async () => {
    const store = createFusionAuthStorage();
    await store.setInstance({ providerId: "p", instanceId: "work" }, credential("work"));
    await store.setInstance({ providerId: "p", instanceId: "backup" }, credential("backup"));
    await store.set("p", credential("updated-work"));
    expect(JSON.parse(readFileSync(authPath(), "utf8"))["p[backup]"]).toEqual(credential("updated-work"));
    await store.setInstance({ providerId: "p", instanceId: "default" }, credential("bare"));
    await store.setDefaultInstance({ providerId: "p", instanceId: "work" });
    expect(store.get("p")).toEqual(credential("work"));
    expect(await store.getApiKey("p")).toBe("work");
    expect(store.getAll().p).toEqual(credential("work"));
    expect(store.listInstances("p")[0]).toEqual({ providerId: "p", instanceId: "work" });
    await store.setDefaultInstance({ providerId: "p", instanceId: "default" });
    expect(store.get("p")).toEqual(credential("bare"));
  });

  it("keeps legacy bare credentials readable without a read rewrite", () => {
    seed({ provider: credential("legacy") });
    const before = readFileSync(authPath(), "utf8"); const mtime = statSync(authPath()).mtimeMs;
    const store = createFusionAuthStorage();
    expect(store.getDefaultInstance("provider")).toEqual({ providerId: "provider", instanceId: "default" });
    expect(store.get("provider")).toEqual(credential("legacy"));
    expect(readFileSync(authPath(), "utf8")).toBe(before); expect(statSync(authPath()).mtimeMs).toBe(mtime);
  });

  it("uses legacy bare creation but removal calls do not write absent providers", async () => {
    const store = createFusionAuthStorage();
    await store.set("brand-new", credential("new"));
    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual({ "brand-new": credential("new") });
    const before = readFileSync(authPath(), "utf8"); const mtime = statSync(authPath()).mtimeMs;
    await store.remove("absent"); await store.logout("absent"); await store.removeInstance({ providerId: "absent", instanceId: "x" });
    expect(readFileSync(authPath(), "utf8")).toBe(before); expect(statSync(authPath()).mtimeMs).toBe(mtime);
  });

  /*
  FNXC:ProviderAuth 2026-08-18-04:40:
  `modify` USED TO BE ASSERTED HERE AS NON-CREATING, alongside remove/logout/removeInstance. That
  grouping was wrong: removal calls must not resurrect an absent provider, but `modify` is the seam
  pi persists a COMPLETED LOGIN through (`Models.login` -> `credentials.modify(provider.id, ...)`),
  and refusing to create meant a provider's first-ever login wrote nothing while resolving as
  success — the operator saw "Login did not complete. Please try again." on every fresh install.
  Creation is the contract now; declining (returning undefined) still writes nothing.
  */
  it("creates an absent provider when the modify callback returns a credential", async () => {
    const store = createFusionAuthStorage();
    const before = readFileSync(authPath(), "utf8");

    let declined = false;
    await store.modify("absent", async () => { declined = true; return undefined; });
    expect(declined).toBe(true);
    expect(readFileSync(authPath(), "utf8")).toBe(before);

    await store.modify("absent", async (current) => { expect(current).toBeUndefined(); return credential("first-login"); });
    expect(store.get("absent")).toEqual(credential("first-login"));
    expect(JSON.parse(readFileSync(authPath(), "utf8")).absent).toEqual(credential("first-login"));
  });

  it("rejects malformed and reserved mutator keys without touching defaults metadata", async () => {
    seed({ __fusionDefaultInstances: { p: "work" } }); const store = createFusionAuthStorage(); const before = readFileSync(authPath(), "utf8");
    for (const bad of ["p[", "p]", "p[]", "p[a[b]", "", "__fusionDefaultInstances"]) {
      await expect(store.set(bad, credential("bad"))).rejects.toThrow();
      await expect(store.remove(bad)).rejects.toThrow();
      await expect(store.logout(bad)).rejects.toThrow();
      await expect(store.modify(bad, async () => credential("bad"))).rejects.toThrow();
      expect(store.get(bad)).toBeUndefined(); expect(store.has(bad)).toBe(false);
    }
    expect(readFileSync(authPath(), "utf8")).toBe(before);
  });

  it("filters metadata and malformed credential values and falls back after default deletion", async () => {
    seed({ p: credential("bare"), "p[work]": credential("work"), "p[bad]": "not-a-credential", __fusionDefaultInstances: { p: "work" } });
    const store = createFusionAuthStorage();
    expect(store.list()).toEqual(["p"]); expect(store.getAll()).toEqual({ p: credential("work") });
    await store.removeInstance({ providerId: "p", instanceId: "work" });
    expect(store.get("p")).toEqual(credential("bare"));
    expect(JSON.parse(readFileSync(authPath(), "utf8")).__fusionDefaultInstances).toEqual({});
    await expect(store.setDefaultInstance({ providerId: "p", instanceId: "missing" })).rejects.toThrow();
  });

  it("serializes instance-login lifecycles across storage instances sharing an auth file", async () => {
    const first = createFusionAuthStorage();
    await first.setInstance({ providerId: "oauth", instanceId: "acct-a" }, credential("A"));
    await first.setDefaultInstance({ providerId: "oauth", instanceId: "acct-a" });
    const second = createFusionAuthStorage();
    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    let secondSnapshot: string | undefined;

    const firstLogin = first.withProviderInstanceLoginLock!("oauth", async () => {
      first.reload();
      const before = first.get("oauth");
      await first.set("oauth", credential("B"));
      firstEntered.resolve();
      await releaseFirst.promise;
      await first.setInstance({ providerId: "oauth", instanceId: "acct-b" }, credential("B"));
      await first.setInstance({ providerId: "oauth", instanceId: "acct-a" }, before!);
    });
    await firstEntered.promise;

    const secondLogin = second.withProviderInstanceLoginLock!("oauth", async () => {
      second.reload();
      secondSnapshot = second.get("oauth")?.key;
      const before = second.get("oauth");
      await second.set("oauth", credential("C"));
      await second.setInstance({ providerId: "oauth", instanceId: "acct-c" }, credential("C"));
      await second.setInstance({ providerId: "oauth", instanceId: "acct-a" }, before!);
    });

    await Promise.resolve();
    expect(secondSnapshot).toBeUndefined();
    releaseFirst.resolve();
    await Promise.all([firstLogin, secondLogin]);

    expect(secondSnapshot).toBe("A");
    const verifier = createFusionAuthStorage();
    expect(verifier.getInstance({ providerId: "oauth", instanceId: "acct-a" })).toEqual(credential("A"));
    expect(verifier.getInstance({ providerId: "oauth", instanceId: "acct-b" })).toEqual(credential("B"));
    expect(verifier.getInstance({ providerId: "oauth", instanceId: "acct-c" })).toEqual(credential("C"));
  });
});
