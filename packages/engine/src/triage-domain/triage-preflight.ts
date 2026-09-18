import type { Task } from "@fusion/core";

export interface CitedConstruct {
  kind: "identifier" | "snippet" | "command";
  raw: string;
  filePath?: string;
  line?: number;
}

export interface GhostBugProbeResult {
  construct: CitedConstruct;
  matched: boolean;
  probeError?: string;
  output?: string;
}

export interface GhostBugDecision {
  decision: "archive" | "pass";
  reason: string;
  findings: GhostBugProbeResult[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Probe "matched" is an exit-code fact, not a printed-bytes heuristic. Plan text that names the
 * allegedly-missing construct originates in agent-authored prose, so it is only ever handed to a
 * fixed `git` argv array — never interpolated into a shell string — and the caller classifies the
 * result from `exitCode`/`stderr`, not from whether stdout happened to be non-empty.
 */
export type ProbeExec = (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

const BUG_FIX_REGEX = /typecheck error|compile error|broken|regression|lint error/i;

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Bounds on what an untrusted construct raw value may look like before it is allowed anywhere near
 * `exec`. 200 chars keeps a single argv entry sane; a newline/NUL would otherwise let a multi-line
 * "identifier" smuggle a second logical argument past argv-based (not shell-based) execution.
 */
const MAX_CONSTRUCT_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 500;

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * The positive control samples a line of TRACKED, TEXTUAL repository content and re-greps for it.
 * Restricting the sample to obviously-textual extensions avoids picking a binary/lockfile line whose
 * bytes can't round-trip through `git grep -F` as a stable single-line needle.
 */
const TEXTISH_EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "md", "json", "yml", "yaml", "toml", "cs", "csproj", "go", "py",
  "java", "rb", "rs", "php", "swift", "kt", "kts", "c", "cc", "cpp", "h", "hpp", "html", "css", "scss",
  "vue", "svelte", "sh",
]);

export function isBugFixShape(task: { title: string | null; description: string }): boolean {
  const title = task.title?.trim() ?? "";
  const description = task.description?.trim() ?? "";
  if (!title && !description) return false;
  if (/^\s*fix\b/i.test(title)) return true;
  return BUG_FIX_REGEX.test(`${title}\n${description}`);
}

export function extractCitedConstructs(prompt: string): CitedConstruct[] {
  const seen = new Set<string>();
  const constructs: CitedConstruct[] = [];
  const add = (construct: CitedConstruct) => {
    if (construct.raw.trim().length === 0) return;
    const key = `${construct.kind}:${construct.raw}:${construct.filePath ?? ""}:${construct.line ?? ""}`;
    if (seen.has(key) || constructs.length >= 20) return;
    seen.add(key);
    constructs.push(construct);
  };

  const identifierRegex = /`([A-Za-z_][A-Za-z0-9_.]*\([^`]*\)|[A-Za-z_][\w.]{2,})`/g;
  for (const match of prompt.matchAll(identifierRegex)) {
    const raw = match[1].trim();
    if (raw.includes("(") || raw.includes(".") || raw.includes("_")) {
      add({ kind: "identifier", raw });
    }
  }

  const fileRegex = /(packages\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|md))(?::(\d+))?/g;
  for (const match of prompt.matchAll(fileRegex)) {
    const filePath = match[1];
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
    add({ kind: "identifier", raw: filePath, filePath, line });
  }

  const fenceRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
  for (const match of prompt.matchAll(fenceRegex)) {
    const lines = match[1].split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes("(") || line.includes("=") || line.includes("import")) {
        add({ kind: "snippet", raw: line });
      }
    }
  }

  for (const line of prompt.split("\n")) {
    if (/^\s*(?:pnpm|npm|yarn|tsc|node|eslint)\b[^\n]+/m.test(line)) {
      add({ kind: "command", raw: line.trim() });
    }
  }

  return constructs;
}

function truncateOutput(stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length <= MAX_OUTPUT_LENGTH ? trimmed : `${trimmed.slice(0, MAX_OUTPUT_LENGTH)}…[truncated]`;
}

/** A raw value is safe to pass as a single argv entry: bounded length, no embedded line breaks/NUL. */
function isSafeRaw(raw: string): boolean {
  return raw.length <= MAX_CONSTRUCT_LENGTH && !/[\0\n\r]/.test(raw);
}

/**
 * A cited file path is safe to interpolate into `HEAD:<path>`: repo-relative (no leading `/`), not an
 * option-injection attempt (no leading `-`), no traversal segments, and no embedded line breaks/NUL.
 */
function isSafeFilePath(filePath: string): boolean {
  return !filePath.startsWith("/")
    && !filePath.startsWith("-")
    && !/[\0\n\r]/.test(filePath)
    && !filePath.split("/").includes("..");
}

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * `git grep` exits 0 on a hit and 1 on a clean "no match" — both are definitive. Any other exit code
 * (128 = not a repo / bad pathspec, etc.) is a probe failure, not evidence of absence, and a non-empty
 * stderr alongside exit 1 means the command errored rather than genuinely finding nothing.
 */
function classifyProbe(construct: CitedConstruct, result: ExecResult): GhostBugProbeResult {
  const output = truncateOutput(result.stdout);
  if (result.exitCode === 0) return { construct, matched: true, output };
  if (result.exitCode === 1 && result.stderr.trim().length === 0) return { construct, matched: false, output };
  return {
    construct,
    matched: false,
    output,
    probeError: result.exitCode === undefined ? "exit_code_unavailable" : "probe_command_failed",
  };
}

export async function probeCitedConstructs(
  constructs: CitedConstruct[],
  opts: { cwd: string; timeoutMs?: number; exec: ProbeExec },
): Promise<GhostBugProbeResult[]> {
  const findings: GhostBugProbeResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 5000;

  for (const construct of constructs) {
    if (construct.kind === "command") {
      /*
      FNXC:GhostBugPreflight 2026-09-17-00:00:
      A command citation is plan prose that merely LOOKS like a shell line (e.g. "pnpm test"). Running
      it would be an execution surface with no evidential value about whether the cited code exists,
      so command probes are never executed — they are always treated as non-definitive.
      */
      findings.push({ construct, matched: false, probeError: "command_probes_not_executed" });
      continue;
    }
    if (!isSafeRaw(construct.raw) || (construct.filePath !== undefined && !isSafeFilePath(construct.filePath))) {
      findings.push({ construct, matched: false, probeError: "unsafe_construct" });
      continue;
    }

    /*
    FNXC:GhostBugPreflight 2026-09-17-00:00:
    Repository-wide (`:/`), not `packages/`-scoped: the original scope assumed every construct lives
    under `packages/`, which false-negatived (and thus falsely archived) tasks citing code elsewhere
    in the tree (docs, scripts, non-`packages/` workspaces).
    */
    const argv = construct.kind === "identifier" && construct.filePath
      ? ["git", "cat-file", "-e", `HEAD:${construct.filePath}`]
      : ["git", "grep", "-nF", "-e", construct.raw, "--", ":/"];
    try {
      findings.push(classifyProbe(construct, await opts.exec(argv, { cwd: opts.cwd, timeoutMs })));
    } catch (error) {
      findings.push({
        construct,
        matched: false,
        probeError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return findings;
}

export type ProbeControlOutcome = "matched" | "unmatched" | "unavailable";

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * Archiving work the engine just planned demands positive proof the probe apparatus itself works —
 * a worktree with a detached HEAD, a missing `.git`, or a `git` binary that silently no-ops would
 * otherwise make every construct look "missing" and archive perfectly valid tasks. Sample one line of
 * genuinely-tracked content and confirm the SAME probe path can re-find it before trusting an
 * all-missing verdict.
 */
export async function runProbePositiveControl(
  opts: { cwd: string; timeoutMs?: number; exec: ProbeExec },
): Promise<ProbeControlOutcome> {
  const exec = (argv: string[]) => opts.exec(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 5000 });
  try {
    const files = await exec(["git", "ls-files"]);
    if (files.exitCode !== 0) return "unavailable";
    const path = files.stdout.split("\n").map((entry) => entry.trim()).find((entry) => {
      const extension = entry.split(".").pop()?.toLowerCase();
      return Boolean(extension && TEXTISH_EXTENSIONS.has(extension) && isSafeFilePath(entry));
    });
    if (!path) return "unavailable";

    const source = await exec(["git", "show", `HEAD:${path}`]);
    if (source.exitCode !== 0) return "unavailable";
    const line = source.stdout.split("\n").map((entry) => entry.trim()).find((entry) => (
      entry.length >= 8 && entry.length <= MAX_CONSTRUCT_LENGTH && !/[\0\r]/.test(entry)
    ));
    if (!line) return "unavailable";

    const probe = await exec(["git", "grep", "-nF", "-e", line, "--", ":/"]);
    if (probe.exitCode === 0) return "matched";
    return probe.exitCode === 1 && probe.stderr.trim().length === 0 ? "unmatched" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * A bug-fix task whose PROMPT.md cites a specific construct that no longer exists on `main` is almost
 * certainly stale bookkeeping (the construct was already fixed/removed by other work) rather than a
 * real outstanding bug. Archive it instead of dispatching an executor at a target that isn't there —
 * but only when EVERY definitive probe came back missing AND the positive control proves the probe
 * pipeline is actually working; otherwise fail open and let the task through to normal execution.
 */
export async function runGhostBugPreflight(
  task: Pick<Task, "title" | "description">,
  prompt: string,
  opts: { cwd: string; timeoutMs?: number; exec: ProbeExec },
): Promise<GhostBugDecision> {
  if (!isBugFixShape({ title: task.title ?? null, description: task.description ?? "" })) {
    return { decision: "pass", reason: "not_bug_fix_shape", findings: [] };
  }

  const constructs = extractCitedConstructs(prompt);
  if (constructs.length === 0) {
    return { decision: "pass", reason: "no_constructs", findings: [] };
  }

  const findings = await probeCitedConstructs(constructs, opts);
  const definitive = findings.filter((finding) => !finding.probeError);
  if (definitive.length === 0) {
    return { decision: "pass", reason: "no_definitive_probe_signal", findings };
  }

  if (definitive.every((finding) => finding.matched === false)) {
    const controlOutcome = await runProbePositiveControl(opts);
    if (controlOutcome === "matched") {
      return { decision: "archive", reason: "all_cited_constructs_missing_on_main", findings };
    }
    return {
      decision: "pass",
      reason: "probe_control_failed",
      findings: [...findings, {
        construct: { kind: "identifier", raw: "positive_control" },
        matched: false,
        probeError: `probe_control_${controlOutcome}`,
      }],
    };
  }

  return { decision: "pass", reason: "construct_found_or_inconclusive", findings };
}
