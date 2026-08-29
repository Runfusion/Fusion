#!/usr/bin/env node
/**
 * test-with-lock.mjs
 *
 * Serializes `pnpm test:full` across concurrent git-worktree agent sessions so
 * multiple Claude Code instances don't saturate the machine with vitest forks.
 *
 * Acquires an exclusive lock at ~/.fusion/test.lock (Darwin/Linux, O_EXLOCK)
 * before running the underlying test command, then releases it on exit.
 * While waiting it prints the PID and worktree path of the lock holder so
 * the developer knows who is blocking.
 *
 * Usage:  pnpm test:locked [extra args passed to pnpm test:full]
 * e.g.:   pnpm test:locked --filter @fusion/core
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_DIR = path.join(os.homedir(), ".fusion");
const LOCK_FILE = path.join(LOCK_DIR, "test.lock");
const META_FILE = path.join(LOCK_DIR, "test.lock.meta");
const POLL_MS = 1_500;

// O_EXLOCK is a BSD/Darwin extension; value 0x20 on macOS.
// On Linux this flag is silently ignored by glibc — fall back to a best-effort
// advisory lock using a separate meta-file race (good enough for the single
// macOS use-case described in the brief).
const O_EXLOCK = 0x20;
const O_CREAT = fs.constants.O_CREAT;
const O_RDWR = fs.constants.O_RDWR;
const O_NONBLOCK = fs.constants.O_NONBLOCK;

const isMacOS = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read PID + worktree from the meta file, or return null on any error. */
function readMeta() {
  try {
    const raw = fs.readFileSync(META_FILE, "utf8").trim();
    const [pidStr, ...rest] = raw.split("\n");
    return { pid: Number(pidStr), worktree: rest.join("\n") || "(unknown)" };
  } catch {
    return null;
  }
}

/** Write our PID + CWD into the meta file so waiters can identify us. */
function writeMeta() {
  fs.writeFileSync(META_FILE, `${process.pid}\n${process.cwd()}`, "utf8");
}

/** Remove meta file, ignoring errors. */
function cleanMeta() {
  try { fs.unlinkSync(META_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Lock acquisition (macOS O_EXLOCK, non-blocking with busy-wait)
// ---------------------------------------------------------------------------

let lockFd = -1;

function ensureLockDir() {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
}

/**
 * Try to open the lock file with O_EXLOCK | O_NONBLOCK.
 * Returns true on success, false if another process holds the lock.
 * Throws on unexpected errors.
 */
function tryAcquire() {
  if (!isMacOS) {
    // Non-macOS: use a simple existence check (advisory, not atomic, but
    // sufficient for the documented single-platform use case).
    try {
      // O_EXCL + O_CREAT is atomic on POSIX for the create step.
      lockFd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  }

  try {
    lockFd = fs.openSync(LOCK_FILE, O_CREAT | O_RDWR | O_EXLOCK | O_NONBLOCK);
    return true;
  } catch (err) {
    if (err.code === "EWOULDBLOCK" || err.code === "EAGAIN") return false;
    throw err;
  }
}

function releaseLock() {
  if (lockFd >= 0) {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    lockFd = -1;
  }
  // Remove the lock file so the next waiter's O_EXCL create succeeds on Linux.
  if (!isMacOS) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
  cleanMeta();
}

/** Block until we hold the lock, printing status while waiting. */
async function acquireWithWait() {
  ensureLockDir();

  let waited = false;
  while (!tryAcquire()) {
    if (!waited) {
      const meta = readMeta();
      if (meta) {
        console.log(
          `[test-with-lock] waiting for test lock held by PID ${meta.pid} (worktree: ${meta.worktree})`,
        );
      } else {
        console.log("[test-with-lock] waiting for test lock…");
      }
      waited = true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  writeMeta();
  if (waited) {
    console.log("[test-with-lock] lock acquired, starting tests.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Release on any kind of exit so we don't leave stale locks.
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    releaseLock();
    if (sig !== "exit") process.exit(1);
  });
}

await acquireWithWait();

// Forward all argv after the script name to `pnpm test:full`.
const extraArgs = process.argv.slice(2);
const child = spawn(
  "pnpm",
  ["test:full", ...extraArgs],
  { stdio: "inherit", shell: false },
);

child.on("close", (code) => {
  releaseLock();
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error("[test-with-lock] failed to spawn pnpm:", err.message);
  releaseLock();
  process.exit(1);
});
