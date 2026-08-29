export function countPatchLines(patch: string): { additions: number; deletions: number } {
  if (!patch) {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("--- ")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}
