/**
 * Extract the changelog section for a specific version from the root CHANGELOG.md content.
 * @param {string} content - Full CHANGELOG.md content (as formatted by syncRootChangelog)
 * @param {string} version - Bare version string (e.g. "0.16.0"), NOT "v"-prefixed
 * @returns {string} Release notes body, or a fallback like "Release v{version}" if not found
 */

/*
 * FNXC:Changelog 2026-07-21-20:22:
 * The archive pointer after the last version is file-level trailing content, not part of
 * any release body. extract/replace must leave it outside the section so distilling or
 * restoring the oldest current version does not drop the pointer to CHANGELOG-archive.md.
 */
const ARCHIVE_POINTER_RE =
  /^> Older releases \(before [^)]+\) are archived in \[[^\]]+\]\([^)]+\)\.?\s*$/;

/**
 * Find the exclusive end index of a version section starting at startIndex.
 * Stops at the next ## heading, or before a trailing archive-pointer block at EOF.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {number}
 */
function findVersionSectionEnd(lines, startIndex) {
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      endIndex = i;
      break;
    }
  }

  // Peel trailing blank lines + archive pointer off the last section only.
  if (endIndex === lines.length) {
    let trimAt = endIndex;
    while (trimAt > startIndex + 1 && lines[trimAt - 1].trim() === "") {
      trimAt -= 1;
    }
    if (trimAt > startIndex + 1 && ARCHIVE_POINTER_RE.test(lines[trimAt - 1].trim())) {
      trimAt -= 1;
      while (trimAt > startIndex + 1 && lines[trimAt - 1].trim() === "") {
        trimAt -= 1;
      }
      endIndex = trimAt;
    }
  }

  return endIndex;
}

export function extractVersionNotes(content, version) {
  const fallback = `Release v${version}`;

  if (!content || !version) {
    return fallback;
  }

  const lines = content.split(/\r?\n/);
  const header = `## ${version}`;
  const startIndex = lines.findIndex((line) => line.trim() === header);

  if (startIndex === -1) {
    return fallback;
  }

  const endIndex = findVersionSectionEnd(lines, startIndex);
  const body = lines.slice(startIndex + 1, endIndex).join("\n").trim();
  return body || fallback;
}

/**
 * Replace the changelog section for a specific version with new content.
 *
 * FNXC:Changelog 2026-06-24-16:00:
 * After syncRootChangelog aggregates per-package CHANGELOGs into the root
 * CHANGELOG, the distilled end-user notes replace the raw per-package
 * aggregate for the current version.
 *
 * FNXC:Changelog 2026-07-21-20:22:
 * Cross-release historical preservation is handled by syncRootChangelog
 * (scripts/lib/changelog-sync.mjs): it re-emits already-distilled bodies from
 * the existing root CHANGELOG so prior releases keep their summarized view.
 * This helper only rewrites one version in-place during a single distill step.
 * Trailing archive-pointer content after the last version is preserved.
 *
 * @param {string} content - Full CHANGELOG.md content
 * @param {string} version - Bare version string (e.g. "0.47.0")
 * @param {string} newBody - New markdown body for the version section
 * @returns {string} Updated CHANGELOG.md content, or original if version not found
 */
export function replaceVersionSection(content, version, newBody) {
  if (!content || !version) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const header = `## ${version}`;
  const startIndex = lines.findIndex((line) => line.trim() === header);

  if (startIndex === -1) {
    return content;
  }

  const endIndex = findVersionSectionEnd(lines, startIndex);
  const before = lines.slice(0, startIndex + 1);
  const after = lines.slice(endIndex);

  return [...before, "", newBody.trim(), "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}
