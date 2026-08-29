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
 *   - Runs with an isolated $HOME and throwaway cwd project (mkdtemp) so it
 *     cannot read or corrupt a developer's real fusion.db, task artifacts, or auth state.
 *
 * Exit code is the verdict: 0 = boots and serves, non-zero = broken, with
 * captured child stderr on stdout for CI logs.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(repoRoot, "packages/cli/bin.mjs");

// FNXC:BackendFlip 2026-06-26-14:50:
// The boot smoke exercises the embedded PostgreSQL backend by default. This
// is the zero-config production path post default-flip: with DATABASE_URL
// unset and no FUSION_NO_EMBEDDED_PG opt-out, the startup factory boots the
// bundled embedded PG. The first run pays a one-time initdb cost (writing the
// cluster data directory), which can take well over a minute on a cold
// filesystem/CI runner. The health-check timeout is therefore generous so
// the merge gate does not flake on the embedded initdb cost.
//
// DATABASE_URL is explicitly unset in the child env so a developer's real
// external DB connection string can never leak into the smoke and change the
// backend under test. FUSION_NO_EMBEDDED_PG is also explicitly unset so the
// smoke always exercises the embedded default (it cannot be opted out by an
// inherited env var).
const HEALTH_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
// Ephemeral-port TOCTOU: retry the whole boot with a fresh port when the
// child loses the bind race (EADDRINUSE).
const BOOT_ATTEMPTS = 3;
const TIMINGS_ENABLED = process.env.BOOT_SMOKE_TIMINGS === "1";

/*
 * FNXC:BootSmoke 2026-08-13-02:23:
 * FN-9020 measured the post-W32 boot-smoke regression phase by phase. `fn init`
 * and `fn --help` are independent CLI processes, so serializing them charged both
 * imports to every gate run without adding proof. Start them together, wait for
 * both original assertions, then boot serve only after init has written its marker.
 * The optional timings flag keeps normal merge-gate output unchanged while leaving
 * future regressions attributable without a wall-clock test threshold.
 */
export function createBootSmokePhasePlan({ attempt = 1, dataDir = "cold" } = {}) {
  return [
    { name: "help", assertion: "help-exits-0-and-mentions-serve", concurrency: "preflight" },
    { name: "init", assertion: "init-settles-and-writes-project-marker", concurrency: "preflight", dataDir },
    { name: "serve", assertion: "health-200", dependsOn: ["init"], attempt },
    { name: "shutdown", assertion: "sigterm-delivered-and-clean-exit", dependsOn: ["serve"] },
  ];
}

/*
 * FNXC:BootSmoke 2026-08-13-02:32:
 * FN-9020 requires the phase plan to control production scheduling, not merely
 * describe it for tests. Dispatch every independent preflight before awaiting
 * either result; a serialized await would restore the avoidable CLI-import cost
 * while retaining all four smoke assertions.
 */
export async function runPreflightPhasePlan(plan, runPhase) {
  const preflight = plan.filter((phase) => phase.concurrency === "preflight");
  return Object.fromEntries(await Promise.all(
    preflight.map(async (phase) => [phase.name, await runPhase(phase)]),
  ));
}

/** Construct the isolated child environment without retaining ambient database or port state. */
export function createChildEnv(baseEnv, isolatedHome) {
  return {
    ...baseEnv,
    HOME: isolatedHome,
    FUSION_SKIP_ONBOARDING: "1",
    DATABASE_URL: undefined,
    FUSION_NO_EMBEDDED_PG: undefined,
    PORT: undefined,
  };
}

/** Return the deterministic init assertion failure, or null when its liveness proof holds. */
export function classifyInitFailure(init, projectMarkerExists) {
  const output = `${init.stdout ?? ""}${init.stderr ?? ""}`;
  if (init.error) return "process-error";
  if (init.status !== 0) return "non-zero-exit";
  if (/Detected unsettled top-level await/.test(output)) return "unsettled-top-level-await";
  if (!projectMarkerExists) return "missing-project-marker";
  return null;
}

function parsePortList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0);
}

