/**
 * FNXC:CodeOrganization 2026-07-16-00:30:
 * Pure git/test-output parse helpers peeled from merger.ts (string parsing only).
 */

export function parseFailingFilesFromOutput(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    // jest/vitest: "FAIL packages/engine/src/__tests__/foo.test.ts"
    const failMatch = line.match(/^FAIL\s+(\S+)/);
    if (failMatch && failMatch[1]) {
      paths.add(failMatch[1]);
      continue;
    }
    // vitest summary: " ❯ packages/engine/src/__tests__/foo.test.ts (2 tests | 1 failed)"
    const vitestSummaryMatch = line.match(/^\s*[❯>]\s+(\S+\.(?:test|spec)\.[jt]sx?)\s/);
    if (vitestSummaryMatch && vitestSummaryMatch[1]) {
      paths.add(vitestSummaryMatch[1]);
      continue;
    }
    // vitest: " × src/__tests__/foo.test.ts > some test name"
    const crossMatch = line.match(/^\s*[×✕✗]\s+(\S+\.(?:test|spec)\.[jt]sx?)\s/);
    if (crossMatch && crossMatch[1]) {
      paths.add(crossMatch[1]);
    }
  }
  return Array.from(paths);
}

/** Parse `git status -z --porcelain` into a Set of paths.
 *
 *  Format per entry: `XY <space> <path>\0` where X = staged status, Y =
 *  unstaged status. Renames and copies are special: they emit TWO
 *  NUL-separated entries, `R  <new>\0<old>\0` (or `C  <new>\0<old>\0`).
 *  We must consume the trailing `<old>` entry without treating it as a
 *  separate path, otherwise observability code over-reports "cleared
 *  paths" with the historical names of renames. */
export function parsePorcelainZ(raw: string): Set<string> {
  const paths = new Set<string>();
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    paths.add(path);
    // Rename/copy: the very next entry is the old path — skip it so it
    // isn't mistaken for an independent dirty path.
    if (status.charAt(0) === "R" || status.charAt(0) === "C") {
      i++;
    }
  }
  return paths;
}

export function parseShortstatSummary(statsOutput: string): { filesChanged: number; insertions: number; deletions: number } {
  const normalized = statsOutput.trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}
