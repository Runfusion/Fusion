/**
 * Deterministic PR mergeability classification — the single authority for the
 * `fn pr mergeability` operator/schedule seam.
 *
 * FNXC:PrMergeability 2026-10-12-03:20:
 * RUFU-468 replaced the wall-clock auto-merge gate (which could not answer "can this
 * PR merge into ITS OWN base right now?") with a schedule-triggered autonomous PR
 * agent. That agent's mergeability line must be machine-parseable and must never be
 * inferred from git history, so this module encodes the classification contract:
 * `api.mergeable === "CONFLICTING"` (GitHub's own verdict for the PR's actual
 * `baseRefName`) is the ONLY classification authority for a reported conflict.
 *
 * `mergeStateStatus` is display/evidence only and is deliberately absent from every
 * predicate here. `BLOCKED` is a policy/branch-protection state (failing checks,
 * required approvals); measuring it as a conflict produced six fabricated `[our-main]`
 * causes in one evening, and `DIRTY` arrives through the same field via
 * `mapPrConflictState` -> `mergeStatus.mergeable` in `packages/dashboard/src/github.ts`.
 * Corroborating an `api` verdict with `git merge-tree` is optional and offline; when the
 * two disagree this module names BOTH values on a `DISAGREE:` line rather than choosing
 * one, and it has no parameter capable of producing a cause tag such as `[our-main]` or
 * `[upstream]` — a cause label is not derivable from either source.
 *
 * IO shape: no `gh`, `git`, or filesystem import. Every IO-capable collaborator is a
 * parameter (`GhJsonRunner`, `MergeTreeGitRunner`), so the classifier and the formatter
 * are pure and fixtures drive them without a network, a `gh` binary, a `git` spawn, or
 * a timer.
 */

/**
 * The exact `gh pr view --json` field list this classifier consumes. Exported as a
 * constant so the fetch factory and the argv-assertion test cannot drift from it.
 */
export const PR_MERGEABILITY_GH_FIELDS = [
  "number",
  "state",
  "mergeable",
  "mergeStateStatus",
  "baseRefName",
] as const;

/** The same field list in the comma-joined form `gh --json` expects. */
export const PR_MERGEABILITY_GH_JSON_FIELDS = PR_MERGEABILITY_GH_FIELDS.join(",");

/**
 * One PR as reported by `gh pr view --json`, normalized.
 *
 * `mergeable` carries GitHub's raw API enum (`MERGEABLE` | `CONFLICTING` | `UNKNOWN`,
 * or `null` when GitHub has not computed it yet). It is NOT the dashboard's lowercase
 * `PrConflictState` display value — feeding that display enum into a verdict is the
 * defect RUFU-473 tracks separately.
 */
export interface PrMergeabilityRecord {
  number: number;
  state: string;
  mergeable: string | null;
  /** Evidence only. Never a verdict input — see the file header. */
  mergeStateStatus: string | null;
  baseRefName: string;
}

/** Corroborating offline verdict from `git merge-tree --write-tree --name-only`. */
export type MergeTreeProbeStatus = "CONFLICTING" | "MERGEABLE" | "UNAVAILABLE";

/** Why a probe produced no verdict. An unavailable probe never counts as disagreement. */
export type MergeTreeUnavailableReason = "no-ref" | "git-error";

export interface MergeTreeVerdict {
  status: MergeTreeProbeStatus;
  /** Conflicted-path count, or `null` when the probe produced no verdict or none was parseable. */
  conflictedFileCount: number | null;
  unavailableReason?: MergeTreeUnavailableReason;
}

/** A PR reported as conflicting, with the evidence the receipt must name. */
export interface PrMergeabilityConflict {
  number: number;
  /** Always the literal source tag — a conflict is never attributed to git history. */
  source: "api.mergeable";
  api: "CONFLICTING";
  base: string;
  mergeTree: MergeTreeProbeStatus | "not-probed";
  conflictedFileCount: number | null;
  mergeStateStatus: string | null;
}

