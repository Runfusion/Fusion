#!/usr/bin/env node

import { cpSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const VERSION = "15.18.0-beta.17";
const MARKER = ".fusion-pg-test-native.json";
const OWNER_MARKER = "fusion-pg-test-server.json";
const DEFAULT_URL = "postgresql://localhost:5432";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const RESERVED_PORTS = new Set((process.env.FUSION_RESERVED_PORTS ?? "4040").split(",").map(Number));
const rootDir = dirname(fileURLToPath(import.meta.url));

/*
FNXC:PgTestProvisioning 2026-08-22-16:49:
FN-152 stages the pinned embedded-postgres payload before starting it, following
materializeEmbeddedPostgresRuntimeBinaries() in embedded-lifecycle.ts. A postmaster
computes $libdir from its executable, so a worktree payload can disappear underneath it.
*/
export function isEphemeralNativeRoot(path) {
  return !isAbsolute(path) || /(^|[\\/])\.worktrees([\\/]|$)|(^|[\\/])worktrees([\\/]|$)/.test(path);
}

export function stagedRootFor({ home, version = VERSION, platform, arch }) {
  return join(home, "native", `${version}-${platform}-${arch}`);
}

export function parseArgs(argv) {
  const out = { command: "up", port: undefined, replace: false, purge: false, json: false, help: false };
  const args = [...argv].filter((arg) => arg !== "--");
  if (["up", "status", "down"].includes(args[0])) out.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === "--port") { const value = args.shift(); if (!value || !/^\d+$/.test(value)) throw new Error("--port requires an integer"); out.port = Number(value); }
    else if (arg === "--replace") out.replace = true;
    else if (arg === "--purge") out.purge = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function platformPackage(platform, arch) {
  if (platform !== "linux" || !["arm64", "x64"].includes(arch)) return null;
  return `@embedded-postgres/${platform}-${arch}`;
}

export function resolveNativeRootCandidates({ platform = process.platform, arch = process.arch, requireResolve, env = process.env }) {
  const candidates = [];
  if (env.FUSION_PG_TEST_NATIVE_ROOT) candidates.push(resolve(env.FUSION_PG_TEST_NATIVE_ROOT));
  const pkg = platformPackage(platform, arch);
  if (!pkg) return candidates;
  try { candidates.push(join(dirname(requireResolve(pkg)), "..", "native")); } catch { /* pnpm may hide optional platform packages from direct resolution. */ }
  // pnpm's platform dependency is reachable through the embedded-postgres virtual store, not normal resolution.
  const scanRoots = [process.cwd(), dirname(process.cwd()), env.FUSION_PG_TEST_MAIN_CHECKOUT].filter(Boolean);
  for (const scanRoot of scanRoots) {
    const store = join(scanRoot, "node_modules", ".pnpm");
    try {
      const prefix = pkg.replace("/", "+") + "@";
      const entry = readdirSync(store).find((name) => name.startsWith(prefix));
      if (entry) candidates.push(join(store, entry, "node_modules", ...pkg.split("/"), "native"));
    } catch { /* Continue to the next optional pnpm store location. */ }
  }
  return [...new Set(candidates)].filter((candidate) => existsSync(join(candidate, "bin", "postgres")));
}

function resolveNativeRoot(opts = {}) {
  const requireResolve = createRequire(join(process.cwd(), "package.json")).resolve;
  const candidates = resolveNativeRootCandidates({ requireResolve, ...opts });
  const durable = candidates.find((candidate) => !isEphemeralNativeRoot(candidate));
  return { source: durable ?? candidates[0] ?? null, candidates };
}

export function deriveIdentityForUrl({ url, env = process.env, osUsername = userInfo().username }) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const role = decodeURIComponent(parsed.username || "") || env.PGUSERNAME || env.PGUSER || osUsername;
  const password = decodeURIComponent(parsed.password || "") || env.PGPASSWORD || "";
  const pathDatabase = parsed.pathname === "/" ? "" : parsed.pathname.slice(1);
  return { role, password, database: pathDatabase || env.PGDATABASE || role };
}

