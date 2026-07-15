// FNXC:WindowsDesktopPackaging 2026-07-14-21:30:
// Embedded PostgreSQL refuses to start under a Windows process token whose
// Administrators group is ENABLED (a high-integrity / elevated token). It exits
// immediately with "Execution of PostgreSQL by a user with administrative
// permissions is not permitted." The bundled embedded-postgres server is
// spawned as a DIRECT child of the Node process (see embedded-postgres
// dist/index.js start()), so it inherits that elevated token and cannot boot.
// This only affects ELEVATED launches: GitHub windows-latest runners execute
// jobs as `runneradmin` with a fully elevated token (the smoke build fails
// here), and an end user who explicitly "Run as administrator" hits the same
// refusal. A normal Electron asInvoker launch uses a filtered/medium token
// which Postgres accepts.
//
// Fix: when the current process is elevated, boot the postgres SERVER process
// (only) under a freshly-created NON-ADMIN local user via Start-Process
// -Credential (CreateProcessWithLogonW). That user's token has no enabled
// Administrators group, so Postgres accepts it. initdb / the pg client /
// createDatabase still run as the (admin) launching process and work unchanged;
// only the server start is re-homed. Proven on the windows-2025-vs2026 runner:
// postgres reached "database system is ready to accept connections" under the
// dedicated non-admin user (broker diagnostic run 29382479266, job 87248898326).
//
// Access model: Windows grants "Bypass traverse checking" to Everyone by
// default, so the non-admin user does NOT need permission on parent dirs — only
// on the target dirs themselves. We grant the user RX on the native binary root
// and full control on the data dir.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** Handle returned by {@link startServerAsNonAdminUser}; call stop() to kill it. */
export interface NonAdminServerHandle {
  /** OS pid of the running postgres server process (from postmaster.pid). */
  readonly postgresPid: number;
  /** Stop the non-admin postgres process (taskkill). Safe to call once. */
  stop(): Promise<void>;
}

export interface NonAdminStartOptions {
  /** .../native dir containing bin/postgres.exe + lib + share. */
  readonly nativeRoot: string;
  /** The initialized PG data directory. */
  readonly dataDir: string;
  /** TCP port postgres should listen on. */
  readonly port: number;
  /** Extra flags forwarded to postgres.exe (same semantics as embedded-postgres). */
  readonly postgresFlags: readonly string[];
  readonly onLog: (message: string) => void;
  readonly onError: (messageOrError: string | Error | unknown) => void;
  /** Hard timeout (ms) on reaching "ready to accept connections". */
  readonly startTimeoutMs: number;
  /**
   * Real readiness probe: resolves true only when the server accepts queries
   * (e.g. a short-timeout `SELECT 1`). The caller owns the SQL client so this
   * module stays decoupled from the postgres client library.
   */
  readonly probeReady: () => Promise<boolean>;
}

let elevatedCache: boolean | null = null;

/**
 * True only on Windows when the current process holds an elevated admin token.
 * `net session` succeeds (exit 0) exclusively under an elevated admin token, so
 * it is a reliable elevation probe that does not depend on UAC EnableLUA.
 */
export function isWindowsElevatedAdmin(): boolean {
  if (process.platform !== "win32") return false;
  if (elevatedCache !== null) return elevatedCache;
  const r = spawnSync("net", ["session"], { encoding: "utf8", shell: true });
  elevatedCache = r.status === 0;
  return elevatedCache;
}

const DEDICATED_USER = "fusion-pg";
let dedicatedPassword: string | null = null;

/**
 * FNXC:WindowsDesktopPackaging 2026-07-14-21:35:
 * Generate a strong password that does NOT contain the account name token.
 * Windows complexity policy rejects a password containing the user's account
 * name; `net user` then re-prompts non-interactively ("No valid response was
 * provided") and creates NOTHING, which cascades into a misleading
 * "user name or password is incorrect" downstream.
 */
