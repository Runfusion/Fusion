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
import { createConnection } from "node:net";
import { join, dirname } from "node:path";

/** Handle returned by {@link startServerAsNonAdminUser}; call stop() to kill it. */
export interface NonAdminServerHandle {
  /**
   * Best-effort OS pid of the running postgres server (from postmaster.pid when
   * available). May be the cmd wrapper pid until postmaster.pid appears.
   */
  readonly postgresPid: number;
  /**
   * Stop the non-admin postgres process (taskkill). Safe to call once.
   *
   * FNXC:PostgresStartupRace 2026-07-15-21:10:
   * Resolves its target through the data dir's `postmaster.pid`, so it kills whichever
   * postmaster currently owns that dir — NOT necessarily the one this handle launched. Only
   * call it when this process is the sole starter. A caller that lost a startup race to
   * another process must use {@link stopWrapperOnly}, or it will kill the winner.
   */
  stop(): Promise<void>;
  /**
   * Kill only the wrapper this handle launched (and its children), never the postmaster named
   * by the shared `postmaster.pid`.
   *
   * FNXC:PostgresStartupRace 2026-07-15-21:10:
   * Exists for the lost-startup-race path: our postgres refused the lock and exited, so the
   * wrapper is dead or dying, but `postmaster.pid` now belongs to the process we are about to
   * join. Dropping the handle would leak the wrapper; calling {@link stop} would kill the
   * winner. This kills our side only, and is a harmless no-op once the wrapper has exited.
   */
  stopWrapperOnly(): Promise<void>;
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
   * FNXC:WindowsDesktopPackaging 2026-07-15-05:20:
   * Cooperative cancellation from EmbeddedPostgresLifecycle.start()'s AbortController.
   * When aborted during readiness polling, kill the wrapper/postmaster immediately.
   */
  readonly signal?: AbortSignal;
  /**
   * Invoked as soon as the cmd wrapper PID is known (before readiness) so the
   * lifecycle can stop orphans if the outer start() timeout wins the race.
   */
  readonly onLaunched?: (handle: NonAdminServerHandle) => void;
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
 * FNXC:WindowsDesktopPackaging 2026-07-15-05:25:
 * Fully randomized password with all four complexity classes and no fixed
 * prefix/suffix (review feedback: constant frames reduce entropy). Avoids the
 * account-name token so Windows complexity policy accepts it.
 */
function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^*_-+=?";
  const all = upper + lower + digits + symbols;
  const seed =
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "[BitConverter]::ToString([guid]::NewGuid().ToByteArray()) + [BitConverter]::ToString([guid]::NewGuid().ToByteArray())"],
      { encoding: "utf8" },
    ).stdout ?? Math.random().toString(36) + Math.random().toString(36);

  const required = [
    upper[Math.floor(Math.random() * upper.length)]!,
    lower[Math.floor(Math.random() * lower.length)]!,
    digits[Math.floor(Math.random() * digits.length)]!,
    symbols[Math.floor(Math.random() * symbols.length)]!,
  ];
  let body = "";
  for (const ch of seed) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      const idx = parseInt(ch.toLowerCase(), 16);
      if (Number.isFinite(idx)) body += all[idx % all.length]!;
    }
    if (body.length >= 20) break;
  }
  while (body.length < 20) body += all[Math.floor(Math.random() * all.length)]!;
  const chars = [...required, ...body.split("")];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join("");
}

