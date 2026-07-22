import { execFile as nodeExecFile } from "node:child_process";

/**
 * Locate running vitest processes safely.
 *
 * `pgrep -f vitest` matches FULL command lines, so a bare pattern also matches
 * innocent bystanders whose argv merely mentions vitest:
 *   - wrapper shells (`zsh -c '... npx vitest run ...'`) — killing these
 *     strands the `$?` handler so failures look like silent truncation,
 *   - monitoring/grep one-liners that mention vitest,
 *   - editors or tools opened on `vitest.config.ts`.
 * Root cause of the 2026-06-03 incident where the memory-pressure auto-kill
 * SIGKILLed unrelated process trees every 30s.
 *
 * This helper filters pgrep candidates to processes whose executable (`comm`)
 * is actually node, so only the vitest runner and its workers are reported.
 */

export interface FindVitestProcessIdsOptions {
  /** PIDs to exclude in addition to the calling process. */
  excludePids?: number[];
  /** Test seam — injected execFile. */
  execFileImpl?: typeof nodeExecFile;
}

function execToStdout(
  execFileImpl: typeof nodeExecFile,
  cmd: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve) => {
    execFileImpl(cmd, args, { encoding: "utf8" }, (err, out) => {
      // pgrep/ps exit non-zero when nothing matches — treat as empty result.
      resolve(err ? "" : (typeof out === "string" ? out : ""));
    });
  });
}

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Keep only pids whose executable is node (vitest runner + pool workers). */
async function filterToNodeProcesses(
  execFileImpl: typeof nodeExecFile,
  pids: number[],
): Promise<number[]> {
  if (pids.length === 0) return [];
  const stdout = await execToStdout(execFileImpl, "ps", [
    "-o",
    "pid=,comm=",
    "-p",
    pids.join(","),
  ]);
  const nodePids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const comm = trimmed.slice(spaceIdx + 1).trim();
    const executable = comm.split("/").pop() ?? comm;
    if (executable === "node" || executable === "node.exe" || executable === "nodejs") {
      nodePids.push(pid);
    }
  }
  return nodePids;
}

export async function findVitestProcessIds(
  options: FindVitestProcessIdsOptions = {},
): Promise<number[]> {
  // pgrep/ps are POSIX-only; Windows callers treat this as a no-op.
  if (process.platform === "win32") return [];

  const execFileImpl = options.execFileImpl ?? nodeExecFile;
  const excluded = new Set<number>([process.pid, ...(options.excludePids ?? [])]);

  const candidates = parsePids(await execToStdout(execFileImpl, "pgrep", ["-f", "vitest"]));
  const nodePids = await filterToNodeProcesses(execFileImpl, candidates);
  return nodePids.filter((pid) => !excluded.has(pid));
}
