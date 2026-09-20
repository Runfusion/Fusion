import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS,
  FUSION_AGENT_BROWSER_MAX_IDLE_TIMEOUT_MS,
  FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS,
  createFusionBrowserLease,
  closeFusionBrowserSession,
  resolveFusionBrowserIdleTimeout,
  retireFusionBrowserLease,
  reapExpiredFusionBrowserLeases,
  createFusionBrowserProductionReaperDeps,
  isFusionAgentBrowserDaemonCommand,
} from "../agent-browser-lifecycle.js";

describe("Fusion agent-browser ownership lease", () => {
  it.each([
    [undefined, FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS],
    ["bad", FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS],
    ["0", FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS],
    ["-5", FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS],
    ["500", 500],
    [String(FUSION_AGENT_BROWSER_MAX_IDLE_TIMEOUT_MS + 1), FUSION_AGENT_BROWSER_MAX_IDLE_TIMEOUT_MS],
  ])("enforces a finite idle timeout for %s", (value, expected) => {
    expect(resolveFusionBrowserIdleTimeout(value)).toBe(expected);
  });

  it("fences concurrent sessions and writes an opaque scoped environment", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-lease-"));
    const first = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, now: () => 100, randomId: () => "one" });
    const second = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, now: () => 100, randomId: () => "two" });
    expect(first.lease.sessionId).not.toBe(second.lease.sessionId);
    expect(first.env).toMatchObject({ FUSION_AGENT_BROWSER_SESSION_ID: first.lease.sessionId, AGENT_BROWSER_SESSION: first.lease.sessionId });
    expect(JSON.parse(readFileSync(first.leasePath, "utf8"))).toMatchObject({ taskId: "FN-9305", expiresAt: 600_100 });
    retireFusionBrowserLease(first.lease.sessionId, root);
  });

  it("retains a lease when native close fails so recovery can prove ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-close-failure-"));
    const created = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, randomId: () => "close-failure" });
    await closeFusionBrowserSession(created.env, { tempRoot: root, runClose: async () => { throw new Error("wedged"); } });
    expect(existsSync(created.leasePath)).toBe(true);
    expect(JSON.parse(readFileSync(created.leasePath, "utf8"))).toMatchObject({ retiredAt: expect.any(Number) });
  });

  it("retains a retired lease for proof-based cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-retire-"));
    const created = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, randomId: () => "retired" });
    retireFusionBrowserLease(created.lease.sessionId, root);
    expect(existsSync(created.leasePath)).toBe(true);
    expect(JSON.parse(readFileSync(created.leasePath, "utf8"))).toMatchObject({ retiredAt: expect.any(Number) });
  });

  it("recognizes only the packaged platform daemon executable names", () => {
    expect(isFusionAgentBrowserDaemonCommand("/pkg/agent-browser-darwin-arm64 --daemon")).toBe(true);
    expect(isFusionAgentBrowserDaemonCommand("/pkg/agent-browser-linux-musl-x64 --daemon")).toBe(true);
    expect(isFusionAgentBrowserDaemonCommand("node /pkg/agent-browser.js --daemon")).toBe(false);
    expect(isFusionAgentBrowserDaemonCommand("/usr/bin/unrelated-agent-browser-darwin-arm64 --user-data-dir=/tmp/x")).toBe(false);
  });

  it("removes an expired retired lease after normal close removed its profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-normal-close-"));
    const created = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, now: () => 0, randomId: () => "normal-close" });
    retireFusionBrowserLease(created.lease.sessionId, root);
    await expect(reapExpiredFusionBrowserLeases({
      tempRoot: root,
      now: () => FUSION_AGENT_BROWSER_DEFAULT_IDLE_TIMEOUT_MS,
      findProcessGroups: async () => [],
      signalGroup: async () => undefined,
      groupsAlive: async () => false,
    })).resolves.toBe(1);
    expect(existsSync(created.leasePath)).toBe(false);
  });

  /*
   * FNXC:AgentBrowserReaping 2026-09-20-01:34:
   * A pre-lease incident profile must prove the whole TERM-resistant daemon/Chrome/helper group
   * is gone after an owner crash. This fixture uses the real ps parser and negative-PID signals,
   * rather than injected discovery or signalling doubles.
   */
  it.runIf(process.platform !== "win32")("reaps a production-shaped orphaned TERM-resistant browser tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-production-reap-"));
    const profilePath = join(root, "agent-browser-chrome-pre-fusion-production");
    const fixturePath = join(root, "term-resistant-browser-fixture.mjs");
    const readyPath = join(root, "ready.json");
    writeFileSync(fixturePath, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { spawn } from "node:child_process";
      const [role, ...args] = process.argv.slice(2);
      const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
      const ready = args.at(-1);
      if (!profile || !ready) process.exit(2);
      process.on("SIGTERM", () => {});
      if (role === "owner") {
        spawn(process.execPath, [process.argv[1], "daemon", "--user-data-dir=" + profile, ready], {
          detached: true, stdio: "ignore", argv0: "agent-browser-linux-x64",
        }).unref();
      } else if (role === "daemon") {
        spawn(process.execPath, [process.argv[1], "chrome", "--user-data-dir=" + profile, ready], {
          stdio: "ignore", argv0: "chrome",
        });
      } else if (role === "chrome") {
        mkdirSync(profile, { recursive: true });
        const helpers = [0, 1].map(() => spawn(process.execPath, [process.argv[1], "helper", "--user-data-dir=" + profile, ready], {
          stdio: "ignore", argv0: "chrome-helper",
        }));
        writeFileSync(ready, JSON.stringify({ daemonPid: process.ppid, chromePid: process.pid, helperPids: helpers.map((child) => child.pid) }));
      }
      setInterval(() => {}, 1_000);
    `);
    const owner = spawn(process.execPath, [fixturePath, "owner", `--user-data-dir=${profilePath}`, readyPath], { stdio: "ignore" });
    const isAlive = (pid: number) => {
      try {
        // FNXC:AgentBrowserReaping 2026-09-20-01:34: A killed child may briefly remain a reaped-parent zombie; it cannot consume CPU or retain the browser tree, so count only a non-zombie process as a survivor.
        return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
      } catch { return false; }
    };
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      expect(existsSync(readyPath)).toBe(true);
      const fixture = JSON.parse(readFileSync(readyPath, "utf8")) as { daemonPid: number; chromePid: number; helperPids: number[] };
      owner.kill("SIGKILL");
      await new Promise<void>((done) => owner.once("close", () => done()));
      utimesSync(profilePath, 0, 0);
      await expect(reapExpiredFusionBrowserLeases({
        ...createFusionBrowserProductionReaperDeps(),
        tempRoot: root,
        now: () => FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS,
        graceMs: 20,
      })).resolves.toBe(1);
      expect([fixture.daemonPid, fixture.chromePid, ...fixture.helperPids].filter(isAlive)).toEqual([]);
      expect(existsSync(profilePath)).toBe(false);
    } finally {
      owner.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reaps a lease-less aged profile only after exact daemon/Chrome discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-legacy-reap-"));
    const profile = join(root, "agent-browser-chrome-pre-fusion-incident");
    mkdirSync(profile);
    utimesSync(profile, 0, 0);
    const signals: string[] = [];
    let alive = true;
    await expect(reapExpiredFusionBrowserLeases({
      tempRoot: root,
      now: () => FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS,
      findProcessGroups: async (candidate) => candidate === profile ? [73] : [],
      signalGroup: async (_group, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
      groupsAlive: async () => alive,
      sleep: async () => undefined,
    })).resolves.toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(profile)).toBe(false);
  });

  it("retains fresh, unrelated, managed, and symlinked legacy-profile candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-legacy-safe-"));
    const fresh = join(root, "agent-browser-chrome-fresh");
    const emptyOld = join(root, "agent-browser-chrome-empty-old");
    const managed = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, now: () => FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS, randomId: () => "managed" });
    const target = join(root, "outside-profile");
    const link = join(root, "agent-browser-chrome-link");
    mkdirSync(fresh);
    mkdirSync(emptyOld);
    mkdirSync(managed.lease.profilePath);
    mkdirSync(target);
    symlinkSync(target, link);
    utimesSync(emptyOld, 0, 0);
    utimesSync(managed.lease.profilePath, 0, 0);
    let discovered = false;
    await expect(reapExpiredFusionBrowserLeases({
      tempRoot: root,
      now: () => FUSION_AGENT_BROWSER_LEGACY_STALE_AGE_MS,
      findProcessGroups: async () => { discovered = true; return []; },
      signalGroup: async () => undefined,
      groupsAlive: async () => false,
      sleep: async () => undefined,
    })).resolves.toBe(0);
    expect(discovered).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(emptyOld)).toBe(true);
    expect(existsSync(managed.lease.profilePath)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("escalates an expired exact profile group and removes it only after death", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-browser-reap-"));
    const created = createFusionBrowserLease("FN-9305", {}, { tempRoot: root, now: () => 0, randomId: () => "stale" });
    mkdirSync(created.lease.profilePath);
    const signals: string[] = [];
    let alive = true;
    await expect(reapExpiredFusionBrowserLeases({
      tempRoot: root,
      now: () => created.lease.expiresAt,
      findProcessGroups: async (profile) => profile === created.lease.profilePath ? [42] : [],
      signalGroup: async (_group, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
      groupsAlive: async () => alive,
      sleep: async () => undefined,
    })).resolves.toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