/** `api` and `merge-tree` reached different conclusions about the same PR. */
export interface PrMergeabilityDisagreement {
  number: number;
  /** The raw `api.mergeable` value, uppercased; `UNKNOWN` when GitHub reported no value. */
  api: string;
  mergeTree: MergeTreeProbeStatus;
  base: string;
  conflictedFileCount: number | null;
}

export interface PrMergeabilityClassification {
  /** How many OPEN records were evaluated. */
  classified: number;
  conflicts: PrMergeabilityConflict[];
  disagreements: PrMergeabilityDisagreement[];
}

/** Structured form of the receipt — the `--json` payload. */
export interface PrMergeabilityReport extends PrMergeabilityClassification {
  repo: string;
}

/** `gh pr view`/`list` JSON runner — structurally satisfied by `runGhJsonAsync`. */
export type GhJsonRunner = (
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<unknown>;

/** Async `git` runner resolving to exit code + stdout (never rejects for exit 1). */
export type MergeTreeGitRunner = (
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string }>;

/** Thrown when `gh` returned a shape this classifier cannot decode. */
export class PrMergeabilityFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrMergeabilityFetchError";
  }
}

const CONFLICTING = "CONFLICTING";
const UNKNOWN_LABEL = "UNKNOWN";

function upper(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim().toUpperCase() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * The single conflict predicate. Anything other than GitHub's `CONFLICTING` — including
 * `MERGEABLE`, `UNKNOWN`, `null`, and every `mergeStateStatus` value — is not a conflict.
 */
export function isPrMergeabilityConflict(record: Pick<PrMergeabilityRecord, "mergeable">): boolean {
  return upper(record.mergeable) === CONFLICTING;
}

function apiLabel(record: Pick<PrMergeabilityRecord, "mergeable">): string {
  return upper(record.mergeable) ?? UNKNOWN_LABEL;
}

function baseLabel(baseRefName: string): string {
  const trimmed = typeof baseRefName === "string" ? baseRefName.trim() : "";
  return trimmed === "" ? "unknown" : trimmed;
}

function isEligibleRecord(record: PrMergeabilityRecord): boolean {
  return upper(record.state) === "OPEN";
}

/**
 * Classify records against the classification authority, optionally corroborated by
 * offline `merge-tree` verdicts keyed by PR number.
 *
 * Ordering is deterministic: ascending PR number, with a PR's own `CONFLICT` entry
 * preceding its `DISAGREE` entry. No timestamp, no clock, no randomness.
 */
export function classifyPrMergeability(
  records: readonly PrMergeabilityRecord[],
  probeResults: Record<number, MergeTreeVerdict> = {},
): PrMergeabilityClassification {
  const eligible = records
    .filter(isEligibleRecord)
    .slice()
    .sort((a, b) => a.number - b.number);

  const conflicts: PrMergeabilityConflict[] = [];
  const disagreements: PrMergeabilityDisagreement[] = [];

  for (const record of eligible) {
    const probe = probeResults[record.number];
    const apiConflicting = isPrMergeabilityConflict(record);
    const probeConflicting = probe?.status === CONFLICTING;

    if (apiConflicting) {
      conflicts.push({
        number: record.number,
        source: "api.mergeable",
        api: CONFLICTING,
        base: baseLabel(record.baseRefName),
        mergeTree: probe?.status ?? "not-probed",
        conflictedFileCount: probe?.conflictedFileCount ?? null,
        mergeStateStatus: upper(record.mergeStateStatus),
      });
    }

    /*
    FNXC:PrMergeability 2026-10-12-03:20:
    Disagreement needs a probe verdict to disagree WITH: an `UNAVAILABLE` probe is missing
    evidence, not a dissenting opinion, so it never lands here and never adds a PR to the
    reported set. A `null`/`UNKNOWN` api value is still named verbatim on the line
    (`api=UNKNOWN`) so the reader sees which side actually abstained.
    */
    if (probe && probe.status !== "UNAVAILABLE" && probeConflicting !== apiConflicting) {
      disagreements.push({
        number: record.number,
        api: apiLabel(record),
        mergeTree: probe.status,
        base: baseLabel(record.baseRefName),
        conflictedFileCount: probe.conflictedFileCount,
      });
    }
  }

  return { classified: eligible.length, conflicts, disagreements };
}

/** Build the structured report that both the text receipt and `--json` render from. */
export function buildPrMergeabilityReport(
  records: readonly PrMergeabilityRecord[],
  probeResults: Record<number, MergeTreeVerdict> = {},
  options: { repo?: string } = {},
): PrMergeabilityReport {
  const classification = classifyPrMergeability(records, probeResults);
  return { repo: options.repo?.trim() || "unknown", ...classification };
}

function countLabel(count: number | null): string {
  return typeof count === "number" ? String(count) : "unknown";
}

function mergeTreeLabel(conflict: PrMergeabilityConflict): string {
  return conflict.mergeTree;
}

function mergeStateLabel(mergeStateStatus: string | null): string {
  return mergeStateStatus ?? "unknown";
}

/**
 * Render the deterministic receipt: one `MERGEABILITY` header line, then one line per
 * conflict and per disagreement, interleaved in ascending PR-number order.
 *
 * Byte-identical for identical input: the only inputs are the records and the probe map,
 * and neither is allowed to carry a timestamp or a cause tag.
 */
export function formatPrMergeabilityReport(
  records: readonly PrMergeabilityRecord[],
  probeResults: Record<number, MergeTreeVerdict> = {},
  options: { repo?: string } = {},
): string {
  const report = buildPrMergeabilityReport(records, probeResults, options);
  const lines: string[] = [
    `MERGEABILITY repo=${report.repo} classified=${report.classified} conflicts=${report.conflicts.length}`,
  ];

  type ReceiptLine = { number: number; order: 0 | 1; text: string };
  const body: ReceiptLine[] = [];

  for (const conflict of report.conflicts) {
    body.push({
      number: conflict.number,
      order: 0,
      text:
        `CONFLICT #${conflict.number}` +
        ` source=${conflict.source}` +
        ` api=${conflict.api}` +
        ` base=${conflict.base}` +
        ` merge-tree=${mergeTreeLabel(conflict)}` +
        ` conflicted_files=${countLabel(conflict.conflictedFileCount)}` +
        ` merge-state=${mergeStateLabel(conflict.mergeStateStatus)}`,
    });
  }

  for (const disagreement of report.disagreements) {
    body.push({
      number: disagreement.number,
      order: 1,
      text:
        `DISAGREE: #${disagreement.number}` +
        ` api=${disagreement.api}` +
        ` merge-tree=${disagreement.mergeTree}` +
        ` base=${disagreement.base}` +
        ` conflicted_files=${countLabel(disagreement.conflictedFileCount)}`,
    });
  }

  body.sort((a, b) => a.number - b.number || a.order - b.order);
  for (const line of body) lines.push(line.text);

  return lines.join("\n");
}

/** Validate an `owner/repo` slug before it can reach any argv. */
export function requireMergeabilityRepo(repo: string): string {
  const trimmed = typeof repo === "string" ? repo.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    throw new PrMergeabilityFetchError(`Invalid repository identifier: ${trimmed || "(empty)"}`);
  }
  return trimmed;
}

