/*
FNXC:FnxcStampHygiene 2026-07-30-23:55:

FNXC STAMPS DATED IN THE FUTURE, FROZEN AT TODAY'S POPULATION.

AGENTS.md requires every FNXC comment to carry a `yyyy-MM-dd-hh:mm` stamp, and nothing checks it. The
only feedback loop is a reviewer noticing, and on 2026-07-30 alone reviewers caught FOUR future-dated
stamps across separate PRs (#2843, #2852, #2856, #2892). Every one was hand-written with nothing to
verify against.

A stamp dated after the change was written is not cosmetic. These comments are the project's record of
WHY code exists, and the census, the solutions docs and several review conventions read them
chronologically — "recorded 2026-07-31" next to a 2026-07-30 commit makes the ordering wrong for
exactly the reader the comment is for.

WHY A BASELINE RATCHET AND NOT A HARD FAIL. 84 source files already carry a future stamp, the furthest
nearly three months out. A gate that fails on all of them is unmergeable and would be turned off, and
mass-editing 84 files to satisfy a new check is churn nobody asked for. So the population is frozen:
a NEW future-dated stamp fails, an existing one does not, and a count that DROPS also fails so a fixed
file cannot leave a slot the surface silently regrows into. Same shape as the SQL column-literal gate.

WHY "FUTURE" AND NOT "MATCHES THE COMMIT DATE". A stamp legitimately predates its commit — work
written Monday and landed Wednesday is normal and correct. Only a date that has not happened yet is
unambiguously wrong, so that is the whole rule; it catches every case a reviewer has caught so far
without inventing a stricter one nobody follows.
*/
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["packages", "scripts", "docs"];
const BASELINE = join(REPO, "scripts", "lib", "fnxc-future-dates-baseline.json");
/* Build output and vendored bundles are generated; their stamps are copies of the source ones. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".gate-bundle", "coverage", "build", ".next"]);
const STAMP = /FNXC:[A-Za-z0-9_]+\s+(\d{4}-\d{2}-\d{2})/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|mjs|md)$/.test(full)) yield full;
  }
}

/** Today in the repo's local calendar; a stamp for TODAY is fine, tomorrow is not. */
const today = new Date().toISOString().slice(0, 10);

function scan() {
  const counts = {};
  for (const root of ROOTS) {
    let base;
    try { base = statSync(join(REPO, root)); } catch { continue; }
    if (!base.isDirectory()) continue;
    for (const file of walk(join(REPO, root))) {
      const source = readFileSync(file, "utf8");
      STAMP.lastIndex = 0;
      let hits = 0;
      for (const match of source.matchAll(STAMP)) if (match[1] > today) hits += 1;
      if (hits > 0) counts[relative(REPO, file).split("\\").join("/")] = hits;
    }
  }
  return counts;
}

const found = scan();

if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  console.log(`[check-fnxc-future-dates] baseline written: ${total} stamp(s) in ${Object.keys(found).length} file(s)`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error("[check-fnxc-future-dates] missing baseline; run with --update-baseline");
  process.exit(1);
}

const problems = [];
for (const [file, count] of Object.entries(found)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) problems.push(`  ${file}: ${count} future-dated FNXC stamp(s), baseline allows ${allowed}`);
}
/* A DROP fails too: a corrected file must not leave a slot the surface can regrow into. */
for (const [file, allowed] of Object.entries(baseline)) {
  const count = found[file] ?? 0;
  if (count < allowed) problems.push(`  ${file}: ${count} now, baseline still allows ${allowed} — re-record it (--update-baseline)`);
}

if (problems.length > 0) {
  console.error("\n[check-fnxc-future-dates] future-dated FNXC stamp population changed:\n");
  for (const line of problems.sort()) console.error(line);
  console.error(
    `\nA stamp dated after today (${today}) records the change as happening in the future, which makes\n`
    + "the FNXC record — the project's why-does-this-exist trail — read out of order.\n"
    + "Use the current date. If a count went DOWN, re-record the baseline in the same commit.\n",
  );
  process.exit(1);
}

const total = Object.values(found).reduce((a, b) => a + b, 0);
console.log(`[check-fnxc-future-dates] ${total} known future-dated stamp(s), none added.`);
