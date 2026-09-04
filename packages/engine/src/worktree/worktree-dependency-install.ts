import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RunMutationContext, Settings, TaskStore } from "@fusion/core";
import {
  buildNonFrozenRetryCommand,
  getConfiguredWorktreeInitCommand,
  getDependencySyncCommand,
  isOutdatedLockfileError,
} from "../merge/merge-dependency-sync.js";
import { resolveWorktreePrivateGitDir } from "./worktree-paths.js";

export const DEPENDENCY_INSTALL_RECORD_FILENAME = "fusion-dependency-install.json";
export const DEPENDENCY_INSTALL_COMMAND_TIMEOUT_MS = 300_000;
export const DEPENDENCY_INSTALL_WORKTREE_BUDGET_MS = 600_000;

export type DependencyInstallOutcome =
  | "installed"
  | "not-needed"
  | "toolchain-missing"
  | "install-failed"
  | "budget-exhausted";

export type WorktreeDependencyReadinessValue =
  | "unresolved"
  | "unrecognized"
  | "satisfied"
  | "not-needed";

export interface DependencyPlanEntry {
  ecosystem: string;
  manifests: string[];
  command: string;
  binary?: string;
}

export interface DependencyInstallEntry {
  ecosystem: string;
  manifests: string[];
  command: string;
  outcome: DependencyInstallOutcome;
  fingerprint: string;
  reason?: string;
}

export interface DependencyInstallRecord {
  version: 1;
  completedAt: string;
  evidence: string[];
  entries: DependencyInstallEntry[];
}

export interface WorktreeDependencyReadiness {
  readiness: WorktreeDependencyReadinessValue;
  entries: DependencyInstallEntry[];
  plan: DependencyPlanEntry[];
  evidence: string[];
  /** Matrix rows which still need a deterministic retry or planner intervention. */
  unresolvedRepos: DependencyPlanEntry[];
}

export interface DependencyCommandResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  bufferExceeded?: boolean;
  timedOut?: boolean;
  spawnError?: string | Error;
}

export type DependencyCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<DependencyCommandResult>;

export interface EnsureWorktreeDependenciesOptions {
  worktreePath: string;
  settings?: Pick<Settings, "worktreeInitCommand"> | null;
  taskId: string;
  store: Pick<TaskStore, "logEntry">;
  runContext?: RunMutationContext;
  runConfiguredCommand?: DependencyCommandRunner;
  taskEnv?: NodeJS.ProcessEnv;
  logger?: { log?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
  signal?: AbortSignal;
  /**
   * The fresh-acquisition seam keeps the existing configured-init invocation in place and supplies
   * its observed result here so readiness records that exact engine execution without running it twice.
   */
  configuredInitResult?: DependencyCommandResult;
  /** Injectable clock keeps budget tests deterministic without changing production timing. */
  now?: () => number;
}

export interface PlannerDependencyResolutionInput {
  worktreePath: string;
  action: "install" | "none";
  command?: string;
  reason?: string;
  result?: DependencyCommandResult;
  settings?: Pick<Settings, "worktreeInitCommand"> | null;
}

const NAMED_UNRECOGNIZED_DEPENDENCY_EVIDENCE = new Set([
  "flake.nix",
  "shell.nix",
  "default.nix",
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  "conanfile.txt",
  "conanfile.py",
  "vcpkg.json",
  "stack.yaml",
  "cabal.project",
  "cpanfile",
  "renv.lock",
  "Project.toml",
  "build.zig.zon",
  "build.sbt",
  "deps.edn",
  "project.clj",
  "Podfile",
  "Cartfile",
  "environment.yml",
  "conda-lock.yml",
  "shard.yml",
  "rebar.config",
  "dub.json",
  "dub.sdl",
]);

/*
FNXC:WorktreeDependencies 2026-08-29-06:59:
Dependency readiness is deliberately root-level and bounded: a single root directory listing plus
named probes decide whether a worktree has dependency evidence. A repository with no evidence
spawns nothing and is `not-needed`; an out-of-matrix manifest is `unrecognized`, never silently
assumed dependency-free. Matrix rows run only after their toolchain resolves on PATH, while an
explicit worktreeInitCommand is authoritative, suppresses inference, clears unrecognised evidence
on success, and is itself recorded and gated. Acquisition logs failures but never parks a task;
Plan Review owns the bounded REVISE loop and escalates through its existing awaiting-approval path.
*/
const MATRIX_CONSUMED_FILENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "package.json",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "gradlew",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "Package.swift",
  "Package.resolved",
  "packages.lock.json",
  "gradle.lockfile",
]);