function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const seed =
    spawnSync("powershell", ["-NoProfile", "-Command", "[BitConverter]::ToString([guid]::NewGuid().ToByteArray())"], {
      encoding: "utf8",
    }).stdout ?? Math.random().toString(36);
  let s = "";
  for (const ch of seed) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      const idx = parseInt(ch.toLowerCase(), 16);
      if (Number.isFinite(idx)) s += chars[idx % chars.length];
    }
    if (s.length >= 22) break;
  }
  while (s.length < 22) s += chars[Math.floor(Math.random() * chars.length)];
  // Guarantee the 4 complexity categories (upper, lower, digit, symbol).
  return `Fx9!${s}#kP`;
}

/**
 * Ensure the dedicated non-admin local user exists and we know its password.
 * Idempotent: creates the user if absent, or resets its password if present
 * (so a leftover account from a prior run still works). Created users default
 * to the standard Users group — never Administrators.
 */
function ensureNonAdminUser(): { user: string; password: string } {
  if (dedicatedPassword) return { user: DEDICATED_USER, password: dedicatedPassword };
  const password = generatePassword();
  const add = spawnSync("net", ["user", DEDICATED_USER, password, "/add", "/y"], {
    encoding: "utf8",
  });
  if (add.status !== 0) {
    // Likely already exists from a prior run: reset its password so we can log on.
    const reset = spawnSync("net", ["user", DEDICATED_USER, password, "/y"], {
      encoding: "utf8",
    });
    if (reset.status !== 0) {
      throw new Error(
        `embedded postgres: could not create/reset non-admin user '${DEDICATED_USER}' ` +
          `(net user add status=${add.status}: ${(add.stderr || "").trim()}; ` +
          `reset status=${reset.status}: ${(reset.stderr || "").trim()}).`,
      );
    }
  }
  dedicatedPassword = password;
  return { user: DEDICATED_USER, password };
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-14-22:30:
 * Grant traverse (RX) on each ancestor dir of `leaf` up to the drive root, so
 * the non-admin user can reach `leaf` even when "Bypass traverse checking" is
 * restricted (the windows-2025 runner) or a profile ACL would deny traversal.
 * RX is applied folder-by-folder as a non-inheriting ACE so sibling contents
 * are not over-granted. Best-effort: ancestors that already allow traverse
 * (e.g. C:\) reject harmlessly, and a blocked path surfaces later via the
 * Start-Process error (which carries the full stderr).
 */
function grantTraverseChain(user: string, leaf: string): void {
  let dir = dirname(leaf);
  for (let depth = 0; depth < 16; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break; // drive root reached
    if (existsSync(dir)) {
      spawnSync("icacls", [dir, "/grant", `${user}:(RX)`, "/C"], { encoding: "utf8" });
    }
    dir = parent;
  }
}

/**
 * Grant the non-admin user full control on the data dir (postgres writes
 * there), read+execute on the native binary root, and traverse on each parent
 * ancestor of both so the user can reach them. F/RX grants fail fast; the
 * traverse walk is best-effort. /T applies the F/RX grants recursively; /C
 * keeps going on non-fatal errors (e.g. unreadable sibling files).
 */
function grantNonAdminAccess(user: string, nativeRoot: string, dataDir: string): void {
  for (const [target, perm] of [
    [dataDir, "(OI)(CI)F"],
    [nativeRoot, "(OI)(CI)RX"],
  ] as const) {
    if (!existsSync(target)) {
      throw new Error(`embedded postgres: non-admin grant target does not exist: ${target}`);
    }
    const r = spawnSync("icacls", [target, "/grant", `${user}:${perm}`, "/T", "/C"], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(
        `embedded postgres: failed to grant '${user}' ${perm} on ${target} ` +
          `(icacls status=${r.status}): ${(r.stderr || "").trim().slice(0, 400)}`,
      );
    }
  }
  grantTraverseChain(user, dataDir);
  grantTraverseChain(user, nativeRoot);
}


function readTail(file: string, max: number): string {
  try {
    const content = readFileSync(file, "utf-8");
    return content.length > max ? "…" + content.slice(-max) : content;
  } catch {
    return "(no log file)";
  }
}


let pwshCache: string | null | undefined;
/**
 * FNXC:WindowsDesktopPackaging 2026-07-14-22:10:
 * Resolve the PowerShell binary used to launch the non-admin server. Prefer
 * PowerShell 7 (`pwsh`): the windows-2025 runner runs Windows PowerShell 5.1
 * (`powershell.exe`) in Constrained Language Mode, where the
 * Microsoft.PowerShell.Security module cannot load (ConvertTo-SecureString
 * fails). pwsh runs unconstrained and is what the proven broker diagnostic
 * used. Fall back to powershell.exe for end-user boxes that only have 5.1 in
 * Full Language Mode.
 */
function resolvePowerShell(): string {
  if (pwshCache !== undefined) return pwshCache as string;
  const pf = process.env.PROGRAMFILES;
  const pf86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    pf ? join(pf, "PowerShell", "7", "pwsh.exe") : null,
    pf86 ? join(pf86, "PowerShell", "7", "pwsh.exe") : null,
  ].filter((v): v is string => v !== null);
  for (const c of candidates) {
    if (existsSync(c)) {
      pwshCache = c;
      return c;
    }
  }
  const where = spawnSync("where", ["pwsh"], { encoding: "utf8", shell: true });
  if (where.status === 0) {
    const found = (where.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (found) {
      pwshCache = found;
      return found;
    }
  }
  pwshCache = "powershell.exe";
  return pwshCache;
}

/**
 * Start postgres.exe under the dedicated non-admin user and resolve once it is
 * accepting connections. Rejects with a clear error (including the postgres log
 * tail) on timeout or early exit. The returned handle's stop() kills the server.
 */
export async function startServerAsNonAdminUser(
  opts: NonAdminStartOptions,
): Promise<NonAdminServerHandle> {
  const startMs = Date.now();
  const { user, password } = ensureNonAdminUser();
  const tGrant = Date.now();
  grantNonAdminAccess(user, opts.nativeRoot, opts.dataDir);
  opts.onLog(`non-admin timing: user=${tGrant - startMs}ms grant=${Date.now() - tGrant}ms`);

  const pgExe = join(opts.nativeRoot, "bin", "postgres.exe");
  const runDir = join(opts.dataDir, ".pgrunner");
  mkdirSync(runDir, { recursive: true });
  const logFile = join(runDir, "postgres.log");
  // FNXC:WindowsDesktopPackaging 2026-07-14-22:50:
  // Separate wrapper log: the bat echoes whoami / cwd / the exact postgres
  // command / the exit code here (cmd's own output), while postgres's output
  // goes to logFile. This distinguishes "bat never ran", "postgres exited",
  // and "postgres running but not listening" — postgres.log alone can be empty
  // when the bat never reaches the postgres command.
  const wrapperLog = join(runDir, "wrapper.log");
  const bat = join(runDir, "launch.bat");
  const args = ["-D", opts.dataDir, "-p", String(opts.port), ...opts.postgresFlags];
  // Set TMP/TEMP inside the granted data dir so the non-admin postgres process
  // never writes outside an accessible location.
  const argStr = args.map((a) => `"${a}"`).join(" ");
  writeFileSync(
    bat,
    [
      "@echo off",
      `set "TMP=${runDir}"`,
      `set "TEMP=${runDir}"`,
      `call :main >> "${wrapperLog}" 2>&1`,
      "exit /b",
      ":main",
      "echo launch-start",
      "whoami",
      "cd",
      `echo cmd: "${pgExe}" ${argStr}`,
      `"${pgExe}" ${argStr} > "${logFile}" 2>&1`,
      "echo exit=%ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "ascii",
  );

  const computerName = process.env.COMPUTERNAME ?? "";
  const domainUser = computerName ? `${computerName}\\${user}` : user;
  // Launch detached under the non-admin credential. Start-Process returns at
  // once with a process object (postgres keeps running in the background).
  //
  // FNXC:WindowsDesktopPackaging 2026-07-14-21:50:
  // Use a parametrized launcher .ps1 invoked with -File + params, NOT an inline
  // -Command string. The bat path contains backslashes (literal in a PS
  // single-quoted string — doubling them would corrupt it to C:\\...) and the
  // password contains ! and #; passing each as a discrete argv token via -File
  // params is robust across Node's Windows arg escaping and PowerShell parsing.
  const launcherPs1 = join(runDir, "launch.ps1");
  writeFileSync(
    launcherPs1,
    [
      "param([string]$User,[string]$Password,[string]$DomainUser,[string]$Bat)",
      "$ErrorActionPreference='Stop'",
      // FNXC:WindowsDesktopPackaging 2026-07-14-22:15:
      // Build the SecureString char-by-char instead of ConvertTo-SecureString,
      // which lives in Microsoft.PowerShell.Security — a module that fails to
      // load under Windows PowerShell 5.1 Constrained Language Mode. System.
      // Security.SecureString + PSCredential are core SMA/.NET types available
      // without that module.
      "$s = New-Object System.Security.SecureString",
      "foreach ($ch in $Password.ToCharArray()) { [void]$s.AppendChar($ch) }",
      "$s.MakeReadOnly()",
      "$c = New-Object System.Management.Automation.PSCredential($DomainUser,$s)",
      "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',$Bat -Credential $c -WindowStyle Hidden -PassThru",
      "Write-Output $p.Id",
      "",
    ].join("\r\n"),
    "ascii",
  );
  const tLaunch = Date.now();
  const powerShell = resolvePowerShell();
  const launch = spawnSync(
    powerShell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPs1,
      "-User",
      user,
      "-Password",
      password,
      "-DomainUser",
      domainUser,
      "-Bat",
      bat,
    ],
    { encoding: "utf8" },
  );
  const wrapperPid = parseInt((launch.stdout || "").trim(), 10);
  if (!Number.isFinite(wrapperPid)) {
    throw new Error(
      `embedded postgres: failed to launch non-admin postgres ` +
        `(${powerShell} status=${launch.status} ` +
        `stdout=${(launch.stdout || "").trim().slice(0, 500)} ` +
        `stderr=${(launch.stderr || "").trim().slice(0, 2000)}).`,
    );
  }
  opts.onLog(
    `embedded postgres: launched postgres as non-admin user '${user}' (wrapper pid ${wrapperPid}); ` +
      `waiting for port ${opts.port}`,
  );
  opts.onLog(`non-admin timing: launch=${Date.now() - tLaunch}ms setup-before-probe=${Date.now() - startMs}ms`);

  // FNXC:WindowsDesktopPackaging 2026-07-14-23:20:
  // Poll readiness with a real short-timeout SQL probe. Do NOT read the
  // redirected postgres log in the hot loop — postgres holds it locked, so a
  // readFileSync blocks for tens of seconds (observed ~57s on windows-2025),
  // which blows the test budget. A SQL SELECT 1 is the true readiness signal:
  // postgres rejects the startup handshake with "the database system is
  // starting up" until it is actually accepting queries, so unlike a bare TCP
  // connect it cannot fire prematurely during crash recovery.
  const deadline = Date.now() + Math.max(opts.startTimeoutMs, 1000);
  let ready = false;
  while (Date.now() < deadline) {
    if (await opts.probeReady()) {
      ready = true;
      break;
    }
    const { promise: sleep, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, 300);
    await sleep;
  }
  opts.onLog(`non-admin timing: probe-loop done ready=${ready} total=${Date.now() - startMs}ms`);

  if (!ready) {
    // Kill the wrapper tree first (cmd.exe + its postgres child); only then
    // are the redirected log files unlocked and safe to read for diagnostics.
    spawnSync("taskkill", ["/pid", String(wrapperPid), "/f", "/t"], { encoding: "utf8" });
    const tail = readTail(logFile, 2000);
    const wrapperTail = readTail(wrapperLog, 1000);
    throw new Error(
      `embedded postgres: non-admin postgres did not become ready within ${opts.startTimeoutMs}ms.\n` +
        `wrapper={${wrapperTail}}\npg={${tail}}`,
    );
  }

  let stopped = false;
  return {
    postgresPid: wrapperPid,
    async stop() {
      if (stopped) return;
      stopped = true;
      // /t kills the whole tree: the cmd.exe wrapper + its postgres child.
      spawnSync("taskkill", ["/pid", String(wrapperPid), "/f", "/t"], { encoding: "utf8" });
    },
  };
}
