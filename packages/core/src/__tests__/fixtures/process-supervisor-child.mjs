#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "keepalive";
const pidFile = process.argv[3];
const extraFile = process.argv[4];

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf8");
}

if (mode === "exit-immediately") {
  process.exit(0);
}

if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
}

if (mode === "spawn-child") {
  const selfPath = fileURLToPath(import.meta.url);
  const grandchild = spawn(process.execPath, [selfPath, "keepalive", extraFile].filter(Boolean), {
    stdio: "ignore",
  });
  grandchild.unref();
}

setInterval(() => {}, 1_000);