const GENERIC_UNRECOGNIZED_EVIDENCE = /(?:\.lock|\.lockb|-lock\.json|-lock\.yaml|\.cabal|\.nimble|\.opam|\.podspec|\.gemspec)$/i;

interface RootDependencyScan {
  plan: DependencyPlanEntry[];
  evidence: string[];
}

function rootEntries(rootDir: string): string[] {
  return readdirSync(rootDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function isRootRegularPath(rootDir: string, name: string, entries: ReadonlySet<string>): boolean {
  if (!entries.has(name)) return false;
  try {
    return statSync(join(rootDir, name)).isFile();
  } catch {
    return false;
  }
}

function manifestsPresent(rootDir: string, entries: ReadonlySet<string>, names: readonly string[]): string[] {
  return names.filter((name) => isRootRegularPath(rootDir, name, entries));
}

function commandBinary(command: string): string | undefined {
  const token = command.trim().split(/\s+/, 1)[0];
  return token || undefined;
}

function scanWorktreeDependencies(
  rootDir: string,
  settings?: Pick<Settings, "worktreeInitCommand"> | null,
  env: NodeJS.ProcessEnv = process.env,
): RootDependencyScan {
  const configuredCommand = getConfiguredWorktreeInitCommand(settings);
  if (configuredCommand) {
    return {
      plan: [{
        ecosystem: "configured-init-command",
        manifests: [],
        command: configuredCommand,
      }],
      evidence: [],
    };
  }

  const names = rootEntries(rootDir);
  const entries = new Set(names);
  const plan: DependencyPlanEntry[] = [];

  const nodeManifests = manifestsPresent(rootDir, entries, [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "package.json",
  ]);
  if (nodeManifests.length > 0) {
    const command = getDependencySyncCommand(rootDir, settings) ?? "npm install";
    plan.push({ ecosystem: "node", manifests: nodeManifests, command, binary: commandBinary(command) });
  }

  const add = (ecosystem: string, manifests: string[], command: string, binary?: string) => {
    if (manifests.length > 0) plan.push({ ecosystem, manifests, command, binary });
  };
  add("python-uv", manifestsPresent(rootDir, entries, ["uv.lock"]), "uv sync --frozen", "uv");
  add("python-poetry", manifestsPresent(rootDir, entries, ["poetry.lock"]), "poetry install --no-interaction", "poetry");
  add("python-pipenv", manifestsPresent(rootDir, entries, ["Pipfile.lock"]), "pipenv sync", "pipenv");
  add("python-pip", manifestsPresent(rootDir, entries, ["requirements.txt"]), "pip install -r requirements.txt", "pip");

  const cargoManifests = manifestsPresent(rootDir, entries, ["Cargo.toml", "Cargo.lock"]);
  if (cargoManifests.includes("Cargo.toml")) {
    add("rust", cargoManifests, cargoManifests.includes("Cargo.lock") ? "cargo fetch --locked" : "cargo fetch", "cargo");
  }
  const goManifests = manifestsPresent(rootDir, entries, ["go.mod", "go.sum"]);
  if (goManifests.includes("go.mod")) add("go", goManifests, "go mod download", "go");
  const composerManifests = manifestsPresent(rootDir, entries, ["composer.json", "composer.lock"]);
  if (composerManifests.includes("composer.json")) add("php", composerManifests, "composer install --no-interaction", "composer");
  const rubyManifests = manifestsPresent(rootDir, entries, ["Gemfile", "Gemfile.lock"]);
  if (rubyManifests.includes("Gemfile")) add("ruby", rubyManifests, "bundle install", "bundle");

  const dotnetManifests = names.filter((name) => /\.(?:sln|csproj|fsproj)$/i.test(name) && isRootRegularPath(rootDir, name, entries));
  add("dotnet", dotnetManifests, "dotnet restore", "dotnet");
  add("maven", manifestsPresent(rootDir, entries, ["pom.xml"]), "mvn -B -q dependency:go-offline", "mvn");
  add("gradle", manifestsPresent(rootDir, entries, ["gradlew"]), "./gradlew --no-daemon dependencies", "./gradlew");
  add("elixir", manifestsPresent(rootDir, entries, ["mix.exs", "mix.lock"]), "mix deps.get", "mix");

  const pubspecManifests = manifestsPresent(rootDir, entries, ["pubspec.yaml", "pubspec.lock"]);
  if (pubspecManifests.includes("pubspec.yaml")) {
    const flutter = isCommandAvailable("flutter", env);
    add("dart", pubspecManifests, flutter ? "flutter pub get" : "dart pub get", flutter ? "flutter" : "dart");
  }
  add("swift", manifestsPresent(rootDir, entries, ["Package.swift", "Package.resolved"]), "swift package resolve", "swift");

  const claimed = new Set(MATRIX_CONSUMED_FILENAMES);
  for (const item of plan) {
    for (const manifest of item.manifests) claimed.add(manifest);
  }
  const evidence = names.filter((name) => !claimed.has(name) && (
    NAMED_UNRECOGNIZED_DEPENDENCY_EVIDENCE.has(name) || GENERIC_UNRECOGNIZED_EVIDENCE.test(name)
  ));
  return { plan, evidence };
}

/** Detect the bounded, deterministic package-manager plan for a worktree root. */
export function detectWorktreeDependencyPlan(
  rootDir: string,
  settings?: Pick<Settings, "worktreeInitCommand"> | null,
): DependencyPlanEntry[] {
  return scanWorktreeDependencies(rootDir, settings).plan;
}

/** Detect root-level dependency evidence Fusion intentionally has no built-in command for. */
export function detectUnrecognizedDependencyEvidence(rootDir: string): string[] {
  return scanWorktreeDependencies(rootDir).evidence;
}

/**
 * Resolve a binary only through PATH probes. This deliberately does not spawn a shell, keeping the
 * no-evidence case cheap and ensuring a missing toolchain becomes durable readiness state instead.
 */
export function isCommandAvailable(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue || !binary.trim()) return false;
  const candidates = process.platform === "win32" && !/\.(?:cmd|exe)$/i.test(binary)
    ? [binary, `${binary}.cmd`, `${binary}.exe`]
    : [binary];
  return pathValue.split(delimiter).filter(Boolean).some((directory) =>
    candidates.some((candidate) => existsSync(join(directory, candidate))),
  );
}

function hashParts(parts: Iterable<readonly [string, string]>): string {
  const hash = createHash("sha256");
  for (const [name, value] of [...parts].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update("\0").update(value).update("\0");
  }
  return hash.digest("hex");
}

function fingerprintFiles(rootDir: string, names: readonly string[]): string {
  return hashParts(names.map((name) => {
    try {
      return [name, readFileSync(join(rootDir, name), "utf8")] as const;
    } catch {
      return [name, "<unreadable>"] as const;
    }
  }));
}

function planFingerprint(rootDir: string, plan: DependencyPlanEntry): string {
  return plan.ecosystem === "configured-init-command"
    ? hashParts([["configured-init-command", plan.command]])
    : fingerprintFiles(rootDir, plan.manifests);
}

export function dependencyEvidenceFingerprint(rootDir: string, evidence: readonly string[]): string {
  return fingerprintFiles(rootDir, evidence);
}

export function readDependencyInstallRecord(worktreePath: string): DependencyInstallRecord | null {
  const privateGitDir = resolveWorktreePrivateGitDir(worktreePath);
  if (!privateGitDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(privateGitDir, DEPENDENCY_INSTALL_RECORD_FILENAME), "utf8")) as Partial<DependencyInstallRecord>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.evidence)) return null;
    const entries = parsed.entries.filter((entry): entry is DependencyInstallEntry =>
      typeof entry === "object" && entry !== null
      && typeof entry.ecosystem === "string"
      && Array.isArray(entry.manifests)
      && typeof entry.command === "string"
      && typeof entry.outcome === "string"
      && typeof entry.fingerprint === "string",
    );
    return {
      version: 1,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : "",
      evidence: parsed.evidence.filter((entry): entry is string => typeof entry === "string"),
      entries,
    };
  } catch {
    return null;
  }
}

