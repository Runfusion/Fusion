import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface PyProjectMetadata {
  parsed: boolean;
  requiresPython?: string;
  optionalDependencies: string[];
  dependencyGroups: string[];
  defaultGroups?: string[] | "all";
  pythonDownloads?: string;
}

export type RequiresPythonResult = boolean | "undetermined";

export interface PythonInterpreterDiscovery {
  versions: string[];
  hasUnversioned: boolean;
}

export type UvInferenceDecision =
  | { kind: "run"; command: string; rationale: string }
  | { kind: "configuration-required" | "environment-incompatible"; command: string; refusedCommand: string; rationale: string };

const BARE_UV_COMMAND = "uv sync --frozen";

/*
FNXC:WorktreeDependencies 2026-09-10-16:38:
uv.lock alone cannot prove that a default sync selects a runnable, complete Python environment.
Read only root metadata and PATH directory entries: incompatible pinned/interpreter selections refuse
before spawning, while extras or non-default groups require explicit operator selection rather than guessing.
The decision order preserves unknown TOML and potentially uv-managed interpreters as runnable fallthroughs.
*/
function stripComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === "\\" && quote === '"' && !escaped) escaped = true;
      else if (character === quote && !escaped) quote = "";
      else escaped = false;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

function unquote(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return undefined;
}

/*
FNXC:WorktreeDependencies 2026-09-10-16:50:
Inline optional-dependency values contain package arrays with commas, so split only table entries at
zero nesting depth. A malformed inline table remains unreadable and fails open rather than hiding extras.
*/
function splitTopLevel(value: string): string[] | undefined {
  const parts: string[] = [];
  let quote = "";
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === "\\" && quote === '"' && !escaped) escaped = true;
      else if (character === quote && !escaped) quote = "";
      else escaped = false;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return undefined;
  parts.push(value.slice(start));
  return parts;
}

