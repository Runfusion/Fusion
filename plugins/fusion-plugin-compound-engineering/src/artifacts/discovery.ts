import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { listStages } from "../session/stage-registry.js";

/**
 * CE artifact discovery (U3).
 *
 * Scans a fixed allowlist of conventional CE artifact locations relative to a
 * project root and returns artifacts grouped by stage. The allowlist is the
 * ONLY filesystem surface this module touches — it never recurses outside a
 * conventional location and never reads a file that does not live under one of
 * them. An artifact that cannot be read or is malformed is represented as an
 * `error` entry rather than crashing the scan or being silently dropped.
 *
 * Stage locations come from the registry. Solutions and Concepts remain
 * explicit knowledge collections because they are not interactive stages.
 */

export type CeArtifactStage =
  | "strategy"
  | "ideate"
  | "plan"
  | "work"
  | "debug"
  | "solution"
  | "concepts"
  | (string & {});

/** Whether a conventional location is a single file or a directory of files. */
type LocationKind = "file" | "directory";

interface ConventionalLocation {
  stage: CeArtifactStage;
  /** Human label for the stage group. */
  label: string;
  /** Project-root-relative path. */
  path: string;
  kind: LocationKind;
}

/**
 * The conventional CE artifact locations. This is the discovery allowlist — the
 * scanner reads ONLY these paths (and, for directories, their immediate `.md`
 * children). Nothing outside this list is opened.
 */
/*
FNXC:CompoundEngineeringArtifacts 2026-07-10-12:00:
The artifact hub must follow registered stage output locations so Work and Debug remain discoverable as the pipeline evolves.

FNXC:CompoundEngineeringArtifacts 2026-07-10-23:40:
The upstream Compound Engineering workflow writes repeatable requirements documents to docs/brainstorms and implementation plans to docs/plans. Discovery must retain the dedicated requirements history while also supporting requirements-only unified plans produced by newer in-place handoffs.
*/
function stageLocations(): ConventionalLocation[] {
  return listStages().filter((definition) => definition.stageId !== "brainstorm").map((definition) => {
    const path = definition.artifactLocation.replace(/\/$/, "");
    return {
      stage: definition.stageId,
      label: definition.label,
      path,
      kind: definition.artifactLocation.endsWith("/") ? "directory" : "file",
    };
  });
}

function conventionalLocations(): ConventionalLocation[] {
  return [
    ...stageLocations(),
    { stage: "brainstorm", label: "Brainstorms", path: "docs/brainstorms", kind: "directory" },
    { stage: "solution", label: "Solutions", path: "docs/solutions", kind: "directory" },
    { stage: "concepts", label: "Concepts", path: "CONCEPTS.md", kind: "file" },
  ];
}

export const CONVENTIONAL_LOCATIONS: readonly ConventionalLocation[] = conventionalLocations();

/** A discovered, readable artifact. */
export interface CeArtifact {
  /** Stable id: `${stage}:${relativePath}`. Safe to use as a route param after encoding. */
  id: string;
  stage: CeArtifactStage;
  /** Project-root-relative path with forward slashes. */
  path: string;
  /** Filename (basename). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified epoch ms — used for `(stage, updatedAt DESC)` ordering. */
  updatedAt: number;
  /** Unified CE plan artifact contract from leading YAML frontmatter, when present. */
  artifactContract?: string | null;
  /** Readiness classification from leading YAML frontmatter, when present. */
  artifactReadiness?: "requirements-only" | "implementation-ready" | string | null;
  /** Stage/skill that authored the product contract, when present. */
  productContractSource?: string | null;
  /** Discriminator. */
  kind: "artifact";
}

/** An artifact location that exists but could not be read / was malformed. */
export interface CeArtifactError {
  id: string;
  stage: CeArtifactStage;
  path: string;
  name: string;
  /** Discriminator. */
  kind: "error";
  /** Human-readable reason the artifact could not be surfaced. */
  error: string;
}

export type CeArtifactEntry = CeArtifact | CeArtifactError;

