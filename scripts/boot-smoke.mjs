#!/usr/bin/env node
/**
 * Boot smoke check — the merge gate's "the app starts and serves" proof.
 *
 * Verifies, against the *built* workspace (run `pnpm build` first):
 *   1. The CLI answers `--help` with exit 0.
 *   2. `fn serve` boots a real HTTP server on an ephemeral port and
 *      GET /api/health returns 200 within the timeout.
 *   3. The server shuts down cleanly on SIGTERM.
 *
 * Safety properties (see scripts/check-no-kill-4040.mjs and AGENTS.md):
 * (port-4040-allowlist: this file only ever AVOIDS the reserved ports — it
 * requests an ephemeral port and rejects reserved ones; it never binds,
 * probes, or kills them.)
 * (process-supervisor-allowlist: raw spawn is intentional here — this is a
 * standalone repo script outside the package graph, the child is attached
 * (not detached), and lifecycle is bounded by the timeouts + signal handlers
 * below; importing superviseSpawn from @fusion/core would invert the
 * dependency direction for a build-time smoke check.)
 *   - Never binds or touches port 4040 / FUSION_RESERVED_PORTS — an ephemeral
 *     port is requested from the OS (listen on 0) and double-checked against
 *     the reserved list.
 *   - Never kills anything except the child process it spawned itself.
 *   - Runs with an isolated $HOME (mkdtemp) so it cannot read or corrupt a
 *     developer's real fusion.db or auth state.
 *
 * Exit code is the verdict: 0 = boots and serves, non-zero = broken, with
 * captured child stderr on stdout for CI logs.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(repoRoot, "packages/cli/bin.mjs");

const HEALTH_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
// Ephemeral-port TOCTOU: retry the whole boot with a fresh port when the
// child loses the bind race (EADDRINUSE).
const BOOT_ATTEMPTS = 3;

function parsePortList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0);
}

const RESERVED_PORTS = new Set([4040, ...parsePortList(process.env.FUSION_RESERVED_PORTS)]);

/** Ask the OS for a free ephemeral port, retrying if it lands on a reserved one. */
async function getEphemeralPort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("could not obtain a non-reserved ephemeral port");
}

function fail(message, stderr = "") {
  console.error(`boot-smoke: FAIL — ${message}`);
  if (stderr.trim()) {
    console.error("--- child stderr (tail) ---");
    console.error(stderr.split("\n").slice(-40).join("\n"));
  }
  process.exit(1);
}

async function pollHealth(port, deadline) {
  const url = `http://127.0.0.1:${port}/api/health`;
  let lastError = "no response";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 200) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.cause?.code ?? err?.name ?? String(err);
    } finally {
      clearTimeout(abortTimer);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`health check never returned 200 (last: ${lastError})`);
}

async function main() {
  // 1. CLI answers --help.
  const help = spawnSync(process.execPath, [cliBin, "--help"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (help.status !== 0) {
    fail(`\`fn --help\` exited ${help.status ?? `signal ${help.signal}`}`, help.stderr ?? "");
  }
  if (!/serve/i.test(help.stdout ?? "")) {
    fail("`fn --help` output does not mention the serve command", help.stderr ?? "");
  }
  console.log("boot-smoke: `fn --help` OK");

  // 2. Real server boot on an ephemeral port with an isolated HOME.
  // The ephemeral-port probe is inherently TOCTOU (probe closes before the
  // server binds), so an EADDRINUSE loss on a busy machine retries with a
  // fresh port instead of failing the gate.
  let cleanup = () => {};
  process.on("exit", () => cleanup());
  // Node does NOT fire 'exit' on signals by default. A cancelled CI job
  // (timeout, manual cancel, runner eviction) sends SIGTERM — without these
  // handlers the serve child would be orphaned.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    const result = await bootAndVerify(attempt, (fn) => (cleanup = fn));
    if (result === "retry-port") continue;
    console.log("boot-smoke: PASS");
    return;
  }
  fail(`could not bind a server port after ${BOOT_ATTEMPTS} attempts (EADDRINUSE each time)`);
}

/**
 * One boot attempt: spawn, poll health, verify SIGTERM shutdown.
 * Returns "retry-port" when the child lost the ephemeral-port race
 * (EADDRINUSE); calls fail() (which exits) on any real failure.
 */
async function bootAndVerify(attempt, registerCleanup) {
  const port = await getEphemeralPort();
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "fusion-boot-smoke-"));
  let stderrBuf = "";

  const child = spawn(
    process.execPath,
    [cliBin, "serve", "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: isolatedHome,
        FUSION_SKIP_ONBOARDING: "1",
        // Make sure nothing inherits a PORT that fights the explicit flag.
        PORT: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (d) => (stderrBuf += d));
  child.stdout.on("data", (d) => (stderrBuf += d));

  registerCleanup(() => {
    // 'exit' handlers cannot await: escalate straight to SIGKILL so a child
    // that ignores SIGTERM is never orphaned holding the port/tmpdir. The
    // graceful SIGTERM path below runs before this on the success path.
    try {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    } catch {
      // ESRCH: child already reaped between the check and the kill — fine.
    }
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  const exitedEarly = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await Promise.race([
      pollHealth(port, Date.now() + HEALTH_TIMEOUT_MS),
      exitedEarly.then(({ code, signal }) => {
        throw new Error(`server exited before becoming healthy (${code ?? `signal ${signal}`})`);
      }),
    ]);
  } catch (err) {
    if (/EADDRINUSE/.test(stderrBuf) && attempt < BOOT_ATTEMPTS) {
      console.log(`boot-smoke: port :${port} lost to another process (EADDRINUSE), retrying with a fresh port (attempt ${attempt}/${BOOT_ATTEMPTS})`);
      await exitedEarly; // child is already dead or dying; wait so cleanup is race-free
      rmSync(isolatedHome, { recursive: true, force: true });
      return "retry-port";
    }
    fail(err.message, stderrBuf);
  }
  console.log(`boot-smoke: GET /api/health 200 on :${port}`);

  // 3. Clean shutdown of OUR child only. The verdict requires BOTH that
  // SIGTERM was actually delivered (a server that died between the health
  // check and here is a failure, not a pass) AND that the exit was clean
  // (SIGTERM or exit code 0) — a crash after serving is a broken boot path.
  let sigtermSent = false;
  try {
    sigtermSent = child.kill("SIGTERM");
  } catch {
    // ESRCH: server already exited — sigtermSent stays false and fails below.
  }
  const { code, signal } = await Promise.race([
    exitedEarly,
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: null, signal: "timeout" }), SHUTDOWN_TIMEOUT_MS),
    ),
  ]);
  if (!sigtermSent) {
    fail(`server exited on its own after the health check (${code ?? `signal ${signal}`}) — SIGTERM shutdown could not be verified`, stderrBuf);
  }
  if (signal === "timeout") {
    child.kill("SIGKILL");
    fail("server did not shut down within 15s of SIGTERM", stderrBuf);
  }
  if (signal !== "SIGTERM" && code !== 0) {
    fail(`server exited uncleanly on SIGTERM (${code ?? `signal ${signal}`})`, stderrBuf);
  }
  console.log(`boot-smoke: clean shutdown (${code ?? signal})`);
  return "ok";
}

main().catch((err) => fail(err.message ?? String(err)));
