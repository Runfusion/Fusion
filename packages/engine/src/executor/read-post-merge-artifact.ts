import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
type Run = (binary: string, args: string[], options: {
  cwd: string; encoding: "buffer"; timeout: number; maxBuffer: number; signal?: AbortSignal;
}) => Promise<{ stdout: Buffer }>;

/** Read a bounded artifact archive without extracting files into any repository. */
export async function readPostMergeArtifact(
  input: { repository: string; artifactId: number; cwd: string; signal?: AbortSignal },
  run: Run = execFileAsync,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.repository)
    || !Number.isSafeInteger(input.artifactId) || input.artifactId < 1) {
    throw new Error("Use a GitHub owner/repository and a positive artifact ID.");
  }
  const deadline = Date.now() + TIMEOUT_MS;
  const execute = async (binary: string, args: string[], maxBuffer: number): Promise<Buffer> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Artifact inspection timed out.");
    const { stdout } = await run(binary, args, {
      cwd: input.cwd, encoding: "buffer", timeout: remaining, maxBuffer, signal: input.signal,
    });
    if (stdout.length > maxBuffer) throw new Error("Artifact exceeds the inspection size limit.");
    return stdout;
  };
  const archive = await execute("gh", ["api", "--method", "GET", `repos/${input.repository}/actions/artifacts/${input.artifactId}/zip`], MAX_BYTES);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fusion-post-merge-artifact-"));
  try {
    const archivePath = join(temporaryDirectory, "artifact.zip");
    await writeFile(archivePath, archive);
    const listing = (await execute("unzip", ["-Z1", archivePath], 64_000)).toString("utf8");
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (entries.length > 32) throw new Error("Artifact contains too many entries.");
    const output: Buffer[] = [];
    let remainingBytes = MAX_BYTES;
    for (const entry of entries) {
      // Reject option/glob ambiguity as well as traversal; unzip only ever writes to stdout.
      if (entry.startsWith("/") || entry.startsWith("-") || entry.includes("\\")
        || entry.split("/").includes("..")
        || [...entry].some((character) => character.charCodeAt(0) < 32 || "*?[]".includes(character))) {
        throw new Error("Artifact contains an unsupported entry name.");
      }
      if (entry.endsWith("/")) continue;
      const heading = Buffer.from(`\n--- ${entry} ---\n`);
      remainingBytes -= heading.length;
      if (remainingBytes <= 0) throw new Error("Artifact exceeds the inspection size limit.");
      const content = await execute("unzip", ["-p", archivePath, entry], remainingBytes);
      remainingBytes -= content.length;
      output.push(heading, content);
    }
    return Buffer.concat(output).toString("utf8");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
