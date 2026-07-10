#!/usr/bin/env node
/**
 * FNXC:ProjectMemory 2026-07-08-00:00:
 * Symptom-verification fixture for FN-7707. Invokes an AWAITED qmd project-memory
 * search (QmdMemoryBackend.search -> searchWithQmd) against whatever `qmd` resolves
 * on PATH. Prints a "started" marker BEFORE awaiting so the test can tell the
 * fixture actually reached the search call. Prints a "searched" marker AFTER the
 * await settles — but that marker is best-effort only: once searchWithQmd routes
 * through the unref'd default executor, a fixture process with nothing else to do
 * can legitimately exit before a still-hanging qmd child's promise ever settles, so
 * the test must not require "searched" to prove the fix. If the qmd child + its
 * stdio pipes are not unref'd, this process instead stays alive for the child's
 * full runtime (its pending await only settles once the child truly exits), well
 * past the strict exit-bound the test asserts. Loaded via `tsx` so it can import
 * the real TypeScript source directly (no separate build step required).
 */
import { QmdMemoryBackend } from "../../memory-backend.ts";

const rootDir = process.argv[2];
if (!rootDir) {
  throw new Error("qmd-search-fixture: missing rootDir argument");
}

console.log("qmd-search-fixture:started");

const backend = new QmdMemoryBackend();
await backend.search(rootDir, { query: "fn-7707-fixture-query", limit: 5 });

// Best-effort marker — see file header. Not required by the test.
console.log("qmd-search-fixture:searched");