export function writeDependencyInstallRecord(worktreePath: string, record: DependencyInstallRecord): void {
  const privateGitDir = resolveWorktreePrivateGitDir(worktreePath);
  if (!privateGitDir) return;
  try {
    writeFileSync(join(privateGitDir, DEPENDENCY_INSTALL_RECORD_FILENAME), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // A missing or read-only private git directory only disables memoization; readiness still runs.
  }
}

function matchingEntry(
  record: DependencyInstallRecord | null | undefined,
  ecosystem: string,
  fingerprint: string,
): DependencyInstallEntry | undefined {
  return record?.entries.find((entry) => entry.ecosystem === ecosystem && entry.fingerprint === fingerprint);
}

function isSuccessful(entry: DependencyInstallEntry | undefined): boolean {
  return entry?.outcome === "installed";
}

function plannerCoversEvidence(record: DependencyInstallRecord | null | undefined, fingerprint: string): boolean {
  const planner = matchingEntry(record, "planner", fingerprint);
  return planner?.outcome === "installed" || planner?.outcome === "not-needed";
}

function configuredInitCoversEverything(
  record: DependencyInstallRecord | null | undefined,
  rootDir: string,
  plan: readonly DependencyPlanEntry[],
): boolean {
  const configured = plan.find((entry) => entry.ecosystem === "configured-init-command");
  return Boolean(configured && isSuccessful(matchingEntry(record, configured.ecosystem, planFingerprint(rootDir, configured))));
}

function resolveReadiness(
  worktreePath: string,
  plan: readonly DependencyPlanEntry[],
  evidence: readonly string[],
  record: DependencyInstallRecord | null | undefined,
): WorktreeDependencyReadiness {
  const unresolved = plan.filter((item) => !isSuccessful(matchingEntry(record, item.ecosystem, planFingerprint(worktreePath, item))));
  const entries = [
    ...plan.map((item) => matchingEntry(record, item.ecosystem, planFingerprint(worktreePath, item))).filter((entry): entry is DependencyInstallEntry => Boolean(entry)),
    ...(evidence.length > 0
      ? [matchingEntry(record, "planner", dependencyEvidenceFingerprint(worktreePath, evidence))].filter((entry): entry is DependencyInstallEntry => Boolean(entry))
      : []),
  ];
  if (unresolved.length > 0) {
    return { readiness: "unresolved", entries, plan: [...plan], evidence: [...evidence], unresolvedRepos: unresolved };
  }
  if (evidence.length > 0 && !configuredInitCoversEverything(record, worktreePath, plan) && !plannerCoversEvidence(record, dependencyEvidenceFingerprint(worktreePath, evidence))) {
    return { readiness: "unrecognized", entries, plan: [...plan], evidence: [...evidence], unresolvedRepos: [] };
  }
  if (plan.length === 0 && evidence.length === 0) {
    return { readiness: "not-needed", entries, plan: [], evidence: [], unresolvedRepos: [] };
  }
  return { readiness: "satisfied", entries, plan: [...plan], evidence: [...evidence], unresolvedRepos: [] };
}

/** Collapse one durable record to the four readiness values. Callers must not re-derive this policy. */
export function resolveWorktreeDependencyReadiness(
  worktreePath: string,
  plan: readonly DependencyPlanEntry[],
  evidence: readonly string[],
): WorktreeDependencyReadiness {
  return resolveReadiness(worktreePath, plan, evidence, readDependencyInstallRecord(worktreePath));
}

function makeRecord(previous: DependencyInstallRecord | null, evidence: readonly string[]): DependencyInstallRecord {
  return {
    version: 1,
    completedAt: new Date().toISOString(),
    evidence: [...evidence],
    entries: [...(previous?.entries ?? [])],
  };
}

function upsertEntry(record: DependencyInstallRecord, entry: DependencyInstallEntry): void {
  record.entries = record.entries.filter((candidate) => candidate.ecosystem !== entry.ecosystem);
  record.entries.push(entry);
  record.completedAt = new Date().toISOString();
}

function commandSucceeded(result: DependencyCommandResult | undefined): boolean {
  return Boolean(result && !result.spawnError && !result.timedOut && result.exitCode === 0);
}

function commandFailureReason(result: DependencyCommandResult | undefined): string {
  if (!result) return "No engine-observed command result";
  if (result.spawnError) return typeof result.spawnError === "string" ? result.spawnError : result.spawnError.message;
  if (result.timedOut) return "Command timed out";
  if (result.exitCode !== 0) return `Command exited with code ${result.exitCode ?? "unknown"}`;
  return "Command did not produce a successful exit code";
}

function commandDetails(result: DependencyCommandResult): string {
  const spawnError = typeof result.spawnError === "string" ? result.spawnError : result.spawnError?.message ?? "";
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}\n${spawnError}`;
}

function tail(value: string, max = 1_000): string {
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

async function logDependencyEvent(
  options: EnsureWorktreeDependenciesOptions,
  action: string,
  outcome?: string,
): Promise<void> {
  try {
    await options.store.logEntry(options.taskId, action, outcome, options.runContext);
  } catch {
    // Dependency installation is observable but task-log availability must not turn acquisition fatal.
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Dependency installation aborted");
  error.name = "AbortError";
  throw error;
}

async function runPlanCommand(
  options: EnsureWorktreeDependenciesOptions,
  entry: DependencyPlanEntry,
  command: string,
): Promise<DependencyCommandResult | undefined> {
  if (!options.runConfiguredCommand) return undefined;
  throwIfAborted(options.signal);
  const startedAt = Date.now();
  let result: DependencyCommandResult;
  try {
    result = await options.runConfiguredCommand(
      command,
      options.worktreePath,
      DEPENDENCY_INSTALL_COMMAND_TIMEOUT_MS,
      options.taskEnv,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    result = {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      bufferExceeded: false,
      timedOut: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const durationMs = Date.now() - startedAt;
  const success = commandSucceeded(result);
  await logDependencyEvent(
    options,
    `Worktree dependency install [${entry.ecosystem}] ${success ? "completed" : "failed"} in ${durationMs}ms`,
    `${command}${success ? "" : `\n${tail(commandFailureReason(result))}`}`,
  );
  return result;
}

function entryForPlan(
  worktreePath: string,
  plan: DependencyPlanEntry,
  outcome: DependencyInstallOutcome,
  options: { command?: string; reason?: string } = {},
): DependencyInstallEntry {
  return {
    ecosystem: plan.ecosystem,
    manifests: [...plan.manifests],
    command: options.command ?? plan.command,
    outcome,
    fingerprint: planFingerprint(worktreePath, plan),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

/**
 * Execute the deterministic rows once, persist their engine-observed outcomes, and return the
 * shared readiness projection. Failures deliberately resolve as readiness rather than throwing so
 * acquisition can continue and the Plan Review gate is the only lifecycle blocker.
 */
export async function ensureWorktreeDependencies(
  options: EnsureWorktreeDependenciesOptions,
): Promise<WorktreeDependencyReadiness> {
  const env = options.taskEnv ?? process.env;
  const scan = scanWorktreeDependencies(options.worktreePath, options.settings, env);
  const record = makeRecord(readDependencyInstallRecord(options.worktreePath), scan.evidence);
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (let index = 0; index < scan.plan.length; index += 1) {
    const plan = scan.plan[index]!;
    const fingerprint = planFingerprint(options.worktreePath, plan);
    const previous = matchingEntry(record, plan.ecosystem, fingerprint);
    if (previous?.outcome === "installed") continue;

    if (plan.ecosystem === "configured-init-command" && options.configuredInitResult) {
      upsertEntry(record, entryForPlan(
        options.worktreePath,
        plan,
        commandSucceeded(options.configuredInitResult) ? "installed" : "install-failed",
        { reason: commandSucceeded(options.configuredInitResult) ? undefined : commandFailureReason(options.configuredInitResult) },
      ));
      continue;
    }

    if (now() - startedAt >= DEPENDENCY_INSTALL_WORKTREE_BUDGET_MS) {
      for (const remaining of scan.plan.slice(index)) {
        upsertEntry(record, entryForPlan(options.worktreePath, remaining, "budget-exhausted", { reason: "Per-worktree dependency-install budget exhausted" }));
      }
      break;
    }

    const binaryAvailable = plan.binary === "./gradlew"
      ? existsSync(join(options.worktreePath, "gradlew"))
      : plan.binary === undefined || isCommandAvailable(plan.binary, env);
    if (!binaryAvailable) {
      const reason = plan.binary ? `Required toolchain is not available on PATH: ${plan.binary}` : "No engine command runner is available";
      upsertEntry(record, entryForPlan(options.worktreePath, plan, "toolchain-missing", { reason }));
      await logDependencyEvent(options, `Worktree dependency install [${plan.ecosystem}] not started`, reason);
      continue;
    }
    if (!options.runConfiguredCommand) {
      const reason = "No engine command runner is available";
      upsertEntry(record, entryForPlan(options.worktreePath, plan, "toolchain-missing", { reason }));
      await logDependencyEvent(options, `Worktree dependency install [${plan.ecosystem}] not started`, reason);
      continue;
    }

    const result = await runPlanCommand(options, plan, plan.command);
    if (commandSucceeded(result)) {
      upsertEntry(record, entryForPlan(options.worktreePath, plan, "installed"));
      continue;
    }

    const retryCommand = plan.ecosystem === "node" && result && isOutdatedLockfileError(commandDetails(result))
      ? buildNonFrozenRetryCommand(plan.command)
      : null;
    if (retryCommand) {
      const retryResult = await runPlanCommand(options, plan, retryCommand);
      if (commandSucceeded(retryResult)) {
        upsertEntry(record, entryForPlan(options.worktreePath, plan, "installed", {
          command: retryCommand,
          reason: `Retried after frozen-lockfile refusal from ${plan.command}`,
        }));
        continue;
      }
      upsertEntry(record, entryForPlan(options.worktreePath, plan, "install-failed", {
        command: retryCommand,
        reason: commandFailureReason(retryResult),
      }));
      continue;
    }
    upsertEntry(record, entryForPlan(options.worktreePath, plan, "install-failed", { reason: commandFailureReason(result) }));
  }

  const readiness = resolveReadiness(options.worktreePath, scan.plan, scan.evidence, record);
  writeDependencyInstallRecord(options.worktreePath, record);
  if (readiness.readiness === "unrecognized") {
    await logDependencyEvent(
      options,
      "Worktree dependency evidence has no built-in installer",
      scan.evidence.join(", "),
    );
  }
  return readiness;
}

/**
 * Persist the planning tool's resolution. `installed` is intentionally accepted only from the
 * engine's command result, never from planner prose or an unverified tool response.
 */
export function recordPlannerDependencyResolution(
  input: PlannerDependencyResolutionInput,
): WorktreeDependencyReadiness {
  const scan = scanWorktreeDependencies(input.worktreePath, input.settings);
  const record = makeRecord(readDependencyInstallRecord(input.worktreePath), scan.evidence);
  const evidenceFingerprint = dependencyEvidenceFingerprint(input.worktreePath, scan.evidence);
  const reason = input.reason?.trim();
  if (input.action === "none" && !reason) {
    throw new Error("A reason is required when recording no dependency install step");
  }
  if (input.action === "install" && !input.command?.trim()) {
    throw new Error("A command is required when installing worktree dependencies");
  }

  const installed = input.action === "install" && commandSucceeded(input.result);
  const outcome: DependencyInstallOutcome = input.action === "none"
    ? "not-needed"
    : installed
      ? "installed"
      : "install-failed";
  upsertEntry(record, {
    ecosystem: "planner",
    manifests: [...scan.evidence],
    command: input.command?.trim() ?? "",
    outcome,
    fingerprint: evidenceFingerprint,
    ...(reason ? { reason } : outcome === "install-failed" ? { reason: commandFailureReason(input.result) } : {}),
  });

  // A planner may re-run a known matrix command after installing its missing toolchain. Only an
  // exact engine-observed successful command can close that matrix row; arbitrary prose cannot.
  if (installed && input.command) {
    for (const plan of scan.plan) {
      if (plan.ecosystem !== "configured-init-command" && plan.command.trim() === input.command.trim()) {
        upsertEntry(record, entryForPlan(input.worktreePath, plan, "installed", { command: input.command.trim() }));
      }
    }
  }

  writeDependencyInstallRecord(input.worktreePath, record);
  return resolveReadiness(input.worktreePath, scan.plan, scan.evidence, record);
}