function keyNamesFromInlineTable(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const content = trimmed.slice(1, -1).trim();
  if (!content) return [];
  const entries = splitTopLevel(content);
  if (!entries) return undefined;
  const names: string[] = [];
  for (const part of entries) {
    const match = part.trim().match(/^([A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*=/);
    if (!match) return undefined;
    names.push(unquote(match[1]!) ?? match[1]!);
  }
  return names;
}

function stringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const values = [...trimmed.matchAll(/(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g)].map((match) => (match[1] ?? match[2] ?? "").replace(/\\(["'])/g, "$1"));
  return values.length || trimmed === "[]" ? values : undefined;
}

/** Parse only the pyproject fields used by deterministic uv inference; unknown syntax is fail-open. */
export function parsePyProjectMetadata(text: string): PyProjectMetadata {
  const result: PyProjectMetadata = { parsed: true, optionalDependencies: [], dependencyGroups: [] };
  let table = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]!).trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { table = header[1]!.trim(); continue; }
    if (/^\[\[/.test(line)) { table = "__array__"; continue; }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment || table === "__array__") { result.parsed = false; break; }
    const [, key, initial] = assignment;
    let value = initial!.trim();
    if (value.startsWith("[") && !value.includes("]")) {
      while (++index < lines.length && !value.includes("]")) value += ` ${stripComment(lines[index]!).trim()}`;
    }
    const string = unquote(value);
    const array = stringArray(value);
    if (table === "project" && key === "requires-python") {
      if (string === undefined) { result.parsed = false; break; }
      result.requiresPython = string;
    } else if (table === "project" && key === "optional-dependencies") {
      const names = keyNamesFromInlineTable(value); if (!names) { result.parsed = false; break; } result.optionalDependencies.push(...names);
    } else if (table === "project.optional-dependencies" || table === "dependency-groups") {
      result[table === "project.optional-dependencies" ? "optionalDependencies" : "dependencyGroups"].push(key!);
    } else if (table === "tool.uv" && key === "default-groups") {
      if (string === "all") result.defaultGroups = "all";
      else if (array) result.defaultGroups = array;
      else { result.parsed = false; break; }
    } else if (table === "tool.uv" && key === "python-downloads") {
      if (string === undefined) { result.parsed = false; break; }
      result.pythonDownloads = string;
    }
  }
  result.optionalDependencies = [...new Set(result.optionalDependencies)].sort();
  result.dependencyGroups = [...new Set(result.dependencyGroups)].sort();
  return result;
}

function releaseTuple(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+){0,2}$/.test(value)) return undefined;
  return value.split(".").map(Number);
}
function compare(left: number[], right: number[]): number { for (let index = 0; index < 3; index += 1) { const delta = (left[index] ?? 0) - (right[index] ?? 0); if (delta) return Math.sign(delta); } return 0; }

/** Evaluate the supported PEP 440 release-tuple subset without treating unsupported syntax as false. */
export function satisfiesRequiresPython(version: string, specifierSet: string): RequiresPythonResult {
  const actual = releaseTuple(version); if (!actual) return "undetermined";
  for (const raw of specifierSet.split(",")) {
    const match = raw.trim().match(/^(>=|<=|==|!=|~=|>|<)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/);
    if (!match || (match[3] && !["==", "!="].includes(match[1]!))) return "undetermined";
    const expected = releaseTuple(match[2]!); if (!expected) return "undetermined";
    const comparison = compare(actual, expected);
    const wildcard = Boolean(match[3]);
    const matches = wildcard ? actual.slice(0, expected.length).every((part, index) => part === expected[index]) : comparison === 0;
    /*
    FNXC:WorktreeDependencies 2026-09-10-16:50:
    PEP 440 compatible releases retain every release component except the last specified component.
    Thus ~=3.11 permits 3.12, while ~=3.11.4 remains within the 3.11 release line.
    */
    const compatiblePrefix = expected.slice(0, -1);
    const compatible = match[1] === ">=" ? comparison >= 0 : match[1] === ">" ? comparison > 0 : match[1] === "<=" ? comparison <= 0 : match[1] === "<" ? comparison < 0 : match[1] === "==" ? matches : match[1] === "!=" ? !matches : match[1] === "~=" && expected.length >= 2 ? comparison >= 0 && compatiblePrefix.every((part, index) => actual[index] === part) : "undetermined";
    if (compatible === "undetermined") return "undetermined";
    if (!compatible) return false;
  }
  return true;
}

/** Discover versioned Python launchers by bounded PATH listings; no interpreter is executed. */
export function discoverPythonInterpreterVersions(env: NodeJS.ProcessEnv): PythonInterpreterDiscovery {
  const path = env.PATH ?? env.Path ?? env.path ?? "";
  const versions = new Set<string>(); let hasUnversioned = false;
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try { for (const entry of readdirSync(directory)) {
      const plain = entry.replace(/\.(?:cmd|exe)$/i, "");
      const versioned = plain.match(/^python3\.(\d+)$/i);
      if (versioned) versions.add(`3.${versioned[1]}`);
      if (/^python3?$/i.test(plain)) hasUnversioned = true;
    } } catch { /* unreadable PATH entries are intentionally ignored */ }
  }
  return { versions: [...versions].sort((a, b) => compare(releaseTuple(a)!, releaseTuple(b)!)), hasUnversioned };
}

function downloadsDisabled(metadata: PyProjectMetadata, env: NodeJS.ProcessEnv): boolean {
  return metadata.pythonDownloads === "never" || ["never", "0", "false"].includes((env.UV_PYTHON_DOWNLOADS ?? "").toLowerCase());
}

export function analyzeUvDependencySelection(rootDir: string, env: NodeJS.ProcessEnv): UvInferenceDecision {
  const pyproject = join(rootDir, "pyproject.toml");
  let metadata: PyProjectMetadata;
  try { metadata = existsSync(pyproject) ? parsePyProjectMetadata(readFileSync(pyproject, "utf8")) : { parsed: false, optionalDependencies: [], dependencyGroups: [] }; } catch { metadata = { parsed: false, optionalDependencies: [], dependencyGroups: [] }; }
  if (!metadata.parsed) return { kind: "run", command: BARE_UV_COMMAND, rationale: "uv.lock was found and no readable project metadata was available; inferred uv sync --frozen." };
  const discovery = discoverPythonInterpreterVersions(env);
  const pinPath = join(rootDir, ".python-version");
  let pin: string | undefined;
  try { pin = existsSync(pinPath) ? readFileSync(pinPath, "utf8").trim().split(/\s+/, 1)[0] : undefined; } catch { /* no pin */ }
  if (metadata.requiresPython && pin) {
    const pinned = satisfiesRequiresPython(pin, metadata.requiresPython);
    if (pinned === false) return { kind: "environment-incompatible", command: BARE_UV_COMMAND, refusedCommand: BARE_UV_COMMAND, rationale: `.python-version pins ${pin}, which does not satisfy project.requires-python ${metadata.requiresPython}; Fusion declined inferred uv sync --frozen.` };
  }
  let fallback = "";
  const requiresPython = metadata.requiresPython;
  if (requiresPython) {
    const checks = discovery.versions.map((version) => [version, satisfiesRequiresPython(version, requiresPython)] as const);
    if (checks.length && checks.every(([, result]) => result === false) && !discovery.hasUnversioned && downloadsDisabled(metadata, env)) return { kind: "environment-incompatible", command: BARE_UV_COMMAND, refusedCommand: BARE_UV_COMMAND, rationale: `project.requires-python ${requiresPython} is incompatible with probed interpreters ${discovery.versions.join(", ")}; uv managed downloads are disabled, so Fusion declined inferred uv sync --frozen.` };
    if (checks.some(([, result]) => result === true)) fallback = ` A compatible interpreter (${checks.find(([, result]) => result === true)![0]}) was found.`;
    else if (checks.length && !downloadsDisabled(metadata, env)) fallback = " No probed interpreter satisfies the constraint, but uv may fetch a managed interpreter.";
  }
  const defaults = metadata.defaultGroups === "all" ? new Set(metadata.dependencyGroups) : new Set(metadata.defaultGroups ?? ["dev"]);
  const groups = metadata.dependencyGroups.filter((group) => !defaults.has(group));
  if (metadata.optionalDependencies.length || groups.length) {
    const selections = [...new Set([...metadata.optionalDependencies, ...groups])].sort();
    return { kind: "configuration-required", command: `${BARE_UV_COMMAND} --all-extras --all-groups`, refusedCommand: BARE_UV_COMMAND, rationale: `uv.lock was found; declared optional selections (${selections.join(", ")}) are ambiguous, so Fusion will not guess and declined ${BARE_UV_COMMAND}. Configure worktreeInitCommand or run an explicit extras/groups selection; re-running the bare command will not mark the worktree ready.` };
  }
  return { kind: "run", command: BARE_UV_COMMAND, rationale: `uv.lock was found; project metadata was read and the default dependency selection is unambiguous.${fallback} Inferred uv sync --frozen.` };
}

/** Whether a whitespace token explicitly selects uv extras or dependency groups. */
export function uvCommandSelectsOptionalDependencies(command: string): boolean {
  return command.trim().split(/\s+/).some((token) => /^(?:--extra|--all-extras|--only-extra|--group|--all-groups|--only-group|--no-default-groups)(?:=.+)?$/.test(token));
}
