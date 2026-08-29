type AttributionSource = "trailer" | "subject-prefix" | "bracketed-prefix" | "none";

export interface DoneRangeAttributionOptions {
  worktreePath: string;
  baseRef: string;
  taskId: string;
  runGit: (args: string[]) => Promise<string>;
}

export interface DoneRangeAttributionResult {
  files: string[];
  ownCommitShas: string[];
  foreignCommitCount: number;
}

function extractAttributedTaskId(body: string): string | null {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return last?.[1] ?? null;
}

function extractTaskIdFromSubject(subject: string): {
  attributedTaskId: string | null;
  source: Extract<AttributionSource, "subject-prefix" | "bracketed-prefix" | "none">;
} {
  if (!subject) {
    return { attributedTaskId: null, source: "none" };
  }

  const conventional =
    /^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\s*\(([A-Z]+-\d+)\)!?:/i.exec(subject);
  if (conventional?.[1]) {
    return { attributedTaskId: conventional[1].toUpperCase(), source: "subject-prefix" };
  }

  const bracketed = /^\s*\[([A-Z]+-\d+)\]/i.exec(subject);
  if (bracketed?.[1]) {
    return { attributedTaskId: bracketed[1].toUpperCase(), source: "bracketed-prefix" };
  }

  const colon = /^\s*([A-Z]+-\d+):/i.exec(subject);
  if (colon?.[1]) {
    return { attributedTaskId: colon[1].toUpperCase(), source: "subject-prefix" };
  }

  return { attributedTaskId: null, source: "none" };
}

function taskIdsMatch(a: string | null, b: string): boolean {
  return a !== null && a.toUpperCase() === b.toUpperCase();
}

export async function filterFilesToOwnTaskCommits(opts: DoneRangeAttributionOptions): Promise<DoneRangeAttributionResult> {
  const logOutput = await opts.runGit(["log", "--format=%H%x00%s%x00%B%x1e", `${opts.baseRef}..HEAD`]);

  if (!logOutput.trim()) {
    return { files: [], ownCommitShas: [], foreignCommitCount: 0 };
  }

  const fileSet = new Set<string>();
  const ownCommitShas: string[] = [];
  let foreignCommitCount = 0;

  const records = logOutput
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);

  for (const record of records) {
    const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
    if (!sha) continue;
    const body = bodyParts.join("\x00");

    const trailerAttributedTaskId = extractAttributedTaskId(body);
    const subjectAttribution = trailerAttributedTaskId
      ? { attributedTaskId: null, source: "none" as const }
      : extractTaskIdFromSubject(subject);
    const attributedTaskId = trailerAttributedTaskId ?? subjectAttribution.attributedTaskId;

    if (taskIdsMatch(attributedTaskId, opts.taskId)) {
      ownCommitShas.push(sha);
    } else {
      foreignCommitCount += 1;
    }
  }

  for (const sha of ownCommitShas) {
    const diffTreeOutput = await opts.runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    for (const file of diffTreeOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      fileSet.add(file);
    }
  }

  return {
    files: [...fileSet].sort((a, b) => a.localeCompare(b)),
    ownCommitShas,
    foreignCommitCount,
  };
}