export function resolveTarget({ argv = {}, env = process.env, osUsername = userInfo().username }) {
  let url;
  try { url = new URL(env.FUSION_PG_TEST_URL_BASE ?? DEFAULT_URL); } catch { return { refusal: "malformed-url", message: "FUSION_PG_TEST_URL_BASE must be a valid PostgreSQL URL." }; }
  const envPort = url.port ? Number(url.port) : Number(env.PGPORT || 5432);
  const host = url.hostname || env.PGHOST || "localhost";
  const port = argv.port ?? envPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { refusal: "invalid-port", message: "--port must be an integer in 1024..65535." };
  if (argv.port && env.FUSION_PG_TEST_URL_BASE && url.port && argv.port !== Number(url.port)) return { refusal: "port-conflict", message: `--port ${argv.port} conflicts with URL port ${url.port}. export FUSION_PG_TEST_URL_BASE=${url.toString()}` };
  if (!LOCAL_HOSTS.has(host)) return { refusal: "non-local-host", message: `Cannot provision remote host ${host}.` };
  // port-4040-allowlist: this is a refusal guard, not a process-management operation.
  if (RESERVED_PORTS.has(port)) return { refusal: "reserved-port", message: `Port ${port} is reserved and cannot host test PostgreSQL.` };
  const probeHost = url.hostname || "localhost";
  const probePort = url.port ? Number(url.port) : 5432;
  if ((!url.port && env.PGPORT && Number(env.PGPORT) !== probePort) || (!url.hostname && env.PGHOST && env.PGHOST !== probeHost)) return { refusal: "env-target-divergence", message: `PGHOST/PGPORT diverge from harness probe ${probeHost}:${probePort}; export FUSION_PG_TEST_URL_BASE=postgresql://${host}:${port}` };
  const identity = deriveIdentityForUrl({ url, env, osUsername });
  const bareUrl = new URL(`postgresql://${host}:${port}`);
  const bareIdentity = deriveIdentityForUrl({ url: bareUrl, env, osUsername });
  const warnings = [];
  if (url.pathname !== "") warnings.push({ code: "harness-url-concat", message: `Harnesses concatenate \${PG_TEST_URL_BASE}/\${dbName} at 24 sites; use export FUSION_PG_TEST_URL_BASE=postgresql://${host}:${port}` });
  return { host, port, urlBase: url.toString(), role: identity.role, password: identity.password, database: identity.database, bareIdentity, warnings };
}

export function classifyProbeGating({ probeUrl, env = process.env, osUsername, ownership, roleCfg, databaseCfg, probeDb }) {
  const identity = deriveIdentityForUrl({ url: probeUrl, env, osUsername });
  const allowedUser = identity.role === roleCfg || (ownership === "script-owned" && identity.role === "postgres");
  const allowedDatabase = [databaseCfg, "postgres", probeDb].filter(Boolean).includes(identity.database);
  return allowedUser && allowedDatabase ? "gating" : "diagnostic";
}

function defectFor(result) {
  if (result?.ok) return null;
  const code = result?.code ?? result?.error?.code;
  const message = result?.message ?? result?.error?.message ?? "";
  if (code === "ECONNREFUSED") return "unreachable";
  if (result?.notPostgres) return "not-postgres";
  if (code === "58P01" && message.includes("$libdir/plpgsql")) return "missing-plpgsql";
  if (code === "28000") return "missing-login-role";
  if (code === "3D000") return "missing-database";
  if (result?.kind === "admin-ddl") return "admin-ddl-denied";
  return "admin-ddl-denied";
}

export function classifyClusterHealth(results = []) {
  const gating = results.filter((result) => result.gating !== false);
  const notes = results.filter((result) => result.gating === false);
  const defects = gating.map(defectFor).filter(Boolean);
  const order = ["unreachable", "not-postgres", "missing-plpgsql", "missing-login-role", "missing-database", "admin-ddl-denied"];
  return { status: order.find((status) => defects.includes(status)) ?? "healthy", defects: [...new Set(defects)], notes };
}

