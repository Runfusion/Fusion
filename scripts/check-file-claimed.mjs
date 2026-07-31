#!/usr/bin/env node
/*
FNXC:FleetCoordination 2026-08-01-06:10 (fleet):

WHY THIS EXISTS. Every fleet worker pushes as the SAME GitHub account, so `gh pr list --author "@me"`
returns all 17 open PRs and no worker can tell their own from a teammate's. There is no way to ask "is
this file already being converted?" short of fetching every open PR's file list by hand — 25+ API calls
that a worker will not make before starting, and I did not make either.

MEASURED COST, not a hypothetical: four of my PRs were superseded by teammates landing the same work
first (#3096, #3116, #3140 shrank to tests; #3125 to nothing and was closed). In every case both
implementations were correct and independently reached the same design. The fleet is not making
mistakes — it is doing correct work twice, and finding coverage gaps only by accident when the rebases
collide.

WHAT THIS DOES. One command, one answer:

    node scripts/check-file-claimed.mjs packages/engine/src/self-healing.ts

It prints the open PRs touching that path, so "claimed?" is answerable before the work starts rather
than at rebase time.

WHAT IT DOES NOT DO, deliberately. It cannot see work that is in progress and unpushed, so it narrows
the window rather than closing it. Closing it needs distinguishable authorship — a per-worker
`Co-Authored-By` or a title prefix — which is a coordination decision, not a script. This is the part
that can be fixed from inside the repo.
*/
import { execFileSync } from "node:child_process";

const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (targets.length === 0) {
  console.error("usage: node scripts/check-file-claimed.mjs <path> [<path>...]");
  console.error("       paths are matched as substrings of each PR's changed-file list");
  process.exit(2);
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error(`claim-check: gh failed — ${err?.message ?? err}`);
    console.error("claim-check: cannot prove a file is unclaimed without it. Treat as UNKNOWN, not free.");
    process.exit(2);
  }
}

const open = JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title"]));
const hits = new Map(targets.map((t) => [t, []]));

for (const pr of open) {
  let files;
  try {
    files = gh(["pr", "diff", String(pr.number), "--name-only"]).split("\n").filter(Boolean);
  } catch {
    continue;
  }
  for (const t of targets) {
    if (files.some((f) => f.includes(t))) hits.get(t).push(pr);
  }
}

let claimed = false;
for (const t of targets) {
  const prs = hits.get(t);
  if (prs.length === 0) {
    console.log(`UNCLAIMED  ${t}`);
    continue;
  }
  claimed = true;
  console.log(`CLAIMED    ${t}`);
  for (const pr of prs) console.log(`             #${pr.number}  ${pr.title}`);
}

/* Exit 1 when anything is claimed, so a worker can gate on it: `... && start-work`. */
process.exit(claimed ? 1 : 0);