/**
 * Ensure the dedicated non-admin local user exists and we know its password.
 * Idempotent: creates the user if absent, or resets its password if present
 * (so a leftover account from a prior run still works). Always strips
 * Administrators membership so a reused account cannot stay elevated.
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
  // FNXC:WindowsDesktopPackaging 2026-07-15-05:25:
  // A leftover fusion-pg that was manually promoted to Administrators would
  // still be refused by postgres. Demote and fail closed unless the account is
  // already not a member (review: ignore silent demote failures).
  // FNXC:WindowsDesktopPackaging 2026-07-14-22:53:
  // net localgroup /delete status 0 = removed; non-zero is OK only when the
  // account was already not in Administrators ("not a member" / "could not find").
  const demote = spawnSync(
    "net",
    ["localgroup", "Administrators", DEDICATED_USER, "/delete"],
    { encoding: "utf8" },
  );
  if (demote.status !== 0) {
    const demoteOut = `${demote.stdout || ""}\n${demote.stderr || ""}`.toLowerCase();
    const alreadyNotMember =
      demoteOut.includes("not a member") ||
      demoteOut.includes("could not find") ||
      demoteOut.includes("no such") ||
      demoteOut.includes("does not exist");
    if (!alreadyNotMember) {
      throw new Error(
        `embedded postgres: failed to remove '${DEDICATED_USER}' from Administrators ` +
          `(net localgroup status=${demote.status}): ` +
          `${(demote.stderr || demote.stdout || "").trim().slice(0, 400)}. ` +
          "PostgreSQL refuses to start under an administrative token; demote the " +
          "account or run Fusion non-elevated.",
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

function readPostgresPid(dataDir: string): number | null {
  try {
    const lines = readFileSync(join(dataDir, "postmaster.pid"), "utf-8").split("\n");
    const pid = parseInt((lines[0] ?? "").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readTail(file: string, max: number): string {
  try {
    const content = readFileSync(file, "utf-8");
    return content.length > max ? "…" + content.slice(-max) : content;
  } catch {
    return "(no log file)";
  }
}

/**
 * FNXC:WindowsDesktopPackaging 2026-07-15-05:25:
 * Reject postgresFlags that would break cmd.exe quoting or enable injection
 * when embedded into launch.bat (review: arbitrary flags with % " & | etc.).
 */
export function sanitizePostgresFlags(flags: readonly string[]): string[] {
  const safe: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== "string" || flag.length === 0) {
      throw new Error(`embedded postgres: invalid postgresFlags entry (empty/non-string)`);
    }
    if (/[\r\n"%&|<>^!]/.test(flag)) {
      throw new Error(
        `embedded postgres: postgresFlags entry contains cmd.exe-sensitive characters: ${JSON.stringify(flag)}`,
      );
    }
    safe.push(flag);
  }
  return safe;
}

