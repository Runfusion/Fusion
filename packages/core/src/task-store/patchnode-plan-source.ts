import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { storeLog } from "../store.js";

/**
 * Tolerant read of a task's `PROMPT.md`, used as the Patchnode ledger body source.
 *
 * FNXC:PatchnodeLedger 2026-09-18-02:48:
 * FN-526 sources the History description from the plan's product summary, so every capture site
 * needs the plan text. This mirrors the FN-227-era tolerant read in `reads.ts`: `PROMPT.md` is
 * ENRICHMENT, never essential row data. A missing file, an EACCES from a root-owned file, an
 * EISDIR, or a transient FS error degrades to `null` — a delivery capture and a reconciliation pass
 * must NEVER fail because a plan is unreadable, they just record an empty description.
 *
 * Kept out of `board/patchnode.ts` so the pure builder module — reachable from the dashboard's
 * `types.ts` alias — never inherits a `node:fs` dependency.
 */
export async function readTaskPlanPrompt(taskDir: string): Promise<string | null> {
  try {
    const promptPath = join(taskDir, "PROMPT.md");
    if (!existsSync(promptPath)) return null;
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    storeLog.warn(`[patchnode] failed to read PROMPT.md in ${taskDir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