const RESERVED_PORTS = new Set([4040, ...parsePortList(process.env.FUSION_RESERVED_PORTS)]);

/*
 * FNXC:BootSmoke 2026-07-07-00:00:
 * On macOS the just-terminated `fn serve` child (plus OS-level fsevents/Spotlight
 * indexing) can still be writing into the throwaway `$HOME`/project dirs
 * (`/var/folders/.../fusion-boot-smoke-*`) when cleanup runs, so a synchronous
 * `rmSync(..., { recursive: true, force: true })` intermittently throws ENOTEMPTY.
 * Cleanup runs from the `process.on("exit")` handler and the retry-port branch —
 * both AFTER `boot-smoke: PASS` has already been decided/printed — so an uncaught
 * throw there turned a genuine pass into a `pnpm verify:fast` failure. `rmSync`'s
 * own `maxRetries`/`retryDelay` already retries transient ENOTEMPTY/EBUSY/EPERM
 * synchronously (exit handlers cannot await, so async `fs.rm` is not an option
 * here); the outer try/catch is the final safety net that swallows the error if
 * removal never succeeds, so a post-PASS cleanup failure can never fail the gate.
 */
/**
 * Remove a throwaway boot-smoke temp dir, tolerating the macOS ENOTEMPTY
 * async-writer race. Never throws — a cleanup failure after the smoke
 * verdict is already decided must not change the exit code.
 */
export function removeTempDir(dir, { rm = rmSync, maxRetries = 5, retryDelayMs = 100 } = {}) {
  try {
    rm(dir, { recursive: true, force: true, maxRetries, retryDelay: retryDelayMs });
  } catch (err) {
    console.warn(`boot-smoke: cleanup of ${dir} failed after retries (ignored): ${err?.message ?? err}`);
  }
}

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

/*
 * FNXC:TestInfrastructure 2026-08-15-22:59:
 * FN-9105 confirmed that a single boot-smoke wall-clock sample is noisy because
 * each run creates a cold isolated embedded-PostgreSQL home. Investigate a spike
 * with five sequential `BOOT_SMOKE_TIMINGS=1` samples and their median; do not
 * widen timeouts, add retries, or loosen assertions to make a one-shot number look better.
 */
function createPhaseTimer() {
  const timings = {};
  return {
    async measure(name, run) {
      const startedAt = performance.now();
      try {
        return await run();
      } finally {
        timings[name] = Math.round(performance.now() - startedAt);
      }
    },
    report(attempt) {
      if (TIMINGS_ENABLED) console.log(`boot-smoke: timings attempt ${attempt} ${JSON.stringify(timings)}`);
    },
  };
}

function fail(message, stderr = "") {
  console.error(`boot-smoke: FAIL — ${message}`);
  if (stderr.trim()) {
    console.error("--- child stderr (tail) ---");
    console.error(stderr.split("\n").slice(-200).join("\n"));
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
  // Real server boot on an ephemeral port with isolated HOME/project state.
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
/** Spawn a bounded CLI preflight command while collecting the output its assertion needs. */
async function runCli(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timeout;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", (error) => settle({ error, status: null, signal: null, stdout, stderr }));
    child.once("exit", (status, signal) => settle({ error: null, status, signal, stdout, stderr }));
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ error: new Error(`${command} timed out`), status: null, signal: "SIGKILL", stdout, stderr });
    }, options.timeout);
  });
}

