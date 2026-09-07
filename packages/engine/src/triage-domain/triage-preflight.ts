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
  decision: "delete" | "pass";
  reason: string;
  findings: GhostBugProbeResult[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * FNXC:GhostBugPreflight 2026-09-07-17:01:
 * Probe matched-ness is an exit-code fact, not a printed-bytes heuristic. Cited text originates in
 * plan prose, so it is passed only as an argv datum to fixed git commands and never shell-interpreted.
 */
export type ProbeExec = (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

const BUG_FIX_REGEX = /typecheck error|compile error|broken|regression|lint error/i;
const MAX_CONSTRUCT_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 500;
const TEXTISH_EXTENSIONS = new Set(["ts", "tsx", "js", "mjs", "cjs", "md", "json", "yml", "yaml", "toml", "cs", "csproj", "go", "py", "java", "rb", "rs", "php", "swift", "kt", "kts", "c", "cc", "cpp", "h", "hpp", "html", "css", "scss", "vue", "svelte", "sh"]);

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
  return trimmed.length <= MAX_OUTPUT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_OUTPUT_LENGTH)}…[truncated]`;
}

function isSafeRaw(raw: string): boolean {
  return raw.length <= MAX_CONSTRUCT_LENGTH && !/[\0\n\r]/.test(raw);
}

function isSafeFilePath(filePath: string): boolean {
  return !filePath.startsWith("/")
    && !filePath.startsWith("-")
    && !/[\0\n\r]/.test(filePath)
    && !filePath.split("/").includes("..");
}

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
      FNXC:GhostBugPreflight 2026-09-07-17:01:
      Command citations are non-definitive. Executing a shell line lifted from plan prose is an
      execution surface with no evidential value, so command probes are intentionally not run.
      */
      findings.push({ construct, matched: false, probeError: "command_probes_not_executed" });
      continue;
    }
    if (!isSafeRaw(construct.raw) || (construct.filePath !== undefined && !isSafeFilePath(construct.filePath))) {
      findings.push({ construct, matched: false, probeError: "unsafe_construct" });
      continue;
    }

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
 * FNXC:GhostBugPreflight 2026-09-07-17:01:
 * Deleting work the engine just planned demands positive evidence that the probe apparatus works.
 * A successful sample from tracked repository content detects systematically empty probe environments.
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
      return { decision: "delete", reason: "all_cited_constructs_missing_on_main", findings };
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
