// FNXC:WindowsDesktopPackaging 2026-07-17-22:30:
// End-to-end verification for the elevated restricted-token postgres launch
// (pg_ctl re-exec, no helper account). Runs ONLY on an elevated win32 process
// (GitHub windows runners qualify). Asserts, in order:
//   1. The legacy 'fusion-pg' account (pre-created by the workflow) is DELETED
//      by the launch path — Fusion must not leave created accounts behind.
//   2. EmbeddedPostgresLifecycle.start() boots postgres from a cwd that grants
//      nothing beyond Administrators/SYSTEM (the hostile-cwd condition that
//      broke the credential launcher with "The directory name is invalid").
//   3. A stop + second start on the same data dir succeeds (the truncate-held
//      -log EBUSY regression: prior code died reopening .pgrunner logs).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = 55498;
const RESTRICTED = "C:\\fusion-verify-restricted-cwd";
const DATA_DIR = "C:\\fusion-verify-pgdata";

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

if (process.platform !== "win32") {
  console.error("verify: must run on win32");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { isWindowsElevatedAdmin, EmbeddedPostgresLifecycle } = await import(
  pathToFileURL(join(scriptDir, "..", "packages", "core", "dist", "postgres", "embedded-lifecycle.js")).href
);

if (!isWindowsElevatedAdmin()) {
  console.error("verify: process is not elevated; the restricted-token path would not be exercised");
  process.exit(1);
}

// Hostile cwd: inheritance stripped, only Administrators + SYSTEM.
rmSync(RESTRICTED, { recursive: true, force: true });
mkdirSync(RESTRICTED, { recursive: true });
for (const args of [
  [RESTRICTED, "/inheritance:r"],
  [RESTRICTED, "/grant:r", "Administrators:(OI)(CI)F", "SYSTEM:(OI)(CI)F"],
]) {
  const r = sh("icacls", args);
  if (r.status !== 0) {
    console.error(`verify: icacls ${args.join(" ")} failed: ${r.out}`);
    process.exit(1);
  }
}
process.chdir(RESTRICTED);
console.log(`verify: cwd is now ${process.cwd()}`);

rmSync(DATA_DIR, { recursive: true, force: true });

function makeLifecycle() {
  return new EmbeddedPostgresLifecycle({
    dataDir: DATA_DIR,
    database: "fusion",
    user: "postgres",
    password: "password",
    port: PORT,
    onLog: (message) => console.log(`[lifecycle] ${message}`),
    onError: (messageOrError) => console.error(`[lifecycle:err] ${String(messageOrError)}`),
  });
}

let failed = false;
try {
  for (let round = 1; round <= 2; round += 1) {
    console.log(`verify: boot round ${round}`);
    const lifecycle = makeLifecycle();
    await lifecycle.start();
    console.log(`verify: round ${round} start() resolved`);
    if (!(await probe(PORT))) {
      throw new Error(`round ${round}: port ${PORT} did not accept a TCP connection`);
    }
    console.log(`verify: round ${round} TCP accept confirmed on 127.0.0.1:${PORT}`);
    await lifecycle.stop();
    if (await probe(PORT)) {
      throw new Error(`round ${round}: port ${PORT} still accepting after stop()`);
    }
    console.log(`verify: round ${round} stop() confirmed`);
  }

  // The launch path must have deleted the pre-created legacy account, and no
  // new helper account may exist afterwards.
  const account = sh("net", ["user", "fusion-pg"]);
  if (account.status === 0) {
    throw new Error("legacy 'fusion-pg' account still exists after the elevated launch — cleanup failed");
  }
  console.log("verify: 'fusion-pg' account absent after launch (legacy cleanup confirmed, none re-created)");
} catch (err) {
  console.error(`verify: FAIL — ${err instanceof Error ? err.stack : String(err)}`);
  failed = true;
} finally {
  process.chdir("C:\\");
  rmSync(RESTRICTED, { recursive: true, force: true });
  // A failed round can orphan a postmaster that holds the data dir (EBUSY on
  // rmdir). Kill it via postmaster.pid before removing, best-effort.
  try {
    const pid = parseInt(readFileSync(join(DATA_DIR, "postmaster.pid"), "utf8").split("\n")[0], 10);
    if (Number.isFinite(pid) && pid > 0) {
      sh("taskkill", ["/pid", String(pid), "/f", "/t"]);
    }
  } catch {
    // no postmaster.pid — nothing to kill
  }
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch (cleanupErr) {
    console.error(`verify: cleanup warning: ${String(cleanupErr)}`);
  }
}

if (failed) process.exit(1);
console.log("verify: PASS — elevated postgres boots via restricted token, no local account created");