export function classifyOwnership(facts = {}) {
  if (facts.notPostgres || facts.executableIsPostgres === false) return "not-postgres";
  if (facts.pidAlive === false) return "stale-pid";
  if (!facts.dataDir) return "foreign-unprovable";
  if (facts.runtimeDataDir && resolve(facts.dataDir) === resolve(facts.runtimeDataDir)) return "runtime-app-cluster";
  if (facts.ownerMatches === false) return "foreign-other-user";
  if (facts.serverHome && facts.markerMatches && resolve(facts.dataDir).startsWith(resolve(facts.serverHome) + "/")) return "script-owned";
  return "foreign-proven";
}

export function planReplacement({ ownership, health, replaceRequested }) {
  if (health.status === "healthy") return "reuse";
  const identityOnly = ["missing-login-role", "missing-database"].includes(health.status) && !health.defects.includes("missing-plpgsql");
  if (["runtime-app-cluster", "foreign-other-user", "not-postgres"].includes(ownership)) return "refuse-never-touch";
  if (ownership === "foreign-unprovable") return "refuse-unprovable";
  if (ownership === "script-owned" && identityOnly) return "repair-identity-in-place";
  if (ownership !== "script-owned" && identityOnly) return "refuse-foreign-identity-missing";
  if (!replaceRequested) return "refuse-needs-replace";
  return ownership === "foreign-proven" ? "stop-then-provision" : "provision-fresh";
}

export function describeRemediation(status, ctx = {}) {
  const command = status === "missing-plpgsql" ? "pnpm pg:test:up -- --replace" : "pnpm pg:test:up";
  if (status === "missing-login-role" || status === "missing-database") {
    if (ctx.ownership?.startsWith("foreign")) return `${command}\nCREATE ROLE "${ctx.role}" WITH SUPERUSER LOGIN${ctx.password ? ` PASSWORD '${ctx.password.replace(/'/g, "''")}'` : ""};\nCREATE DATABASE "${ctx.database}" OWNER "${ctx.role}";`;
    return `${command}; PostgreSQL also needs the configured database.`;
  }
  return `${command}`;
}

