#!/usr/bin/env node
/**
 * Runs the Fusion dashboard API server AND `vite dev` concurrently so the
 * React SPA in packages/dashboard/app hot-reloads while still talking to a
 * live API/WebSocket backend.
 *
 * Two processes:
 *   1. API:  `pnpm dev dashboard --no-auth --port <API_PORT>`
 *            (handles the full build, typecheck, engine, etc.)
 *   2. Vite: `vite dev` in packages/dashboard
 *            (serves app/ with HMR; proxies /api and WS to the API)
 *
 * Open the URL Vite prints (e.g. http://localhost:5173), NOT the API URL.
 * Edits to packages/dashboard/app/** hot-reload. Edits to src/** (server
 * code) still require restarting this script.
 *
 * Env:
 *   FUSION_API_PORT   API port (default 4040). Vite's proxy reads the same
 *                     var so both sides stay in sync.
 *   FUSION_VITE_PORT  Vite dev port (default 5173).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dashboardDir = resolve(repoRoot, "packages/dashboard");

const API_PORT = process.env.FUSION_API_PORT ?? "4040";
const VITE_PORT = process.env.FUSION_VITE_PORT ?? "5173";

const children = [];
let shuttingDown = false;

function prefix(label, color) {
  const tag = `\x1b[${color}m[${label}]\x1b[0m`;
  return (chunk) => {
    const text = chunk.toString();
    // Preserve trailing-newline semantics; prefix every non-empty line.
    const lines = text.split("\n");
    const last = lines.pop();
    const prefixed = lines.map((l) => `${tag} ${l}`).join("\n");
    process.stdout.write(prefixed + (prefixed ? "\n" : "") + (last ? `${tag} ${last}` : ""));
  };
}

function launch(name, color, command, args, options) {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
    ...options,
  });
  child.stdout.on("data", prefix(name, color));
  child.stderr.on("data", prefix(name, color));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`\n[dev-hmr] ${name} exited (code=${code} signal=${signal}) — tearing down`);
    shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      try { child.kill("SIGINT"); } catch {}
    }
  }
  // Hard kill after 5s if anyone is still alive.
  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    process.exit(exitCode);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[dev-hmr] starting API on :${API_PORT} + vite on :${VITE_PORT}`);
console.log(`[dev-hmr] open http://localhost:${VITE_PORT} for HMR (not the API URL)`);

// API: green. Runs the existing memory-aware dev entry so the engine, build,
// and typecheck all happen exactly as they do for `pnpm dev dashboard`.
launch(
  "api",
  "32",
  "pnpm",
  ["dev", "dashboard", "--no-auth", "--port", API_PORT, "--host", "127.0.0.1"],
  { cwd: repoRoot, env: { ...process.env, FUSION_API_PORT: API_PORT } },
);

// Vite: cyan. Starts once; proxies /api (including WS) to the API port.
launch(
  "vite",
  "36",
  "pnpm",
  ["exec", "vite", "dev", "--port", VITE_PORT],
  { cwd: dashboardDir, env: { ...process.env, FUSION_API_PORT: API_PORT } },
);