/** Artifacts (and error entries) grouped by stage. */
export interface CeArtifactGroup {
  stage: CeArtifactStage;
  label: string;
  /** True when the conventional location for this stage exists on disk. */
  present: boolean;
  /** Entries, ordered by `updatedAt DESC` (errors sort last, keyed by name). */
  entries: CeArtifactEntry[];
}

export interface DiscoveryResult {
  groups: CeArtifactGroup[];
  /** Convenience flags for the hub's empty / partial states. */
  totalArtifacts: number;
  totalErrors: number;
}

const MAX_ARTIFACT_BYTES = 2_000_000;
const FRONTMATTER_PREFIX_BYTES = 8 * 1024;

interface ArtifactMetadata {
  artifactContract: string | null;
  artifactReadiness: "requirements-only" | "implementation-ready" | string | null;
  productContractSource: string | null;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Guard: a resolved path must stay within the project root AND under the
 * specific conventional location it was discovered through. This is the
 * concrete enforcement of "do not read outside the conventional locations".
 */
function isWithin(root: string, locationAbs: string, candidate: string): boolean {
  const relToLocation = relative(locationAbs, candidate);
  if (relToLocation.startsWith("..") || isAbsolute(relToLocation)) return false;
  const relToRoot = relative(root, candidate);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) return false;
  return true;
}

function makeId(stage: CeArtifactStage, relPath: string): string {
  return `${stage}:${relPath}`;
}

/**
 * FNXC:CompoundEngineering 2026-06-27-00:58:
 * Artifact discovery must reject symlink escape hatches, not only syntactic ../ traversal. Resolve the project root, conventional location, and candidate after lstat-based symlink rejection so list/read paths cannot follow docs/plans/*.md or conventional-directory symlinks outside the allowlist.
 */
function isRealPathWithin(root: string, locationAbs: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realLocation = realpathSync(locationAbs);
    const realCandidate = realpathSync(candidate);
    return isWithin(realRoot, realLocation, realCandidate);
  } catch {
    return false;
  }
}

function symlinkError(stage: CeArtifactStage, relPath: string): CeArtifactError {
  return makeError(stage, relPath, "Symlink artifacts are not allowed in CE discovery");
}

/** Build a uniform `error` entry, deriving `id`/`name` from `(stage, relPath)`. */
function makeError(stage: CeArtifactStage, relPath: string, message: string): CeArtifactError {
  return {
    id: makeId(stage, relPath),
    stage,
    path: relPath,
    name: relPath.split("/").pop() ?? relPath,
    kind: "error",
    error: message,
  };
}

function emptyMetadata(): ArtifactMetadata {
  return { artifactContract: null, artifactReadiness: null, productContractSource: null };
}

function cleanYamlScalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const commentStart = trimmed.indexOf(" #");
  const withoutComment = commentStart >= 0 ? trimmed.slice(0, commentStart).trim() : trimmed;
  return withoutComment.replace(/^['\"]|['\"]$/g, "") || null;
}

/**
 * FNXC:CompoundEngineering 2026-06-27-00:31:
 * CE v3.15.0 unified brainstorm/plan artifacts communicate their handoff state via small leading YAML frontmatter. Discovery reads only a bounded prefix so hub list scans can distinguish requirements-only from implementation-ready plans without turning artifact listing into full-file parsing or expanding the allowlisted filesystem surface.
 */
function parseArtifactMetadata(prefix: string): ArtifactMetadata {
  const metadata = emptyMetadata();
  if (!prefix.startsWith("---")) return metadata;
  const end = prefix.indexOf("\n---", 3);
  if (end < 0) return metadata;
  const frontmatter = prefix.slice(3, end).split(/\r?\n/);
  for (const line of frontmatter) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = cleanYamlScalar(match[2]);
    if (match[1] === "artifact_contract") metadata.artifactContract = value;
    if (match[1] === "artifact_readiness") metadata.artifactReadiness = value;
    if (match[1] === "product_contract_source") metadata.productContractSource = value;
  }
  return metadata;
}

