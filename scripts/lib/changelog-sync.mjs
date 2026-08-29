/*
 * FNXC:ReleaseChangelog 2026-07-21-20:22:
 * Root CHANGELOG.md is fully regenerated on every release from package changelogs.
 * Distillation only rewrites the current version, so without preservation prior
 * releases lose their user-facing Highlights/New/Fixed summary on the next sync.
 * Detect distilled bodies and re-emit them instead of the raw package aggregate.
 */

/** Category / highlights headings written by distill-release-notes. */
const DISTILLED_HEADING_RE =
  /^### (Highlights|New|Fixed|Breaking|Security|Performance|Internal)\b/m;

/** Raw package-aggregate sections always use `### @scope/name` package headings. */
const PACKAGE_HEADING_RE = /^### @[\w.-]+\//m;

/**
 * Parse a changeset-format CHANGELOG into { versions, order }.
 * Splits on top-level `## ` headings; the version key is the heading text
 * verbatim (e.g. "0.2.5", or "0.4.0 (pre-release, unpublished)").
 *
 * @param {string} raw
 * @returns {{ versions: Map<string, string>, order: string[] }}
 */
export function parseChangelog(raw) {
  const versions = new Map();
  const order = [];
  if (!raw) {
    return { versions, order };
  }
  // Strip out the first-line title and any horizontal rules so they don't
  // pollute the first version section.
  const stripped = raw.replace(/^# [^\n]*\n?/, "").replace(/^---\s*$/gm, "");
  const sections = stripped.split(/^## /m).slice(1); // drop pre-first-version preamble
  for (const section of sections) {
    const nl = section.indexOf("\n");
    const key = (nl === -1 ? section : section.slice(0, nl)).trim();
    const body = nl === -1 ? "" : section.slice(nl + 1).trim();
    if (!versions.has(key)) {
      versions.set(key, body);
      order.push(key);
    }
  }
  return { versions, order };
}

/**
 * Strip the archive pointer line that syncRootChangelog appends after the last
 * current-file version so it is not treated as part of that version's body.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripArchivePointerFromBody(body) {
  if (!body) return "";
  return body
    .replace(/\n*> Older releases \(before [^)]+\) are archived in \[[^\]]+\]\([^)]+\)\.?\s*$/m, "")
    .trim();
}

/**
 * True when a version section body is distilled end-user notes rather than the
 * raw per-package changeset aggregate produced by syncRootChangelog.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isDistilledChangelogBody(body) {
  const cleaned = stripArchivePointerFromBody(body);
  if (!cleaned) return false;
  // Raw aggregates always nest package sections under ### @scope/name.
  if (PACKAGE_HEADING_RE.test(cleaned)) return false;
  // Distilled notes use Highlights and/or category group headings.
  return DISTILLED_HEADING_RE.test(cleaned);
}

/**
 * Collect distilled version bodies from one or more existing root changelog files.
 * First-seen distilled body wins (call with current file before archive).
 *
 * @param {Array<string|null|undefined>} changelogContents
 * @returns {Map<string, string>} version key → distilled body markdown
 */
export function collectDistilledBodies(changelogContents = []) {
  const out = new Map();
  for (const content of changelogContents) {
    if (!content) continue;
    const { versions } = parseChangelog(content);
    for (const [version, body] of versions) {
      if (out.has(version)) continue;
      const cleaned = stripArchivePointerFromBody(body);
      if (isDistilledChangelogBody(cleaned)) {
        out.set(version, cleaned);
      }
    }
  }
  return out;
}

/**
 * Build root changelog lines for the given version order.
 * When a version has a preserved distilled body, emit that instead of the
 * per-package aggregate so prior releases keep their summarized view.
 *
 * @param {{
 *   title: string,
 *   banner: string,
 *   parsed: Array<{ pkgName: string, versions: Map<string, string> }>,
 *   versionOrder: string[],
 *   preservedBodies?: Map<string, string>,
 * }} opts
 * @returns {string[]}
 */
export function buildRootChangelogLines({
  title,
  banner,
  parsed,
  versionOrder,
  preservedBodies = new Map(),
}) {
  const lines = [title, "", banner, ""];

  for (const version of versionOrder) {
    lines.push(`## ${version}`, "");

    const preserved = preservedBodies.get(version);
    if (preserved && isDistilledChangelogBody(preserved)) {
      lines.push(preserved.trim(), "");
      continue;
    }

    // Sort packages alphabetically within a version for deterministic output.
    const pkgsForVersion = parsed
      .filter((p) => p.versions.has(version))
      .sort((a, b) => a.pkgName.localeCompare(b.pkgName));
    for (const p of pkgsForVersion) {
      const body = p.versions.get(version).trim();
      if (!body) continue;
      lines.push(`### ${p.pkgName}`, "");
      // Bump heading levels by one so package sub-sections nest cleanly.
      const bumped = body.replace(/^(#{1,5}) /gm, (_m, hashes) => `${hashes}# `);
      lines.push(bumped, "");
    }
  }

  return lines;
}

/**
 * Join changelog lines and collapse excessive blank lines.
 * @param {string[]} lines
 * @returns {string}
 */
export function normalizeChangelogLines(lines) {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