function serverHome(env) { return env.FUSION_PG_TEST_SERVER_HOME || join(homedir(), ".fusion", "pg-test-server"); }
function clusterRoot(target, env) { return join(serverHome(env), "clusters", `${VERSION}-${process.platform}-${process.arch}-${target.port}`); }
function ownerMarker(dataDir) { return join(dirname(dataDir), OWNER_MARKER); }
function markerMatches(dataDir, home) { try { const marker = JSON.parse(readFileSync(ownerMarker(dataDir), "utf8")); return marker.dataDir === dataDir && marker.owner === "fusion-pg-test-server" && resolve(dataDir).startsWith(resolve(home) + "/"); } catch { return false; } }
function run(bin, args, options = {}) { const result = spawnSync(bin, args, { encoding: "utf8", stdio: "pipe", ...options }); if (result.status !== 0) throw new Error(`${basename(bin)} failed: ${result.stderr || result.stdout}`); return result; }
function stageNative(source, target) {
  const marker = join(target, MARKER); const expected = JSON.stringify({ source: resolve(source), version: VERSION });
  if (existsSync(marker) && readFileSync(marker, "utf8") === expected && existsSync(join(target, "bin", "postgres"))) return target;
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) cpSync(join(source, entry), join(target, entry), { recursive: true, force: true, verbatimSymlinks: true });
  for (const entry of readdirSync(join(target, "bin"))) chmodSync(join(target, "bin", entry), 0o755);
  writeFileSync(marker, expected); return target;
}
function postgresClient() {
  const loaded = createRequire(join(process.cwd(), "packages/core/package.json"))("postgres");
  return loaded.default ?? loaded;
}
async function probe(target, ownership = "foreign-proven", { includeDdl = true } = {}) {
  const postgres = postgresClient(); const results = [];
  const configured = new URL(target.urlBase);
  const maintenance = new URL(target.urlBase); maintenance.pathname = "/postgres";
  const probeDb = `fusion_pg_test_probe_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const gatingFor = (url) => classifyProbeGating({ probeUrl: url, env: process.env, osUsername: userInfo().username, ownership, roleCfg: target.role, databaseCfg: target.database, probeDb }) === "gating";
  const execute = async (kind, url, sql, extra = {}) => {
    const client = postgres(url.toString(), { max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
    try { await client.unsafe(sql); results.push({ kind, gating: gatingFor(url), ok: true, ...extra }); }
    catch (error) { results.push({ kind, gating: gatingFor(url), ok: false, code: error?.code, message: error?.message, ...extra }); }
    finally { await client.end({ timeout: 2 }).catch(() => {}); }
  };
  await execute("configured", configured, "SELECT 1");
  await execute("plpgsql", configured, "DO $$ BEGIN PERFORM 1; END $$;");
  await execute("maintenance", maintenance, "SELECT 1");
  await execute("bare", new URL(`postgresql://${target.host}:${target.port}`), "SELECT 1");
  await execute("ci", new URL(`postgresql://postgres:postgres@${target.host}:${target.port}`), "SELECT 1");

  if (includeDdl) {
    // FNXC:PgTestProvisioning 2026-08-22-17:07: FN-152 requires the same create/drop capability the harness uses, and cleanup must run even when creation or dropping fails.
    const ddl = postgres(maintenance.toString(), { max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
    const ddlGating = gatingFor(maintenance);
    let ddlCreated = false;
    try {
      await ddl.unsafe(`CREATE DATABASE ${quote(probeDb)}`);
      ddlCreated = true;
      results.push({ kind: "admin-ddl", gating: ddlGating, ok: true });
    } catch (error) {
      results.push({ kind: "admin-ddl", gating: ddlGating, ok: false, code: error?.code, message: error?.message });
    } finally {
      // FNXC:PgTestProvisioning 2026-08-22-17:07: Keep the scratch database alive through the concat probe; otherwise FN-152 would only prove cleanup, not harness URL readiness.
      if (ddlCreated) {
        const concatUrl = new URL(`${target.urlBase}/${probeDb}`);
        const concatGating = target.warnings.some((warning) => warning.code === "harness-url-concat") ? false : gatingFor(concatUrl);
        const concat = postgres(concatUrl.toString(), { max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
        try { await concat.unsafe("SELECT 1"); results.push({ kind: "harness-concat", gating: concatGating, ok: true }); }
        catch (error) { results.push({ kind: "harness-concat", gating: concatGating, ok: false, code: error?.code, message: error?.message, warningEvidence: !concatGating }); }
        finally { await concat.end({ timeout: 2 }).catch(() => {}); }
        try { await ddl.unsafe(`DROP DATABASE ${quote(probeDb)}`); }
        catch (error) { results.push({ kind: "admin-ddl", gating: ddlGating, ok: false, code: error?.code, message: error?.message }); }
      }
      await ddl.end({ timeout: 2 }).catch(() => {});
    }
  }

  // A configured-role failure must not hide the independent PL/pgSQL diagnosis.
  if (results.some((result) => result.kind === "configured" && !result.ok)) {
    const fallback = postgres(`postgresql://postgres:postgres@${target.host}:${target.port}/postgres`, { max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
    try { await fallback.unsafe("DO $$ BEGIN PERFORM 1; END $$;"); results.push({ kind: "fallback-plpgsql", gating: true, ok: true }); }
    catch (error) { results.push({ kind: "fallback-plpgsql", gating: true, ok: false, code: error?.code, message: error?.message }); }
    finally { await fallback.end({ timeout: 2 }).catch(() => {}); }
  }
  return classifyClusterHealth(results);
}

async function inspectServer(target, home) {
  const postgres = postgresClient();
  for (const url of [target.urlBase, `postgresql://postgres:postgres@${target.host}:${target.port}/postgres`]) {
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 3, onnotice: () => {} });
    try {
      const rows = await client.unsafe("SELECT current_setting('data_directory') AS data_directory, current_setting('port') AS port");
      const dataDir = rows[0]?.data_directory;
      const pidLines = dataDir ? readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n") : [];
      const pid = Number(pidLines[0]); const pidPort = Number(pidLines[3]);
      let pidAlive = Number.isFinite(pid) && pid > 0;
      let ownerMatches = false;
      let executableIsPostgres = false;
      let executablePath = null;
      if (pidAlive) {
        try {
          process.kill(pid, 0);
          ownerMatches = typeof process.getuid !== "function" || statSync(`/proc/${pid}`).uid === process.getuid();
          executablePath = readlinkSync(`/proc/${pid}/exe`);
          executableIsPostgres = basename(executablePath.replace(/ \(deleted\)$/, "")) === "postgres";
        } catch { pidAlive = false; }
      }
      return { dataDir, reportedPort: Number(rows[0]?.port), pid, pidPort, pidAlive, ownerMatches, executableIsPostgres, executablePath, serverHome: home, markerMatches: dataDir ? markerMatches(dataDir, home) : false, runtimeDataDir: join(homedir(), ".fusion", "embedded-postgres", "default") };
    } catch { /* Try the diagnostic admin identity before declaring ownership unprovable. */ } finally { await client.end({ timeout: 2 }).catch(() => {}); }
  }
  return { dataDir: null, serverHome: home };
}
async function provisionIdentity(target) {
  const postgres = postgresClient(); const maintenance = new URL(`postgresql://postgres@${target.host}:${target.port}/postgres`);
  const client = postgres(maintenance.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const roleExists = await client.unsafe("SELECT 1 FROM pg_roles WHERE rolname = $1", [target.role]);
    if (!roleExists.length) await client.unsafe(`CREATE ROLE ${quote(target.role)} WITH SUPERUSER LOGIN${target.password ? ` PASSWORD ${quoteLiteral(target.password)}` : ""}`);
    else if (target.password) await client.unsafe(`ALTER ROLE ${quote(target.role)} PASSWORD ${quoteLiteral(target.password)}`);
    const dbExists = await client.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [target.database]);
    if (!dbExists.length) await client.unsafe(`CREATE DATABASE ${quote(target.database)} OWNER ${quote(target.role)}`);
  } finally { await client.end({ timeout: 2 }).catch(() => {}); }
}
function quote(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function quoteLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function print(value, json) { console.log(json ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2)); }
function help() { console.log("Usage: pnpm pg:test:up [-- --port N|--replace|--json]\n       pnpm pg:test:status [-- --port N|--json]\n       pnpm pg:test:down [-- --purge|--port N]\nUse the same FUSION_PG_TEST_URL_BASE for up, status, and down."); }

async function main() {
  const args = parseArgs(process.argv.slice(2)); if (args.help) return help();
  if (["darwin", "win32"].includes(process.platform)) throw new Error(`Unsupported platform ${process.platform}; set FUSION_PG_TEST_URL_BASE to a manually provisioned server.`);
  const target = resolveTarget({ argv: args }); if (target.refusal) throw new Error(`${target.refusal}: ${target.message}`);
  const home = serverHome(process.env); const dataDir = join(clusterRoot(target, process.env), "data");
  let health; try { health = await probe(target, markerMatches(dataDir, home) ? "script-owned" : "foreign-proven", { includeDdl: args.command === "up" }); } catch { health = { status: "unreachable", defects: ["unreachable"], notes: [] }; }
  if (args.command === "status") { print({ target, health }, args.json); if (health.status !== "healthy") process.exitCode = 1; return; }
  if (args.command === "down") {
    if (!markerMatches(dataDir, home)) throw new Error("Refusing to stop foreign PostgreSQL cluster.");
    const staged = stagedRootFor({ home, version: VERSION, platform: process.platform, arch: process.arch }); run(join(staged, "bin", "pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"]);
    if (args.purge) rmSync(dirname(dataDir), { recursive: true, force: true }); return;
  }
  const facts = health.status === "unreachable" ? { dataDir: null, serverHome: home } : await inspectServer(target, home);
  let ownership = classifyOwnership(facts);
  if (facts.dataDir && facts.pidPort && (facts.pidPort !== target.port || facts.reportedPort !== target.port)) ownership = "foreign-unprovable";
  let plan = planReplacement({ ownership, health, replaceRequested: args.replace });
  if (health.status === "unreachable") plan = "provision-fresh";
  if (plan === "reuse") { print({ status: "healthy", target, health, export: `export FUSION_PG_TEST_URL_BASE=${target.urlBase}` }, args.json); return; }
  if (plan === "refuse-foreign-identity-missing" || plan.startsWith("refuse")) throw new Error(`${plan}: ${describeRemediation(health.status, { ownership, ...target })}`);
  const { source } = resolveNativeRoot(); if (!source) throw new Error("No embedded PostgreSQL payload found. Install dependencies or set FUSION_PG_TEST_NATIVE_ROOT.");
  const staged = stageNative(source, stagedRootFor({ home, version: VERSION, platform: process.platform, arch: process.arch }));
  if (plan === "stop-then-provision") {
    if (!facts.dataDir || !facts.pidAlive || !facts.ownerMatches || !facts.executableIsPostgres || facts.pidPort !== target.port || facts.reportedPort !== target.port) throw new Error("Replacement ownership proof chain failed; refusing to signal PostgreSQL.");
    console.log(`Reclaiming broken PostgreSQL PID ${facts.pid} at ${facts.dataDir} (${facts.executablePath}).`);
    try { run(join(staged, "bin", "pg_ctl"), ["-D", facts.dataDir, "-m", "fast", "stop"]); }
    catch { process.kill(facts.pid, "SIGINT"); }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { await new Promise((done) => setTimeout(done, 250)); const next = await probe(target, ownership, { includeDdl: false }); if (next.status === "unreachable") break; }
    const stopped = await probe(target, ownership, { includeDdl: false });
    if (stopped.status !== "unreachable") { process.kill(facts.pid, "SIGQUIT"); await new Promise((done) => setTimeout(done, 1_000)); }
    const final = await probe(target, ownership, { includeDdl: false });
    if (final.status !== "unreachable") throw new Error("PostgreSQL did not stop after bounded graceful shutdown; refusing replacement.");
    ownership = "script-owned";
  }
  const initialized = existsSync(join(dataDir, "PG_VERSION"));
  if (!initialized) {
    mkdirSync(dataDir, { recursive: true }); const passwordFile = join(dirname(dataDir), `.pw-${process.pid}`); writeFileSync(passwordFile, "postgres\n", { mode: 0o600 });
    try { run(join(staged, "bin", "initdb"), ["-D", dataDir, "-U", "postgres", `--pwfile=${passwordFile}`, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]); }
    finally { rmSync(passwordFile, { force: true }); }
  }
  if (!initialized || health.status === "unreachable") {
    run(join(staged, "bin", "pg_ctl"), ["-D", dataDir, "-l", join(dirname(dataDir), "postgres.log"), "-o", `-p ${target.port} -c listen_addresses=localhost`, "start"]);
  }
  if (!existsSync(ownerMarker(dataDir))) {
    writeFileSync(ownerMarker(dataDir), JSON.stringify({ owner: "fusion-pg-test-server", version: VERSION, platform: process.platform, arch: process.arch, port: target.port, dataDir, role: target.role, database: target.database, createdAt: new Date().toISOString() }, null, 2));
  }
  await provisionIdentity(target); health = await probe(target, "script-owned");
  if (health.status !== "healthy") throw new Error(`Provisioned server failed health checks: ${health.status}; ${describeRemediation(health.status, { ownership: "script-owned", ...target })}`);
  print({ status: target.warnings.length ? "provisioned-with-warnings" : "healthy", target, health, export: `export FUSION_PG_TEST_URL_BASE=${target.urlBase}` }, args.json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