function readMetadataPrefix(abs: string, size: number): ArtifactMetadata {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const buffer = Buffer.alloc(Math.min(size, FRONTMATTER_PREFIX_BYTES));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return parseArtifactMetadata(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return emptyMetadata();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures; metadata is best-effort and access/stat already gate readability.
      }
    }
  }
}

function readArtifactEntry(
  stage: CeArtifactStage,
  root: string,
  locationAbs: string,
  abs: string,
  relPath: string,
): CeArtifactEntry {
  const name = relPath.split("/").pop() ?? relPath;
  // Defense in depth: refuse anything that escaped the conventional location.
  if (!isWithin(root, locationAbs, abs)) {
    return makeError(stage, relPath, "Path is outside its conventional location");
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return symlinkError(stage, relPath);
    if (!isRealPathWithin(root, locationAbs, abs)) {
      return makeError(stage, relPath, "Path is outside its conventional location");
    }
    if (st.size > MAX_ARTIFACT_BYTES) {
      return makeError(stage, relPath, `Artifact too large to read (${st.size} bytes)`);
    }
    // Probe READ PERMISSION only (no bytes transferred) so an unreadable file is
    // surfaced now as an error entry rather than crashing later at render time.
    // NOTE: this is a permission probe, NOT a content check — malformed/corrupt
    // file CONTENT is only detected at read time (readCeArtifact), not here.
    accessSync(abs, constants.R_OK);
    const metadata = readMetadataPrefix(abs, st.size);
    return {
      id: makeId(stage, relPath),
      stage,
      path: relPath,
      name,
      size: st.size,
      updatedAt: st.mtimeMs,
      ...metadata,
      kind: "artifact",
    };
  } catch (err) {
    return makeError(stage, relPath, err instanceof Error ? err.message : String(err));
  }
}

function sortEntries(entries: CeArtifactEntry[]): CeArtifactEntry[] {
  // Composite ordering analogue: artifacts by updatedAt DESC; errors last,
  // stable by name. (See docs/performance/dashboard-load.md — the persisted
  // equivalent is a `(type, updatedAt DESC)` index.)
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "artifact" ? -1 : 1;
    if (a.kind === "artifact" && b.kind === "artifact") return b.updatedAt - a.updatedAt;
    return a.name.localeCompare(b.name);
  });
}

function discoverLocation(root: string, loc: ConventionalLocation): CeArtifactGroup {
  const locationAbs = join(root, loc.path);
  const entries: CeArtifactEntry[] = [];
  let present = false;

  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(locationAbs);
    present = true;
  } catch {
    // Location simply does not exist — an empty (but valid) category.
    return { stage: loc.stage, label: loc.label, present: false, entries: [] };
  }

  if (loc.kind === "file") {
    if (st.isSymbolicLink()) {
      entries.push(symlinkError(loc.stage, toPosix(loc.path)));
    } else if (!isRealPathWithin(root, locationAbs, locationAbs)) {
      entries.push(makeError(loc.stage, toPosix(loc.path), "Path is outside its conventional location"));
    } else if (st.isFile()) {
      entries.push(readArtifactEntry(loc.stage, root, locationAbs, locationAbs, toPosix(loc.path)));
    } else {
      // A conventional file path that is actually a directory is malformed.
      entries.push(
        makeError(
          loc.stage,
          toPosix(loc.path),
          "Expected a file at the conventional location but found a directory",
        ),
      );
    }
    return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
  }

  // Directory location: read ONLY immediate children, only Markdown files.
  // Non-recursive on purpose — we never descend into unrelated subtrees.
  let names: string[] = [];
  try {
    if (st.isSymbolicLink()) {
      entries.push(symlinkError(loc.stage, toPosix(loc.path)));
      return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
    }
    if (!isRealPathWithin(root, locationAbs, locationAbs)) {
      entries.push(makeError(loc.stage, toPosix(loc.path), "Path is outside its conventional location"));
      return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
    }
    if (!st.isDirectory()) {
      entries.push(
        makeError(
          loc.stage,
          toPosix(loc.path),
          "Expected a directory at the conventional location but found a file",
        ),
      );
      return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
    }
    names = readdirSync(locationAbs);
  } catch (err) {
    entries.push(makeError(loc.stage, toPosix(loc.path), err instanceof Error ? err.message : String(err)));
    return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
  }

  for (const childName of names) {
    // Ignore unrelated files: only Markdown artifacts count. Dotfiles and any
    // non-.md file are skipped outright (not read).
    if (childName.startsWith(".")) continue;
    if (!childName.toLowerCase().endsWith(".md")) continue;
    const abs = join(locationAbs, childName);
    const relPath = toPosix(join(loc.path, childName));
    // Skip nested directories named *.md — only regular files are artifacts.
    let childStat: ReturnType<typeof lstatSync>;
    try {
      childStat = lstatSync(abs);
    } catch (err) {
      entries.push(makeError(loc.stage, relPath, err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (childStat.isSymbolicLink()) {
      entries.push(symlinkError(loc.stage, relPath));
      continue;
    }
    if (!childStat.isFile()) continue;
    entries.push(readArtifactEntry(loc.stage, root, locationAbs, abs, relPath));
  }

  return { stage: loc.stage, label: loc.label, present, entries: sortEntries(entries) };
}

/**
 * Discover CE artifacts under `projectRoot`, grouped by stage. Never throws for
 * per-artifact problems — those become `error` entries. Always returns one
 * group per conventional location (empty groups included so the hub can render
 * a partial-discovery state).
 */
export function discoverArtifacts(projectRoot: string): DiscoveryResult {
  const root = projectRoot;
  const groups = conventionalLocations().map((loc) => discoverLocation(root, loc));
  let totalArtifacts = 0;
  let totalErrors = 0;
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.kind === "artifact") totalArtifacts += 1;
      else totalErrors += 1;
    }
  }
  return { groups, totalArtifacts, totalErrors };
}

