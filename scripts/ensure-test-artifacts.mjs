#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_BUILD_PACKAGES = [
  { name: "@fusion/core", requiredArtifacts: ["packages/core/dist/index.js"] },
  { name: "@fusion/dashboard", requiredArtifacts: ["packages/dashboard/dist/index.js"] },
  { name: "@fusion/plugin-sdk", requiredArtifacts: ["packages/plugin-sdk/dist/index.js"] },
  {
    name: "@fusion-plugin-examples/hermes-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-hermes-runtime/dist/index.js",
      "plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js",
    ],
  },
  {
    name: "@fusion-plugin-examples/openclaw-runtime",
    requiredArtifacts: [
      "plugins/fusion-plugin-openclaw-runtime/dist/index.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/pi-module.js",
      "plugins/fusion-plugin-openclaw-runtime/dist/probe.js",
    ],
  },
  { name: "@fusion-plugin-examples/paperclip-runtime", requiredArtifacts: ["plugins/fusion-plugin-paperclip-runtime/dist/index.js"] },
];

export function detectMissingArtifacts(rootDir = process.cwd(), existsFn = existsSync) {
  return REQUIRED_BUILD_PACKAGES.filter((pkg) =>
    pkg.requiredArtifacts.some((artifactPath) => !existsFn(path.join(rootDir, artifactPath))),
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function ensureTestArtifacts(rootDir = process.cwd(), runFn = run, existsFn = existsSync) {
  const missing = detectMissingArtifacts(rootDir, existsFn);
  if (missing.length === 0) return [];

  const names = missing.map((pkg) => pkg.name);
  console.log(`[test-bootstrap] building missing dist artifacts: ${names.join(", ")}`);
  runFn("pnpm", [...names.flatMap((name) => ["--filter", name]), "build"], rootDir);
  return names;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestArtifacts();
}
