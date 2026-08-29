/*
FNXC:DesktopEmbeddedPostgres 2026-07-14-18:50:
Packaged Electron loads @fusion/core + embedded-postgres as ESM after app.asar is mounted.
Platform package entrypoints resolve native binaries via import.meta.url to
`.../app.asar/.../native/bin/postgres`, and spawn against that path fails with ENOTDIR.
CJS mutation of child_process.spawn must run BEFORE any ESM importer binds spawn.
This bootstrap is the package main: patch builtins, then dynamically import the ESM main.

FNXC:DesktopEmbeddedPostgres 2026-07-15-03:11:
After CJS reassignment of child_process.spawn / fs.promises.stat|chmod, already-resolved
ESM named imports keep the pre-patch functions until module.syncBuiltinESMExports() runs.
Call it after every CJS mutation so the subsequent dynamic import of main.js (and any
ESM embedded-postgres import) observes the rewritten paths.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const fsp = require("fs/promises");
const { syncBuiltinESMExports } = require("module");

const BIN_NAMES = new Set([
  "postgres",
  "initdb",
  "pg_ctl",
  "postgres.exe",
  "initdb.exe",
  "pg_ctl.exe",
]);

function runtimeBinRoot() {
  return path.join(os.homedir(), ".fusion", "embedded-postgres", "runtime-bin", `${process.platform}-${process.arch}`);
}

function resolveAsarUnpacked(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  const base = path.basename(filePath);
  if (BIN_NAMES.has(base) && filePath.includes(`${path.sep}app.asar`)) {
    const materialized = path.join(runtimeBinRoot(), "bin", base);
    if (fs.existsSync(materialized)) return materialized;
  }
  if (filePath.includes(`${path.sep}app.asar.unpacked${path.sep}`)) return filePath;
  const marker = `${path.sep}app.asar${path.sep}`;
  const index = filePath.indexOf(marker);
  if (index === -1) return filePath;
  const unpacked =
    filePath.slice(0, index) +
    `${path.sep}app.asar.unpacked${path.sep}` +
    filePath.slice(index + marker.length);
  return fs.existsSync(unpacked) ? unpacked : filePath;
}

function installSpawnPatch() {
  const originalSpawn = cp.spawn.bind(cp);
  cp.spawn = function patchedSpawn(command, ...rest) {
    const fixed = typeof command === "string" ? resolveAsarUnpacked(command) : command;
    return originalSpawn(fixed, ...rest);
  };

  const originalStat = fsp.stat.bind(fsp);
  fsp.stat = function patchedStat(p, ...rest) {
    const fixed = typeof p === "string" ? resolveAsarUnpacked(p) : p;
    return originalStat(fixed, ...rest);
  };

  const originalChmod = fsp.chmod.bind(fsp);
  fsp.chmod = function patchedChmod(p, ...rest) {
    const fixed = typeof p === "string" ? resolveAsarUnpacked(p) : p;
    return originalChmod(fixed, ...rest);
  };

  // Propagate CJS mutations to ESM named exports before main.js loads.
  syncBuiltinESMExports();
}

installSpawnPatch();

// Load the ESM Electron main after builtins are patched.
const { pathToFileURL } = require("url");
import(pathToFileURL(path.join(__dirname, "main.js")).href).catch((err) => {
  console.error("[desktop/bootstrap] failed to load main.js", err);
  process.exit(1);
});