/**
 * Resolve a single artifact by its `stage:relativePath` id and return its raw
 * content. Re-validates the path against the conventional-location allowlist so
 * a forged id can never read an arbitrary file. Returns `undefined` if the id
 * does not map to a known conventional location or the file is missing.
 */
export function readArtifactById(
  projectRoot: string,
  id: string,
): { artifact: CeArtifact; content: string } | { error: string } | undefined {
  const sepIdx = id.indexOf(":");
  if (sepIdx <= 0) return undefined;
  const stage = id.slice(0, sepIdx) as CeArtifactStage;
  const relPath = id.slice(sepIdx + 1);
  const loc = conventionalLocations().find((l) => l.stage === stage);
  if (!loc) return undefined;

  const locationAbs = join(projectRoot, loc.path);
  const abs = join(projectRoot, relPath);

  // The requested path must live under the stage's conventional location.
  // For file locations, the path must equal the location itself.
  if (loc.kind === "file") {
    if (toPosix(relPath) !== toPosix(loc.path)) return undefined;
  } else if (!isWithin(projectRoot, locationAbs, abs)) {
    return undefined;
  }
  // Directory artifacts must be immediate Markdown children.
  if (loc.kind === "directory") {
    const rel = relative(locationAbs, abs);
    if (rel.includes(sep) || rel.startsWith("..") || !rel.toLowerCase().endsWith(".md")) {
      return undefined;
    }
  }

  let content: string;
  let mtimeMs: number;
  let size: number;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return { error: "Symlink artifacts are not allowed in CE discovery" };
    if (!isRealPathWithin(projectRoot, locationAbs, abs)) return undefined;
    if (!st.isFile()) return { error: "Artifact is not a readable file" };
    if (st.size > MAX_ARTIFACT_BYTES) return { error: `Artifact too large to read (${st.size} bytes)` };
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    // A missing file is "not found" (404), not a malformed-artifact error (422).
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const name = relPath.split("/").pop() ?? relPath;
  return {
    artifact: {
      id,
      stage,
      path: toPosix(relPath),
      name,
      size,
      updatedAt: mtimeMs,
      ...parseArtifactMetadata(content.slice(0, FRONTMATTER_PREFIX_BYTES)),
      kind: "artifact",
    },
    content,
  };
}
