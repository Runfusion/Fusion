#!/usr/bin/env node

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(packageDir, "dist", "bin.js");

try {
  await access(distEntry, constants.F_OK);
} catch {
  globalThis.console.error(
    `Fusion CLI build output is missing at ${distEntry}. Run \`pnpm build\` before invoking this source checkout.`,
  );
  globalThis.process.exit(1);
}

/*
 * FNXC:CliAwaitLiveness 2026-08-11-09:17:
 * Retain top-level await so an unsettled CLI completion remains Node's loud,
 * non-zero diagnostic rather than a silent partial success. FN-8954 fixes the
 * awaited QMD child liveness at its source; this shim must not force exit 0,
 * which would truncate `serve`, `dashboard`, or `daemon` as well.
 */
await import(pathToFileURL(distEntry).href);