/** Quote a path for cmd.exe double-quoted args (escape embedded quotes). */
function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
  const { user, password } = ensureNonAdminUser();
  grantNonAdminAccess(user, opts.nativeRoot, opts.dataDir);

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
  // FNXC:WindowsDesktopPackaging 2026-07-15-05:05:
  // Truncate logs each launch. The bat appends (>>) so a prior stop that wrote
  // `exit=1` would make the readiness poll throw "exited before becoming ready"
  // on the next start against a reused data directory (VAL-CONN-006).
  writeFileSync(logFile, "", "utf8");
  writeFileSync(wrapperLog, "", "utf8");
  const bat = join(runDir, "launch.bat");
  const safeFlags = sanitizePostgresFlags(opts.postgresFlags);
  const args = ["-D", opts.dataDir, "-p", String(opts.port), ...safeFlags];
  // Set TMP/TEMP inside the granted data dir so the non-admin postgres process
  // never writes outside an accessible location.
  const argStr = args.map((a) => cmdQuote(a)).join(" ");
  // FNXC:WindowsDesktopPackaging 2026-07-15-05:25:
  // UTF-8 + chcp 65001 so non-ASCII profile paths (e.g. C:\Users\José) are not
  // corrupted when cmd.exe reads the bat (review: ASCII encoding broke paths).
  writeFileSync(
    bat,
    [
      "@echo off",
      "chcp 65001 >nul",
      `set "TMP=${runDir}"`,
      `set "TEMP=${runDir}"`,
      `call :main >> ${cmdQuote(wrapperLog)} 2>&1`,
      "exit /b",
      ":main",
      "echo launch-start",
      "whoami",
      "cd",
      `echo cmd: ${cmdQuote(pgExe)} ${argStr}`,
      `${cmdQuote(pgExe)} ${argStr} > ${cmdQuote(logFile)} 2>&1`,
      "echo exit=%ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "utf8",
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
    "utf8",
  );
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

  let stopped = false;
  const killAll = (): void => {
    if (stopped) return;
    stopped = true;
    const pid = readPostgresPid(opts.dataDir);
    if (pid) spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { encoding: "utf8" });
    spawnSync("taskkill", ["/pid", String(wrapperPid), "/f", "/t"], { encoding: "utf8" });
  };

  // FNXC:WindowsDesktopPackaging 2026-07-15-05:20:
  // Publish a stop handle immediately so lifecycle timeout cleanup can kill the
  // wrapper even while readiness is still polling (review: orphan on timeout).
  const handle: NonAdminServerHandle = {
    get postgresPid() {
      return readPostgresPid(opts.dataDir) ?? wrapperPid;
    },
    async stop() {
      killAll();
    },
    async stopWrapperOnly() {
      if (stopped) return;
      stopped = true;
      // /t takes our wrapper's own children (our postgres.exe, if it ever came up). It cannot
      // reach a racing winner: that postmaster is another process's child, not ours.
      spawnSync("taskkill", ["/pid", String(wrapperPid), "/f", "/t"], { encoding: "utf8" });
    },
  };
  opts.onLaunched?.(handle);

  opts.onLog(
    `embedded postgres: launched postgres as non-admin user '${user}' (wrapper pid ${wrapperPid}); ` +
      `waiting for port ${opts.port}`,
  );

  // Poll for readiness until the server accepts connections or the timeout hits.
  // FNXC:WindowsDesktopPackaging 2026-07-14-22:53:
  // startTimeoutMs <= 0 means unbounded (matches outer lifecycle: 0 disables
  // the start timeout). Math.max(..., 1000) previously forced a 1s deadline and
  // killed elevated boots when callers disabled the timeout (review feedback).
  const hasDeadline =
    opts.startTimeoutMs > 0 && Number.isFinite(opts.startTimeoutMs);
  const deadline = hasDeadline
    ? Date.now() + opts.startTimeoutMs
    : Number.POSITIVE_INFINITY;
  let ready = false;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      killAll();
      throw new Error(
        `embedded postgres: non-admin launch cancelled before ready (wrapper pid ${wrapperPid}).`,
      );
    }
    // FNXC:WindowsDesktopPackaging 2026-07-14-23:05:
    // Lightweight poll: readFileSync only. Do NOT spawn tasklist/probePort in
    // the hot loop — a synchronous tasklist per iteration blocked ~16s between
    // polls on windows-2025, blowing the test's 15s budget before postgres's
    // "ready" marker was observed (and orphaning servers when start() never
    // returned). Readiness = the postgres log "ready to accept connections"
    // marker (the same one embedded-postgres watches). Exit = the wrapper bat's
    // "exit=" line (written only once postgres returns). Errors = a FATAL in
    // the postgres log. Logs are emitted only on change to avoid per-poll spam.
    const tail = readTail(logFile, 3000);
    const wrapperTail = readTail(wrapperLog, 1500);
    const snapshot = `${wrapperTail}\u0000${tail.slice(-400)}`;
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      opts.onLog(`non-admin poll wrapper={${wrapperTail}} pg={${tail.slice(-400)}}`);
    }
    if (/database system is ready to accept connections/.test(tail)) {
      // FNXC:WindowsDesktopPackaging 2026-07-15-05:00:
      // Log readiness alone is not enough: confirm TCP accept on 127.0.0.1 so
      // ensureDatabase cannot hang on a connect that never completes (IPv6 /
      // cross-session loopback quirks). Probe is async and cheap.
      if (await probeTcpPort(opts.port, 500)) {
        ready = true;
        break;
      }
    }
    if (/\bFATAL\b|\bPANIC\b|could not (bind|start|create|access|connect|load)|not permitted|Permission denied|is not the owner/i.test(tail)) {
      killAll();
      throw new Error(
        `embedded postgres: non-admin postgres reported a startup error before opening the port.\n${tail}`,
      );
    }
    if (/^exit=/m.test(wrapperTail)) {
      killAll();
      throw new Error(
        `embedded postgres: non-admin postgres exited before becoming ready.\nwrapper={${wrapperTail}}\npg={${tail}}`,
      );
    }
    // Avoid Promise.withResolvers (needs lib es2024); package tsconfig stays on es2022.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  if (!ready) {
    const tail = readTail(logFile, 1500);
    killAll();
    throw new Error(
      `embedded postgres: non-admin postgres did not become ready` +
        (hasDeadline ? ` within ${opts.startTimeoutMs}ms` : "") +
        `.\n${tail}`,
    );
  }

  if (opts.signal?.aborted) {
    killAll();
    throw new Error(
      `embedded postgres: non-admin launch cancelled after ready (wrapper pid ${wrapperPid}).`,
    );
  }

  const postgresPid = readPostgresPid(opts.dataDir);
  if (!postgresPid) {
    opts.onError("embedded postgres: started but could not read postmaster.pid");
  }

  const resolvedPid = postgresPid ?? wrapperPid;
  opts.onLog(
    `embedded postgres: non-admin server ready on 127.0.0.1:${opts.port} (pid ${resolvedPid})`,
  );
  return handle;
}

/** True when a TCP accept is available on 127.0.0.1:port within timeoutMs. */
function probeTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
