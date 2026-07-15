// FNXC:WindowsDesktopPackaging 2026-07-14-20:30:
// Broker-mechanism diagnostic (throwaway). The admin-token refusal is confirmed
// flat (clean-path did not help), so the only fix is to run postgres.exe under a
// genuinely non-admin context. This tests the two candidate mechanisms on the
// actual windows-latest (windows-2025-vs2026) runner and reports which one lets
// postgres boot:
//   BROKER A — scheduled task with /RL LIMITED (token downgrade; may not filter
//     when UAC EnableLUA=0, so could still be elevated).
//   BROKER B — scheduled task running AS a freshly-created non-admin local user
//     (works regardless of UAC; this is the robust mechanism).
// Whichever boots postgres (port opens) is the one the launcher must use.
import { spawnSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { existsSync, readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, platform } from "node:os";

const log = (...a) => console.log("[broker]", ...a);
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

if (platform() !== "win32") {
  log("Not Windows — exiting.");
  process.exit(0);
}

// --- UAC state (decides whether /RL LIMITED can possibly filter) ---
const lua = sh("reg", [
  "query",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
  "/v",
  "EnableLUA",
]);
log("EnableLUA query:\n" + ((lua.stdout || lua.stderr) || "").trim());

// --- locate native bin ---
function findNativeBinDir() {
  const store = "node_modules/.pnpm";
  if (!existsSync(store)) return null;
  for (const entry of readdirSync(store)) {
    if (!/embedded-postgres\+windows-x64@/.test(entry)) continue;
    const binDir = join(
      store,
      entry,
      "node_modules",
      "@embedded-postgres",
      "windows-x64",
      "native",
      "bin",
    );
    if (existsSync(join(binDir, "postgres.exe"))) return binDir;
  }
  return null;
}
const binDir = findNativeBinDir();
const nativeRoot = dirname(binDir);
log("binDir:", binDir);
if (!binDir) {
  console.error("FATAL: native bin not found");
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function portOpen(port) {
  return new Promise((resolve) => {
    const s = createConnection(port, "127.0.0.1");
    s.setTimeout(600);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}
async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(500);
  }
  return false;
}
function initDataDir(label) {
  const dataDir = join(tmpdir(), `pgb-${label}-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const init = sh(join(binDir, "initdb.exe"), [
    "-D",
    dataDir,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-instructions",
  ]);
  log(`${label}: initdb exit=${init.status}`);
  return dataDir;
}

// --- BROKER A: scheduled task /RL LIMITED (same user, requested non-elevated) ---
async function brokerScheduledLimited() {
  log("\n===== BROKER A: schtasks /RL LIMITED =====");
  const dataDir = initDataDir("st");
  const port = await freePort();
  const pg = join(binDir, "postgres.exe");
  const bat = join(tmpdir(), `pgb-st-${process.pid}.bat`);
  writeFileSync(bat, `@echo off\r\n"${pg}" -D "${dataDir}" -p ${port}\r\n`);
  const tn = `pgbST${process.pid}`;
  const cr = sh("schtasks", [
    "/create", "/tn", tn, "/tr", `"${bat}"`,
    "/sc", "once", "/st", "23:59", "/rl", "LIMITED", "/f",
  ]);
  log("schtasks /create:", cr.status, (cr.stderr || "").slice(0, 200));
  const run = sh("schtasks", ["/run", "/tn", tn]);
  log("schtasks /run:", run.status, (run.stderr || "").slice(0, 200));
  const up = await waitForPort(port, 12000);
  log("BROKER A port open (postgres booted):", up);
  sh("taskkill", ["/im", "postgres.exe", "/f"]);
  sh("schtasks", ["/delete", "/tn", tn, "/f"]);
  rmSync(bat, { force: true });
  rmSync(dataDir, { recursive: true, force: true });
  return up;
}

// --- BROKER B: scheduled task running AS a created non-admin local user ---
async function brokerDedicatedUser() {
  log("\n===== BROKER B: dedicated non-admin user =====");
  const user = `pguser${process.pid}`;
  const pass = `P@ss${process.pid}w0rd!`;
  const cu = sh("net", ["user", user, pass, "/add"]);
  log("net user /add:", cu.status, (cu.stderr || "").slice(0, 200));
  // Report group membership to confirm it is NOT an administrator.
  const gi = sh("net", ["localgroup", "Administrators"]);
  log("Administrators contains user?", (gi.stdout || "").includes(user));

  const dataDir = initDataDir("du");
  sh("icacls", [dataDir, "/grant", `${user}:(OI)(CI)F`]);
  sh("icacls", [nativeRoot, "/grant", `${user}:(OI)(CI)RX`]);
  const port = await freePort();
  const pg = join(binDir, "postgres.exe");
  // FNXC:WindowsDesktopPackaging 2026-07-14-20:38:
  // Write the launcher .bat INSIDE the data dir (already granted (OI)(CI)F to
  // the non-admin user above), so the new user can read/execute it. A bat in
  // runneradmin's %TEMP% would be unreadable by the new user and produce a
  // false negative unrelated to whether the dedicated-user mechanism works.
  const bat = join(dataDir, "run.bat");
  writeFileSync(bat, `@echo off\r\n"${pg}" -D "${dataDir}" -p ${port}\r\n`);
  const tn = `pgbDU${process.pid}`;
  const cr = sh("schtasks", [
    "/create", "/tn", tn, "/tr", `"${bat}"`,
    "/sc", "once", "/st", "23:59",
    "/ru", `${process.env.COMPUTERNAME}\\${user}`, "/rp", pass, "/f",
  ]);
  log("schtasks /create (as user):", cr.status, (cr.stderr || "").slice(0, 300));
  const run = sh("schtasks", ["/run", "/tn", tn]);
  log("schtasks /run:", run.status, (run.stderr || "").slice(0, 200));
  const up = await waitForPort(port, 15000);
  log("BROKER B port open (postgres booted):", up);
  sh("taskkill", ["/im", "postgres.exe", "/f"]);
  sh("schtasks", ["/delete", "/tn", tn, "/f"]);
  sh("net", ["user", user, "/delete"]);
  rmSync(bat, { force: true });
  rmSync(dataDir, { recursive: true, force: true });
  return up;
}

const a = await brokerScheduledLimited().catch((e) => {
  log("BROKER A threw:", String(e));
  return false;
});
const b = await brokerDedicatedUser().catch((e) => {
  log("BROKER B threw:", String(e));
  return false;
});

log("\n========== BROKER SUMMARY ==========");
log("BROKER A (schtasks /RL LIMITED):", a ? "BOOTED" : "failed");
log("BROKER B (dedicated non-admin user):", b ? "BOOTED" : "failed");
log("DONE");