async function bootAndVerify(attempt, registerCleanup) {
  const timer = createPhaseTimer();
  const port = await getEphemeralPort();
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "fusion-boot-smoke-home-"));
  const isolatedProject = mkdtempSync(path.join(tmpdir(), "fusion-boot-smoke-project-"));
  let stderrBuf = "";
  // FNXC:BackendFlip 2026-06-26-14:55:
  // Force the smoke to exercise the embedded PostgreSQL backend. Unset
  // DATABASE_URL so a developer's external DB connection never leaks in
  // (the smoke must prove the zero-config embedded path boots). Unset
  // FUSION_NO_EMBEDDED_PG so the smoke cannot be opted out by an
  // inherited env var — the embedded default is what the gate must prove.
  const childEnv = createChildEnv(process.env, isolatedHome);

  registerCleanup(() => {
    removeTempDir(isolatedHome);
    removeTempDir(isolatedProject);
  });

  // Both preflight commands must settle, but neither consumes the other's state.
  // Keep init's isolated HOME for serve; only their process startup overlaps.
  const preflightRuns = await runPreflightPhasePlan(
    createBootSmokePhasePlan({ attempt }),
    (phase) => {
      if (phase.name === "help") {
        return timer.measure(phase.name, () => runCli("fn --help", ["--help"], { timeout: 30_000 }));
      }
      return timer.measure(phase.name, () => runCli("fn init", ["init", "--name", "boot-smoke", "--path", isolatedProject], {
        cwd: isolatedProject,
        env: childEnv,
        timeout: HEALTH_TIMEOUT_MS,
      }));
    },
  );
  const { help, init } = preflightRuns;
  if (help.error || help.status !== 0) {
    fail(`\`fn --help\` exited ${help.status ?? `signal ${help.signal ?? "timeout"}`}`, `${help.error?.message ? `${help.error.message}\n` : ""}${help.stderr ?? ""}`);
  }
  if (!/serve/i.test(help.stdout ?? "")) {
    fail("`fn --help` output does not mention the serve command", help.stderr ?? "");
  }
  console.log("boot-smoke: `fn --help` OK");

  const initOutput = `${init.stdout ?? ""}${init.stderr ?? ""}`;
  const initFailure = classifyInitFailure(init, existsSync(path.join(isolatedProject, ".fusion", "project.json")));
  if (initFailure) {
    const message = initFailure === "missing-project-marker"
      ? "`fn init` did not write .fusion/project.json"
      : `\`fn init\` exited ${init.status ?? `signal ${init.signal ?? "timeout"}`}`;
    fail(message, `${init.error?.message ? `${init.error.message}\n` : ""}${initOutput}`);
  }
  console.log("boot-smoke: `fn init` OK");

  const child = spawn(
    process.execPath,
    [
      cliBin,
      "serve",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      // FNXC:BootSmoke 2026-06-19-12:36: The boot smoke verifies HTTP startup, not autonomous task execution. Run against an isolated throwaway project and use --paused so a developer worktree with an in-progress task or missing task-local artifacts cannot make the merge gate fail before /api/health serves.
      "--paused",
    ],
    {
      cwd: isolatedProject,
      env: childEnv,
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
    removeTempDir(isolatedHome);
    removeTempDir(isolatedProject);
  });

  const exitedEarly = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await timer.measure("serve-to-health-200", () => Promise.race([
      pollHealth(port, Date.now() + HEALTH_TIMEOUT_MS),
      exitedEarly.then(({ code, signal }) => {
        throw new Error(`server exited before becoming healthy (${code ?? `signal ${signal}`})`);
      }),
    ]));
  } catch (err) {
    if (/EADDRINUSE/.test(stderrBuf) && attempt < BOOT_ATTEMPTS) {
      console.log(`boot-smoke: port :${port} lost to another process (EADDRINUSE), retrying with a fresh port (attempt ${attempt}/${BOOT_ATTEMPTS})`);
      await exitedEarly; // child is already dead or dying; wait so cleanup is race-free
      removeTempDir(isolatedHome);
      removeTempDir(isolatedProject);
      timer.report(attempt);
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
  const { code, signal } = await timer.measure("sigterm-to-exit", () => Promise.race([
    exitedEarly,
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: null, signal: "timeout" }), SHUTDOWN_TIMEOUT_MS),
    ),
  ]));
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
  timer.report(attempt);
  return "ok";
}

// FNXC:BootSmoke 2026-07-07-00:00: Guard the top-level boot so importing this
// module (e.g. from the regression test to reach `removeTempDir`) never spawns
// a real server; only a direct `node scripts/boot-smoke.mjs` invocation runs it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => fail(err.message ?? String(err)));
}
