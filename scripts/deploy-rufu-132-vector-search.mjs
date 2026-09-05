#!/usr/bin/env node
/*
FNXC:StashVectorSearch 2026-08-21-06:55 (RUFU-132) — OPERATOR handoff: enable Stash vector recall.

RUFU-132 brings the Stash semantic-search rollout to production. Steps 0–6 (branch merge,
image rebuild with the mcp<2.0 boot fix, redeploy, embedder verification, corpus backfill,
endpoint + recall verification) are COMPLETE; this script is the last operator-gated step:
it persists the Fusion project setting `stashVectorSearch: true` on the live :4040 store
and verifies it read back.

WHY THIS IS HANDED OFF TO THE OPERATOR: the agent session is privilege-fenced from the
embedded PostgreSQL store (deploy boundary, see MEMORY.md). The write goes through the
same `store.updateSettings` seam the dashboard's PUT /settings uses, so the live engine
picks the flag up on the next memory resolution — no restart.

USAGE (run from a terminal as the operator):
  node scripts/deploy-rufu-132-vector-search.mjs           # enable stashVectorSearch
  node scripts/deploy-rufu-132-vector-search.mjs --off     # ROLLBACK: disable it (keyword baseline resumes)
  node scripts/deploy-rufu-132-vector-search.mjs --check   # read-only: print current value + stash endpoint state

STEPS:
  1. Stash endpoint precheck (read-only): /api/v1/me/sessions/events/semantic-search present
     in the live OpenAPI (:3456) and 401-gated (auth required, route not missing).
  2. Stash corpus coverage (best-effort, read-only psql): embedded/total history_events.
     Non-fatal when psql is unavailable.
  3. Settings write: open the project TaskStore (backend mode) and updateSettings({ stashVectorSearch }).
  4. Read-back verification: getSettings().stashVectorSearch must equal the requested value.
*/

import { execFileSync } from "node:child_process";
import process from "node:process";

const REPO = "/home/schindler/git/Fusion";
const ARGS = new Set(process.argv.slice(2));
const DO_CHECK = ARGS.has("--check");
const DO_OFF = ARGS.has("--off");
const TARGET = DO_OFF ? false : true;

const log = (...a) => console.log("▶", ...a);
const ok = (...a) => console.log("✓", ...a);
const warn = (...a) => console.warn("!", ...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

function stashOpenapiHasSemanticRoute() {
  try {
    const raw = execFileSync("curl", ["-sf", "--max-time", "5", "http://127.0.0.1:3456/openapi.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const paths = Object.keys(JSON.parse(raw).paths ?? {});
    return paths.includes("/api/v1/me/sessions/events/semantic-search");
  } catch {
    return false;
  }
}

function stashSemanticRouteAuthGated() {
  // Unauthenticated probe: report the real HTTP status. 401 = route exists behind auth (expected);
  // 404 = route missing; 2xx = unexpected (auth bypass). curl without -f exits 0 for any status,
  // so the code must be read from -w output, never from the exit status.
  try {
    return execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "http://127.0.0.1:3457/api/v1/me/sessions/events/semantic-search?q=probe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unreachable";
  }
}

function stashCorpusCoverage() {
  try {
    const out = execFileSync("psql", ["postgresql://stash@127.0.0.1:5432/stash", "-tA", "-c", "SELECT count(embedding) || '/' || count(*) FROM history_events;"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function main() {
  log(`target: stashVectorSearch = ${TARGET}${DO_CHECK ? " (--check, read-only)" : ""}`);

  const hasRoute = stashOpenapiHasSemanticRoute();
  if (hasRoute) ok("stash OpenAPI (:3456) lists /api/v1/me/sessions/events/semantic-search");
  else warn("stash OpenAPI does NOT list the semantic-search route — vector recall will fall back to keyword on every multi-word query (negative-capability cache)");

  const probe = stashSemanticRouteAuthGated();
  if (probe === "401" || probe === "403") ok(`unauthenticated probe via frontend proxy (:3457): HTTP ${probe} (route exists, auth-gated)`);
  else if (probe === "404") warn(`unauthenticated probe: HTTP 404 — the running image lacks the semantic-search route`);
  else warn(`unauthenticated probe: HTTP ${probe} (expected 401-gated or 404)`);

  const coverage = stashCorpusCoverage();
  if (coverage) ok(`stash history_events embedded coverage: ${coverage}`);
  else warn("stash corpus coverage check skipped (psql to stash-postgres unavailable — non-fatal)");

  const { openBackend } = await import("./lib/backend-db.mjs");
  const backend = await openBackend(REPO);
  const { store, shutdown } = backend;
  try {
    const before = (await store.getSettings()).stashVectorSearch;
    log(`current project setting stashVectorSearch = ${String(before)}`);

    if (DO_CHECK || before === TARGET) {
      ok(`no write needed (already ${String(TARGET)})`);
    } else {
      await store.updateSettings({ stashVectorSearch: TARGET });
      ok(`wrote stashVectorSearch = ${TARGET}`);
    }

    const after = (await store.getSettings()).stashVectorSearch;
    if (DO_CHECK) {
      console.log(`\n--check: current stashVectorSearch = ${String(after)} (no write performed)`);
      return;
    }
    if (after === TARGET) {
      ok(`read-back verified: stashVectorSearch = ${TARGET}`);
      if (TARGET) {
        console.log("\nStash vector recall is ENABLED for multi-word (>=2 token) queries; single-word queries stay on the keyword path.");
        console.log("The live engine picks the flag up on the next memory resolution (no restart).");
        console.log("Rollback: node scripts/deploy-rufu-132-vector-search.mjs --off");
      } else {
        console.log("\nStash vector recall is DISABLED — the keyword baseline is active again.");
      }
    } else {
      fail(`read-back mismatch: expected ${TARGET}, got ${String(after)}`);
    }
  } finally {
    await shutdown();
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
