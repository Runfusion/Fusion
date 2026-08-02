#!/usr/bin/env node
/*
FNXC:FleetCoordination 2026-07-31-06:10 (fleet):

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

const PR_LIMIT = 300;
const PR_FILE_PAGE_SIZE = 100;
const PR_FILE_API_CEILING = 3000;

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function unknown(message) {
  console.error(`claim-check: ${message}`);
  console.error("claim-check: cannot prove a file is unclaimed from incomplete data. Treat as UNKNOWN, not free.");
  for (const target of targets) console.log(`UNKNOWN    ${target}`);
  process.exit(2);
}

function readOpenPullRequests() {
  let output;
  try {
    output = gh(["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,title,changedFiles"]);
  } catch (error) {
    unknown(`gh failed while listing open PRs — ${error?.message ?? error}`);
  }

  try {
    const open = JSON.parse(output);
    if (!Array.isArray(open)) throw new TypeError("expected an array");
    if (open.length >= PR_LIMIT) unknown(`${open.length} open PRs hit the --limit ${PR_LIMIT} cap, so the list may be truncated.`);
    return open;
  } catch (error) {
    unknown(`open PR list was malformed — ${error?.message ?? error}`);
  }
}

/*
FNXC:FleetClaims 2026-08-01-16:09:
GitHub refuses PR diffs over 300 files, but its pull-request-files API exposes a paginated list up to
its documented 3,000-file ceiling. Reconcile every validated filename record with the authoritative
`changedFiles` count before using a PR as claim evidence; missing, malformed, failed, mismatched, or
above-ceiling data stays UNKNOWN. Evaluate every PR before deciding so incomplete data always outranks
a known claim and workers never treat a partial scan as permission to overlap.
*/
function filesForPullRequest(pr) {
  if (!Number.isInteger(pr?.number) || !Number.isInteger(pr?.changedFiles) || pr.changedFiles < 0) {
    return { complete: false, reason: `PR #${pr?.number ?? "unknown"} has no valid changed-file count` };
  }
  if (pr.changedFiles > PR_FILE_API_CEILING) {
    return { complete: false, reason: `PR #${pr.number} changes ${pr.changedFiles} files, above the ${PR_FILE_API_CEILING}-file API ceiling` };
  }

  const files = [];
  const pageCount = Math.ceil(pr.changedFiles / PR_FILE_PAGE_SIZE);
  for (let page = 1; page <= pageCount; page += 1) {
    let output;
    try {
      output = gh([
        "api",
        `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=${PR_FILE_PAGE_SIZE}&page=${page}`,
      ]);
    } catch (error) {
      return { complete: false, reason: `PR #${pr.number} files API failed on page ${page} — ${error?.message ?? error}` };
    }

    try {
      const records = JSON.parse(output);
      if (!Array.isArray(records) || records.some((record) => typeof record?.filename !== "string" || record.filename.length === 0)) {
        throw new TypeError("expected an array of filename records");
      }
      files.push(...records.map((record) => record.filename));
    } catch (error) {
      return { complete: false, reason: `PR #${pr.number} files API returned malformed page ${page} — ${error?.message ?? error}` };
    }
  }

  if (files.length !== pr.changedFiles) {
    return { complete: false, reason: `PR #${pr.number} returned ${files.length} files but reports ${pr.changedFiles}` };
  }
  return { complete: true, files };
}

const open = readOpenPullRequests();
const hits = new Map(targets.map((target) => [target, []]));
const incomplete = [];

for (const pr of open) {
  const result = filesForPullRequest(pr);
  if (!result.complete) {
    incomplete.push(result.reason);
    continue;
  }
  for (const target of targets) {
    if (result.files.some((file) => file.includes(target))) hits.get(target).push(pr);
  }
}

if (incomplete.length > 0) unknown(incomplete.join("; "));

let claimed = false;
for (const target of targets) {
  const prs = hits.get(target);
  if (prs.length === 0) {
    console.log(`UNCLAIMED  ${target}`);
    continue;
  }
  claimed = true;
  console.log(`CLAIMED    ${target}`);
  for (const pr of prs) console.log(`             #${pr.number}  ${pr.title}`);
}

/* Exit 1 when anything is claimed, so a worker can gate on it: `... && start-work`. */
process.exit(claimed ? 1 : 0);
