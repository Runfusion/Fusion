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
/*
FNXC:FnxcStampHygiene 2026-07-31-03:40 (#2941 review): HYPHENS ARE PART OF THE REQUIRED FORM.
AGENTS.md specifies `FNXC:Area-of-product`, and the first matcher accepted only `[A-Za-z0-9_]+` — so
every hyphenated area, i.e. the documented spelling, was skipped entirely. The gate was blind to the
shape the rule actually prescribes, which is the worst possible subset to miss.
*/
const STAMP = /FNXC:[A-Za-z0-9_-]+\s+(\d{4}-\d{2}-\d{2})/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    /* `.js`/`.cjs` too: FNXC comments live in plain-JS scripts as well, and omitting them let a
       future-dated stamp land unseen in exactly the files this repo writes tooling in. */
    /*
    FNXC:FnxcStampHygiene 2026-07-30-00:00 (#2953 follow-up): EVERY FILE TYPE THAT CARRIES A STAMP.
    The filter listed the types stamps were EXPECTED in, not the ones they OCCUR in, so the gate was
    blind wherever the convention had spread on its own. `.sql` was the costly omission: migrations
    carry a stamp recording when a schema change landed, they are the files where a wrong date
    misleads most, and one of them held a stamp dated nearly three months out. `.css` had drifted
    furthest by volume (1023 stamps across 123 files, from the dashboard CSS split). A gate whose
    coverage is a guess about where authors write comments will always trail the authors.
    */
    else if (/\.(tsx?|m?js|cjs|md|sql|css|html|ya?ml|json|sh)$/.test(full)) yield full;
  }
}

/*
Today in the repo's LOCAL calendar; a stamp for today is fine, tomorrow is not.

FNXC:FnxcStampHygiene 2026-07-31-03:40 (#2941 review): `toISOString()` is UTC, so for anyone west of
Greenwich it rolls the date forward for part of each day — a stamp written correctly at 5pm in
California read as "tomorrow" and failed the gate. Authors write the local date, so the comparison
has to use the local one.
*/
const now = new Date();
const today = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");

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

/*
FNXC:FnxcStampHygiene 2026-07-31-03:45 (#2941 review): VALIDATE THE SHAPE, not just the JSON.

The first version caught only a parse error, so `null`, an array, or a negative/NaN count reached the
comparison and either crashed with a stack trace or — worse — compared as `undefined` and silently
allowed everything. A ratchet whose baseline can be quietly neutered by a bad edit is not a ratchet.
*/
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error("[check-fnxc-future-dates] missing or malformed baseline; run with --update-baseline");
  process.exit(1);
}
if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
  console.error("[check-fnxc-future-dates] baseline must be a JSON object of file -> count");
  process.exit(1);
}
for (const [file, count] of Object.entries(baseline)) {
  /*
  FNXC:FnxcStampHygiene 2026-07-30-23:55 (#2941 review): SAFE integer, not just integer.

  `Number.isInteger(9007199254740992)` is true, but that value is past 2^53-1 where JavaScript stops
  distinguishing adjacent integers — so it compares greater than any count this scanner can produce and
  silently disables the ratchet for that file. A validator whose purpose is "this baseline cannot be
  neutered by a bad edit" has to reject the value that neuters it most completely.
  */
  if (!Number.isSafeInteger(count) || count < 0) {
    console.error(`[check-fnxc-future-dates] baseline entry "${file}" must be a non-negative safe integer, got ${JSON.stringify(count)}`);
    process.exit(1);
  }
}

const problems = [];
for (const [file, count] of Object.entries(found)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) problems.push(`  ${file}: ${count} future-dated FNXC stamp(s), baseline allows ${allowed}`);
}
/*
FNXC:FnxcStampHygiene 2026-07-30-23:20 (#2941 CI red — a ratchet whose own measurement moves with the
clock): A DROP TIGHTENS, IT DOES NOT FAIL.

I copied the drop-fails rule from the SQL ratchet without noticing that this population is not stable
the way that one is. "Is this stamp in the future" is answered against TODAY, so every date boundary
the runner crosses converts some future stamps into past ones and the count falls ON ITS OWN — no code
change involved. With drop-fails that guarantees a red gate on some later day, and it fired within
hours: the baseline was recorded at 2026-07-30 local while CI runs in UTC, already 2026-07-31.

Both sibling ratchets reached the same conclusion for the ordinary reason (the drop is rarely the
failing author's to fix). Here it is stronger still: nobody CAUSED the drop, so there is no author to
fix it. The ceiling follows the count down, says what it lowered, and exits 0; the RISE check — the
actual purpose, "no NEW future-dated stamp" — is untouched and still fails hard.

The rewritten baseline must be committed to take effect; in CI the write is discarded with the runner,
which is why the gate goes green rather than silently banking a stale allowance.
*/
const tightened = [];
for (const [file, allowed] of Object.entries(baseline)) {
  const count = found[file] ?? 0;
  if (count < allowed) tightened.push(`  ${file}: ${allowed} -> ${count}`);
}
if (tightened.length > 0) {
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = found[file] ?? 0;
    if (count < allowed) { if (count === 0) delete baseline[file]; else baseline[file] = count; }
  }
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[check-fnxc-future-dates] baseline TIGHTENED for ${tightened.length} file(s):`);
  for (const line of tightened.sort()) console.log(line);
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
