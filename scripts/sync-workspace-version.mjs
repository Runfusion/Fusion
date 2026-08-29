#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPackagePath = "package.json";
const cliPackagePath = "packages/cli/package.json";

const rootPackage = readJson(rootPackagePath);
const cliPackage = readJson(cliPackagePath);

if (typeof cliPackage.version !== "string" || cliPackage.version.length === 0) {
  throw new Error(`Missing version in ${cliPackagePath}`);
}

if (rootPackage.version === cliPackage.version) {
  process.exit(0);
}

rootPackage.version = cliPackage.version;
writeFileSync(rootPackagePath, JSON.stringify(rootPackage, null, 2) + "\n");
console.log(`Synced workspace version to ${cliPackage.version}`);