/**
 * Validate a PR number as a positive integer BEFORE it is ever placed into argv —
 * a `--prs 3619;rm -rf` style value must fail here, not inside a spawned process.
 */
export function requireMergeabilityPrNumber(value: unknown): number {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new PrMergeabilityFetchError(`Invalid pull request number: ${String(value)}`);
  }
  return num;
}

/** Exact `gh pr view` argv for one PR under classification. */
export function prMergeabilityViewArgs(repo: string, prNumber: number): string[] {
  return [
    "pr",
    "view",
    String(requireMergeabilityPrNumber(prNumber)),
    "--repo",
    requireMergeabilityRepo(repo),
    "--json",
    PR_MERGEABILITY_GH_JSON_FIELDS,
  ];
}

/** Exact `gh pr list` argv used to discover open PRs when none were named. */
export function prMergeabilityListArgs(repo: string): string[] {
  return [
    "pr",
    "list",
    "--repo",
    requireMergeabilityRepo(repo),
    "--state",
    "open",
    "--json",
    "number",
  ];
}

/** Coerce one `gh` JSON object into a normalized record, or `null` when unusable. */
export function normalizePrMergeabilityRecord(raw: unknown): PrMergeabilityRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const prNumber = Number(row.number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  return {
    number: prNumber,
    state: text(row.state) ?? "UNKNOWN",
    mergeable: text(row.mergeable),
    mergeStateStatus: text(row.mergeStateStatus),
    baseRefName: text(row.baseRefName) ?? "",
  };
}

