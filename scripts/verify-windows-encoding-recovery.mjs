// FNXC:PostgresEmbedded 2026-07-18-01:10:
// End-to-end proof of the issue #2286 auto-recovery. Simulates a machine hit
// by the old bug: creates a real embedded cluster with a non-UTF-8 server
// encoding (initdb --encoding=WIN1252, the runner's own OS-locale outcome
// pre-fix) under a throwaway HOME, then boots the full `fn serve` against it.
// The startup factory must detect the encoding-conversion failure, prove the
// cluster is empty, delete and re-initdb it as UTF-8, and reach a healthy
// /api/health — with no operator intervention.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliBin = join(repoRoot, "packages", "cli", "bin.mjs");
const PORT = 55497;
const HEALTH_TIMEOUT_MS = 240_000;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

const home = mkdtempSync(join(tmpdir(), "fusion-encoding-recovery-home-"));
const project = mkdtempSync(join(tmpdir(), "fusion-encoding-recovery-project-"));
const dataDir = join(home, ".fusion", "embedded-postgres", "default");
mkdirSync(dirname(dataDir), { recursive: true });

// Build the bad cluster with the REAL lifecycle: caller initdb flags are
// appended after the UTF-8 defaults and initdb takes the last occurrence, so
// this recreates exactly what pre-fix initdb produced on a WIN1252 locale.
const { EmbeddedPostgresLifecycle } = await import(
  pathToFileURL(join(repoRoot, "packages", "core", "dist", "postgres", "embedded-lifecycle.js")).href
);
const seed = new EmbeddedPostgresLifecycle({
  dataDir,
  database: "fusion",
  user: "postgres",
  password: "password",
  port: PORT,
  initdbFlags: ["--encoding=WIN1252", "--locale=C"],
  onLog: (m) => console.log(`[seed] ${m}`),
  onError: (e) => console.error(`[seed:err] ${String(e)}`),
});
await seed.start();
await seed.stop();
console.log(`recovery-verify: seeded non-UTF-8 cluster at ${dataDir}`);

let output = "";
const child = spawn(
  process.execPath,
  [cliBin, "serve", "--port", String(PORT), "--host", "127.0.0.1", "--paused"],
  {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FUSION_SKIP_ONBOARDING: "1",
      DATABASE_URL: undefined,
      FUSION_NO_EMBEDDED_PG: undefined,
      PORT: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
let exited = false;
child.once("exit", () => (exited = true));

async function pollHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`serve exited before becoming healthy.\n${output.slice(-4000)}`);
    try {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: controller.signal });
      clearTimeout(abortTimer);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`serve did not become healthy in ${HEALTH_TIMEOUT_MS}ms.\n${output.slice(-4000)}`);
}

let failed = false;
try {
  await pollHealth();
  console.log(`recovery-verify: /api/health OK on :${PORT} after auto-recovery`);
  if (!/Re-initializing it as UTF-8 and retrying once/.test(output)) {
    throw new Error(
      `serve became healthy but the auto-recovery log line is missing — the seed cluster may not have triggered the #2286 path.\n${output.slice(-4000)}`,
    );
  }
  console.log("recovery-verify: auto-recovery log line confirmed");
} catch (err) {
  console.error(`recovery-verify: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  failed = true;
} finally {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    const pid = parseInt(readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n")[0], 10);
    if (Number.isFinite(pid) && pid > 0) sh("taskkill", ["/pid", String(pid), "/f", "/t"]);
  } catch {
    // no postmaster left
  }
  for (const dir of [home, project]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupErr) {
      console.error(`recovery-verify: cleanup warning: ${String(cleanupErr)}`);
    }
  }
}

if (failed) process.exit(1);
console.log("recovery-verify: PASS — non-UTF-8 cluster auto-recovered to a healthy boot");
