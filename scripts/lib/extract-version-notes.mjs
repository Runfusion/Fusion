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
