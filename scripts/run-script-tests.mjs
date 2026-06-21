#!/usr/bin/env node

import { globSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

/*
FNXC:TestInfrastructure 2026-06-21-10:00:
Script-test verification must honor forwarded file arguments so targeted checks stay fast inside Fusion tasks.
The old package script always expanded scripts/__tests__/*.test.mjs before forwarded args, turning `pnpm test:scripts -- scripts/__tests__/x.test.mjs` into the full script suite and making task completion look stalled.
*/

const forwarded = process.argv.slice(2).filter((arg) => arg !== "--");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testFiles = forwarded.length > 0
  ? forwarded.map((file) => resolve(repoRoot, file))
  : globSync("scripts/__tests__/*.test.mjs", { cwd: repoRoot }).sort().map((file) => resolve(repoRoot, file));

if (testFiles.length === 0) {
  console.error("[run-script-tests] no script test files matched");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: repoRoot,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
