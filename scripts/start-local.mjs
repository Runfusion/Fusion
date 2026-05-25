#!/usr/bin/env node
/**
 * One-command local startup for Fusion development.
 *
 * Defaults are intentionally conservative:
 * - localhost only
 * - first free port at/above 4050
 * - dashboard/API without the AI engine unless --engine is passed
 * - no bearer-token auth on localhost
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const HELP = `
Fusion local startup

Usage:
  pnpm local [options]

Options:
  --engine            Start the full AI engine. Default: dashboard/API only.
  --paused            Start with automation paused.
  --port <port>       Preferred port. Default: 4050. Port 4040 is reserved.
  --host <host>       Host to bind. Default: 127.0.0.1.
  --auth              Keep bearer-token auth enabled on localhost.
  --no-auth           Disable auth even for a non-localhost host.
  --prebuild <mode>   Startup prebuild: client, none, or full. Default: client.
  --skip-install      Do not auto-run pnpm install when node_modules is missing.
  --skip-register     Do not auto-register this repo in Fusion's project registry.
  --allow-4040        Allow using reserved dashboard port 4040.
  --dry-run           Print what would run without starting the server.
  --help              Show this help.
`.trim();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function info(message) {
  console.log(`▶ ${message}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function warn(message) {
  console.warn(`! ${message}`);
}

function parseArgs(argv) {
  const opts = {
    engine: false,
    paused: false,
    port: 4050,
    host: "127.0.0.1",
    auth: false,
    noAuth: false,
    prebuild: "client",
    skipInstall: false,
    skipRegister: false,
    allow4040: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    switch (arg) {
      case "--engine":
        opts.engine = true;
        break;
      case "--no-engine":
        opts.engine = false;
        break;
      case "--paused":
        opts.paused = true;
        break;
      case "--port": {
        const value = argv[++i];
        if (!value) fail("Missing value for --port");
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(`Invalid port: ${value}`);
        }
        opts.port = port;
        break;
      }
      case "--host": {
        const value = argv[++i];
        if (!value) fail("Missing value for --host");
        opts.host = value;
        break;
      }
      case "--auth":
        opts.auth = true;
        break;
      case "--no-auth":
        opts.noAuth = true;
        break;
      case "--prebuild": {
        const value = argv[++i];
        if (!["none", "client", "full"].includes(value)) {
          fail("Invalid --prebuild value. Expected one of: none, client, full.");
        }
        opts.prebuild = value;
        break;
      }
      case "--skip-install":
        opts.skipInstall = true;
        break;
      case "--skip-register":
        opts.skipRegister = true;
        break;
      case "--allow-4040":
        opts.allow4040 = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    fail(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }

  return result.stdout?.trim() ?? "";
}

function ensureRepoRoot() {
  if (!existsSync(resolve(repoRoot, "pnpm-workspace.yaml")) || !existsSync(resolve(repoRoot, "packages/cli/src/bin.ts"))) {
    fail(`Could not find the Fusion repo root at ${repoRoot}`);
  }
  process.chdir(repoRoot);
}

function ensureNodeVersion() {
  const [majorRaw, minorRaw] = process.versions.node.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  if (major < 22 || (major === 22 && minor < 5)) {
    fail(`Node.js >= 22.5.0 is required. Current version: ${process.versions.node}`);
  }
}

function ensureDependencies(opts) {
  if (existsSync(resolve(repoRoot, "node_modules"))) {
    ok("Dependencies already installed");
    return;
  }

  if (opts.skipInstall) {
    fail("node_modules is missing. Run pnpm install --frozen-lockfile first.");
  }

  info("Installing dependencies with pnpm install --frozen-lockfile");
  run(pnpm, ["install", "--frozen-lockfile"]);
}

function projectNameFromPackage() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const raw = typeof pkg.name === "string" && pkg.name ? pkg.name : "Fusion";
    return raw.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "Fusion";
  } catch {
    return "Fusion";
  }
}

function ensureProjectInitialized() {
  if (existsSync(resolve(repoRoot, ".fusion/fusion.db"))) {
    ok("Project database exists");
    return;
  }

  const name = projectNameFromPackage();
  info(`Initializing Fusion project as ${name}`);
  run(pnpm, ["exec", "tsx", "packages/cli/src/bin.ts", "init", "--name", name]);
}

function ensureProjectRegistered(opts) {
  if (opts.skipRegister) {
    warn("Skipping project registry check");
    return;
  }

  info("Checking Fusion project registry");
  const rootLiteral = JSON.stringify(repoRoot);
  const nameLiteral = JSON.stringify(projectNameFromPackage());
  const helper = `
    import { CentralCore } from "./packages/core/src/central-core.ts";
    import { readProjectIdentity, writeProjectIdentity } from "./packages/core/src/db.ts";
    import { ensureMemoryFileWithBackend } from "./packages/core/src/project-memory.ts";

    async function main() {
      const root = ${rootLiteral};
      const requestedName = ${nameLiteral};
      const sanitize = (value) => String(value)
        .replace(/^@[^/]+\\//, "")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 64) || "Fusion";

      const central = new CentralCore();
      await central.init();
      try {
        const existingByPath = await central.getProjectByPath(root);
        if (existingByPath) {
          if (existingByPath.status !== "active") {
            await central.updateProject(existingByPath.id, { status: "active" });
            console.log("Activated registered project " + existingByPath.name);
          } else {
            console.log("Project already registered as " + existingByPath.name);
          }
          return;
        }

        const projects = await central.listProjects();
        const usedNames = new Set(projects.map((project) => project.name));
        const baseName = sanitize(requestedName);
        let name = baseName;
        let suffix = 2;
        while (usedNames.has(name)) {
          const suffixText = "-" + suffix++;
          name = baseName.slice(0, 64 - suffixText.length) + suffixText;
        }

        const identity = readProjectIdentity(root);
        const ensured = await central.ensureProjectForPath({
          path: root,
          identity: identity ? { id: identity.id, createdAt: identity.createdAt } : undefined,
          name,
        });
        const project = ensured.project;
        await central.updateProject(project.id, { status: "active" });
        try {
          writeProjectIdentity(root, {
            id: project.id,
            createdAt: project.createdAt,
            firstSeenPath: root,
          });
        } catch {
          // best effort
        }
        await ensureMemoryFileWithBackend(root).catch(() => false);
        if (ensured.outcome === "reattached") {
          console.log("[start-local] Reattached project " + project.id + " at " + root + " using stored identity");
        } else {
          console.log("Registered project " + name);
        }
      } finally {
        await central.close();
      }
    }

    main().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  `;

  run(pnpm, ["exec", "tsx", "--eval", helper]);
}

function canListen(port, host) {
  return new Promise((resolveResult) => {
    const server = net.createServer();
    server.once("error", () => resolveResult(false));
    server.once("listening", () => {
      server.close(() => resolveResult(true));
    });
    server.listen(port, host);
  });
}

async function pickPort(preferredPort, host, allow4040) {
  if (preferredPort === 4040 && !allow4040) {
    warn("Port 4040 is reserved for live dashboard sessions; using 4050 instead");
    preferredPort = 4050;
  }

  for (let port = preferredPort; port < preferredPort + 50 && port <= 65535; port++) {
    if (port === 4040 && !allow4040) continue;
    if (await canListen(port, host)) return port;
  }

  fail(`No free port found from ${preferredPort} to ${Math.min(preferredPort + 49, 65535)} on ${host}`);
}

function shouldDisableAuth(opts) {
  if (opts.noAuth) return true;
  if (opts.auth) return false;
  return opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1";
}

function printSummary(opts, port, dashboardArgs) {
  const mode = opts.engine ? "dashboard + AI engine" : "dashboard/API only";
  const auth = dashboardArgs.includes("--no-auth") ? "disabled" : "enabled";
  const prebuild = opts.prebuild === "client"
    ? "dashboard client only"
    : opts.prebuild === "full"
      ? "full workspace"
      : "skipped";
  console.log();
  ok(`Starting ${mode}`);
  console.log(`  URL:  http://${opts.host === "127.0.0.1" ? "localhost" : opts.host}:${port}`);
  console.log(`  Host: ${opts.host}`);
  console.log(`  Auth: ${auth}`);
  console.log(`  Prebuild: ${prebuild}`);
  console.log(`  Cmd:  node scripts/dev-with-memory.mjs --prebuild=${opts.prebuild} ${dashboardArgs.join(" ")}`);
  console.log();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  ensureRepoRoot();
  ensureNodeVersion();
  ensureDependencies(opts);
  ensureProjectInitialized();
  ensureProjectRegistered(opts);

  const port = await pickPort(opts.port, opts.host, opts.allow4040);
  if (port !== opts.port && !(opts.port === 4040 && !opts.allow4040)) {
    warn(`Port ${opts.port} unavailable; using ${port}`);
  }

  const dashboardArgs = ["dashboard", "--host", opts.host, "--port", String(port)];
  if (!opts.engine) dashboardArgs.push("--dev");
  if (opts.paused) dashboardArgs.push("--paused");
  if (shouldDisableAuth(opts)) dashboardArgs.push("--no-auth");

  if (opts.host === "0.0.0.0" && dashboardArgs.includes("--no-auth")) {
    warn("Auth is disabled while binding to 0.0.0.0. Only do this on a trusted network.");
  }

  printSummary(opts, port, dashboardArgs);

  if (opts.dryRun) {
    return;
  }

  const child = spawn(process.execPath, ["scripts/dev-with-memory.mjs", ...dashboardArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, FUSION_DEV_PREBUILD: opts.prebuild },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
