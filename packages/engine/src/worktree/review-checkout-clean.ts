import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewCheckoutProbe =
  | { state: "clean" }
  | { state: "dirty"; paths: string[] }
  | { state: "unavailable" };

/** Approval binds committed content; ignored verification artifacts are not source changes. */
export async function probeReviewCheckout(worktreePath: string): Promise<ReviewCheckoutProbe> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: worktreePath, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const records = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      paths.push(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) paths.push(records[++index]);
    }
    return paths.length ? { state: "dirty", paths } : { state: "clean" };
  } catch {
    return { state: "unavailable" };
  }
}
