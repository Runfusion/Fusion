import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openBackend } from "./lib/backend-db.mjs";

export function composeTransitionEvidence({
  mergeRetries,
  branchTip,
  mainSHAs,
  lastMergeError,
  resolutionTaskId,
  postState,
}) {
  const mergeRetriesLine =
    typeof mergeRetries === "number" ? String(mergeRetries) : "not captured at the time";

  const mainLandingLines = mainSHAs
    .map(
      ({ sha, title, ancestorStatus, ancestorOutput }) =>
        `- \`${sha}\` — ${title}\n  - verify: \`git merge-base --is-ancestor ${sha} origin/main\` => exit ${ancestorStatus}${ancestorOutput ? ` (${ancestorOutput})` : ""}`,
    )
    .join("\n");

  return `# FN-4441 transition evidence backfill\n\n## Pre-state\n- mergeRetries: ${mergeRetriesLine}\n- Branch tip SHA: \`${branchTip.short}\` (full: \`${branchTip.full}\`)\n- last merge error: ${lastMergeError}\n\n## Canonical main landings\n${mainLandingLines}\n\n## Resolution pointer\n- Resolving task: ${resolutionTaskId}\n- Summary: Branch tip \`${branchTip.short}\` was out-of-scope FN-4393 contamination that cherry-picked empty; FN-4441's File Scope deliverable (\`.github/actions/setup-node-pnpm/action.yml\`) was already on main via \`00c8739d5\` + \`41070475b\`.\n\n## Post-state\n- FN-4441 column at time of write: ${postState.column}\n- Branch \`fusion/fn-4441\` disposition: ${postState.branchDisposition}\n`;
}

function getAncestorStatus(sha) {
  try {
    execSync(`git merge-base --is-ancestor ${sha} origin/main`, { stdio: "pipe" });
    return { status: 0, output: "ancestor" };
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 1;
    const output = String(error?.stderr || error?.stdout || "not ancestor").trim();
    return { status, output: output || "not ancestor" };
  }
}

function getBranchDisposition() {
  const local = execSync("git branch --list fusion/fn-4441", { stdio: "pipe" }).toString().trim();
  const remote = execSync("git branch -r --list origin/fusion/fn-4441", {
    stdio: "pipe",
  })
    .toString()
    .trim();

  if (local || remote) {
    return `still present (${[local || null, remote || null].filter(Boolean).join(", ")})`;
  }
  return "not present locally or on origin refs";
}

export async function runBackfill() {
  /* FNXC:PostgresOperationalScripts 2026-07-14-18:20: Evidence backfills must write through the authoritative PostgreSQL TaskStore and close its backend lifecycle. */
  const backend = await openBackend(process.cwd());
  const store = backend.store;
  try {
    const targetTask = await store.getTask("FN-4441");
    const preResolution = await store.getTaskDocument("FN-4450", "resolution");
    const retriesMatch = preResolution?.content?.match(/mergeRetries\s*:\s*(\d+)/i);
    const mergeRetries = retriesMatch ? Number(retriesMatch[1]) : undefined;

    const mainStep1 = getAncestorStatus("00c8739d5");
    const mainStep2 = getAncestorStatus("41070475b");

    const content = composeTransitionEvidence({
      mergeRetries,
      branchTip: {
        short: "f57f70165",
        full: "f57f70165ac154f1ca79e68510990bc61916660e",
      },
      mainSHAs: [
        {
          sha: "00c8739d5",
          title: "feat(FN-4441): complete Step 1 — add node_modules cache layer",
          ancestorStatus: mainStep1.status,
          ancestorOutput: mainStep1.output,
        },
        {
          sha: "41070475b",
          title: "feat(FN-4441): complete Step 2 — verify cache-hit integrity",
          ancestorStatus: mainStep2.status,
          ancestorOutput: mainStep2.output,
        },
      ],
      lastMergeError:
        "`git cherry-pick -X ours f57f70165...` returned 'The previous cherry-pick is now empty, possibly due to conflict resolution.' and retries exhausted.",
      resolutionTaskId: "FN-4450",
      postState: {
        column: targetTask?.column ?? "unknown",
        branchDisposition: getBranchDisposition(),
      },
    });

    const writeResult = await store.upsertTaskDocument("FN-4441", {
      key: "transition-evidence",
      content,
      author: "FN-4461",
    });

    const readBack = await store.getTaskDocument("FN-4441", "transition-evidence");
    console.log(
      JSON.stringify(
        {
          revision: writeResult.revision,
          key: readBack?.key ?? "transition-evidence",
          contentLength: readBack?.content.length ?? 0,
        },
        null,
        2,
      ),
    );

    return { writeResult, readBack };
  } finally {
    await backend.shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runBackfill().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
