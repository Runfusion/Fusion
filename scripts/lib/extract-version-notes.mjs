/**
 * Extract the changelog section for a specific version from the root CHANGELOG.md content.
 * @param {string} content - Full CHANGELOG.md content (as formatted by syncRootChangelog)
 * @param {string} version - Bare version string (e.g. "0.16.0"), NOT "v"-prefixed
 * @returns {string} Release notes body, or a fallback like "Release v{version}" if not found
 */
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

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      endIndex = i;
      break;
    }
  }

  const body = lines.slice(startIndex + 1, endIndex).join("\n").trim();
  return body || fallback;
}

/**
 * Replace the changelog section for a specific version with new content.
 *
 * FNXC:Changelog 2026-06-24-16:00:
 * After syncRootChangelog aggregates per-package CHANGELOGs into the root
 * CHANGELOG, the distilled end-user notes replace the raw per-package
 * aggregate for the current version. Historical versions are preserved.
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

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      endIndex = i;
      break;
    }
  }

  const before = lines.slice(0, startIndex + 1);
  const after = lines.slice(endIndex);

  return [...before, "", newBody.trim(), "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}