/**
 * Fetch mergeability records for `repo`, either for the named PRs or for every open PR.
 *
 * FNXC:PrMergeability 2026-10-12-03:20:
 * When no PRs are named, the discovery step lists open PR numbers and each number is then
 * re-read with `gh pr view --json <fields>`. It must NOT reuse `gh pr list`'s own
 * `mergeable`/`mergeStateStatus`: `gh pr list` derives those columns with its own
 * heuristics and they are not the per-PR `mergeable` verdict computed against that PR's
 * actual base. The two steps are therefore deliberately separate commands here.
 *
 * Fetches run sequentially so argv order — and therefore a recorded transcript — stays
 * deterministic.
 */
export async function fetchPrMergeabilityRecords(
  runGhJson: GhJsonRunner,
  options: { repo: string; prNumbers?: readonly number[]; cwd?: string; timeoutMs?: number },
): Promise<PrMergeabilityRecord[]> {
  const repo = requireMergeabilityRepo(options.repo);
  const runOptions = { cwd: options.cwd, timeoutMs: options.timeoutMs };

  let numbers: number[];
  if (options.prNumbers && options.prNumbers.length > 0) {
    numbers = [...new Set(options.prNumbers.map(requireMergeabilityPrNumber))].sort((a, b) => a - b);
  } else {
    const listed = await runGhJson(prMergeabilityListArgs(repo), runOptions);
    if (!Array.isArray(listed)) {
      throw new PrMergeabilityFetchError("gh pr list returned an unexpected shape");
    }
    numbers = listed
      .map((row) => Number((row as Record<string, unknown> | null)?.number))
      .filter((num) => Number.isInteger(num) && num > 0)
      .sort((a, b) => a - b);
  }

  const records: PrMergeabilityRecord[] = [];
  for (const prNumber of numbers) {
    const raw = await runGhJson(prMergeabilityViewArgs(repo, prNumber), runOptions);
    const record = normalizePrMergeabilityRecord(raw);
    /*
    FNXC:PrMergeability 2026-10-12-03:20:
    Non-OPEN records are filtered here rather than classified: a merged or closed PR is
    not waiting to be merged, and reporting one as a conflict would re-create the
    false-positive class this command exists to eliminate.
    */
    if (record && isEligibleRecord(record)) records.push(record);
  }
  return records;
}

/** Head-ref candidates a PR is reachable from offline, in priority order. No fetching. */
export function mergeTreeHeadRefCandidates(prNumber: number): string[] {
  const pr = requireMergeabilityPrNumber(prNumber);
  return [`refs/remotes/origin/pull/${pr}/head`, `refs/remotes/pr/${pr}`];
}

/**
 * Base-ref candidates for the PR's OWN base, in priority order: the remote-tracking ref
 * first (that is the ref GitHub computes mergeability against, and a local branch of the
 * same name can be stale), then a plain local branch of that name. Never a hardcoded
 * `main`.
 */
