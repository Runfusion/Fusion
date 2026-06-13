#!/usr/bin/env node
/* global console, process */

import { spawn } from "node:child_process";

import { runWithWatchdog } from "../../../scripts/lib/run-vitest-watchdog.mjs";

const rawArgs = process.argv.slice(2);
const heapArg = rawArgs.find((arg) => arg.startsWith("--heap="));
const heapMb = heapArg?.slice("--heap=".length) || "6144";
const vitestArgs = rawArgs.filter((arg) => !arg.startsWith("--heap="));

if (vitestArgs.length === 0) {
  console.error("Usage: node scripts/run-vitest-with-heap.mjs [--heap=6144] <vitest args...>");
  process.exit(1);
}

const nodeOptions = [`--max-old-space-size=${heapMb}`, process.env.NODE_OPTIONS || ""]
  .join(" ")
  .trim();
// Clamp to the default on a missing/malformed value. A bad env value must never
// produce NaN — the watchdog only arms when budgetMs is finite and > 0, so a
// NaN here would silently disable the killer and bring back the very hang this
// wrapper exists to prevent.
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(`[dashboard-vitest] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

const timeoutMs = positiveIntEnv("FUSION_RUN_VITEST_TIMEOUT_MS", 900000);
const graceMs = positiveIntEnv("FUSION_RUN_VITEST_KILL_GRACE_MS", 5000);

function resolveSpawnCommand() {
  const override = process.env.FUSION_RUN_VITEST_SPAWN_OVERRIDE;
  if (!override) {
    return { command: "pnpm", args: ["exec", "vitest", ...vitestArgs] };
  }

  const parsedOverride = JSON.parse(override);
  if (
    !parsedOverride ||
    typeof parsedOverride.command !== "string" ||
    parsedOverride.command.length === 0 ||
    !Array.isArray(parsedOverride.args) ||
    parsedOverride.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(
      "FUSION_RUN_VITEST_SPAWN_OVERRIDE must be valid JSON with string command and string[] args",
    );
  }

  // Test seam for process-lifecycle coverage without launching real vitest.
  return { command: parsedOverride.command, args: parsedOverride.args };
}

const { command, args } = resolveSpawnCommand();
const label = vitestArgs.join(" ");

// Dashboard lanes keep their historical fixed budget (default 15min) rather than
// the timings-derived bands the shard/changed runners use — heap pressure, not
// duration, is what wedges a lane, so a flat generous budget is correct here.
runWithWatchdog({
  command,
  args,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  budgetMs: timeoutMs,
  graceMs,
  label,
  log: console.error,
  spawn,
})
  .then(({ code, signal, timedOut }) => {
    if (signal) {
      // Re-raise the child's terminating signal so the wrapper exits the same way.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? (timedOut ? 124 : 1));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
