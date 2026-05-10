/* global process, URL, console */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const mode = process.argv[2];
const packageJsonPath = new URL("../package.json", import.meta.url);
const backupPath = new URL("../package.json.pack-backup", import.meta.url);

if (mode === "prepack") {
  if (existsSync(backupPath)) {
    // Clean up stale backup from interrupted runs.
    unlinkSync(backupPath);
  }

  const original = readFileSync(packageJsonPath, "utf8");
  writeFileSync(backupPath, original, "utf8");

  const pkg = JSON.parse(original);
  const devDependencies = { ...(pkg.devDependencies || {}) };
  delete devDependencies["@fusion/core"];
  delete devDependencies["@fusion/dashboard"];
  delete devDependencies["@fusion/engine"];
  delete devDependencies["@fusion/pi-claude-cli"];
  delete devDependencies["@fusion/pi-llama-cpp"];
  delete devDependencies["@fusion-plugin-examples/roadmap"];

  pkg.devDependencies = devDependencies;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  process.exit(0);
}

if (mode === "postpack") {
  if (!existsSync(backupPath)) {
    process.exit(0);
  }

  const backup = readFileSync(backupPath, "utf8");
  writeFileSync(packageJsonPath, backup, "utf8");
  unlinkSync(backupPath);
  process.exit(0);
}

console.error("Usage: node ./scripts/prepare-publish-manifest.mjs <prepack|postpack>");
process.exit(1);