export function mergeTreeBaseRefCandidates(baseRefName: string): string[] {
  const base = typeof baseRefName === "string" ? baseRefName.trim() : "";
  if (base === "") return [];
  return base.startsWith("refs/") ? [base] : [`refs/remotes/origin/${base}`, base];
}

/**
 * Decode `git merge-tree --write-tree --name-only` output using the dashboard
 * precedent's exit-code semantics (`register-git-github.ts` `prRouteCommandRunner`):
 * exit 0 is clean, exit 1 is a REAL conflict, and any other code (128 bad ref, missing
 * binary) produced no verdict at all — stdout is non-empty in the clean case too, so it
 * is never read as a conflict signal.
 *
 * With `--name-only` the conflicted paths are the lines after the leading tree OID, up to
 * the first blank line. A count of `null` means "conflicting, but no path list was
 * parseable", which the receipt prints as `conflicted_files=unknown` rather than `0`.
 */
export function parseMergeTreeOutput(code: number, stdout: string): MergeTreeVerdict {
  if (code === 0) return { status: "MERGEABLE", conflictedFileCount: 0 };
  if (code !== 1) return { status: "UNAVAILABLE", conflictedFileCount: null, unavailableReason: "git-error" };

  const lines = String(stdout ?? "").split(/\r?\n/);
  const nameLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0 && /^[0-9a-f]{40,64}$/i.test(line.trim())) continue;
    if (line.trim() === "") break;
    nameLines.push(line.trim());
  }

  const conflicted = [...new Set(nameLines.filter((line) => line !== ""))];
  return {
    status: CONFLICTING,
    conflictedFileCount: conflicted.length > 0 ? conflicted.length : null,
  };
}

/**
 * Build an offline corroborating probe bound to one repository working directory.
 *
 * FNXC:PrMergeability 2026-10-12-03:20:
 * Resolution is verify-only: `git rev-parse --verify <ref>` decides whether a ref exists
 * locally and the probe NEVER auto-fetches — a scheduled job must not mutate the
 * repository, and an unfetched PR is simply `UNAVAILABLE("no-ref")`, which per the
 * classifier never counts as a disagreement. `UNAVAILABLE("git-error")` covers a 128
 * (bad ref) or a missing `git` binary.
 */
export function createMergeTreeProbe(
  runGit: MergeTreeGitRunner,
  options: { cwd?: string; timeoutMs?: number } = {},
): (record: PrMergeabilityRecord) => Promise<MergeTreeVerdict> {
  const resolveRef = async (ref: string): Promise<boolean> => {
    const result = await runGit(["rev-parse", "--verify", "--quiet", ref], options);
    return result.code === 0;
  };

  const resolveFirst = async (candidates: string[]): Promise<string | null> => {
    for (const candidate of candidates) {
      if (await resolveRef(candidate)) return candidate;
    }
    return null;
  };

  return async (record: PrMergeabilityRecord): Promise<MergeTreeVerdict> => {
    /*
    FNXC:PrMergeability 2026-10-12-03:20:
    An unresolvable head ref short-circuits before the base is even looked up: there is no
    merge to simulate without a head, and spending extra `git` calls on a doomed probe
    would make a scheduled sweep slower for a verdict it already knows.
    */
    const headRef = await resolveFirst(mergeTreeHeadRefCandidates(record.number));
    if (!headRef) {
      return { status: "UNAVAILABLE", conflictedFileCount: null, unavailableReason: "no-ref" };
    }
    const baseRef = await resolveFirst(mergeTreeBaseRefCandidates(record.baseRefName));
    if (!baseRef) {
      return { status: "UNAVAILABLE", conflictedFileCount: null, unavailableReason: "no-ref" };
    }

    const result = await runGit(
      ["merge-tree", "--write-tree", "--name-only", baseRef, headRef],
      options,
    );
    return parseMergeTreeOutput(result.code, result.stdout);
  };
}
