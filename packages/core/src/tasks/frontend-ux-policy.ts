/**
 * Frontend UX criteria policy for generated task specifications.
 *
 * The checklist mirrors the `frontend-ux-design` reviewer persona in
 * packages/core/src/types.ts. Keep this policy byte-equivalent with the legacy
 * triage prompt checklist and idempotent when applied to generated PROMPT.md
 * content.
 *
 * Rule 4 deterministically expands the legacy "Any CSS or TSX file inside a
 * dashboard-like package" rule: match files under a package `app/` directory
 * ending in `.css` or `.tsx`, excluding the `components/` and `hooks/` subtrees
 * already covered by rules 2 and 3.
 */
export const FRONTEND_UX_PATH_GLOBS = [
  "packages/dashboard/**",
  "packages/*/app/components/**",
  "packages/*/app/hooks/**",
  "packages/*/app/**/*.css",
  "packages/*/app/**/*.tsx",
] as const;

/**
 * Byte-exact Frontend UX Criteria section copied from the legacy triage prompt.
 * The section intentionally ends with exactly one trailing newline.
 */
export const FRONTEND_UX_CRITERIA_SECTION = `## Frontend UX Criteria

- [ ] **Design tokens only** — no hardcoded \`px\` values except \`0\`, no hardcoded hex/rgb colors; use CSS custom properties (\`--color-*\`, \`--spacing-*\`, etc.)
- [ ] **Icon sizing** — match the surrounding component's icon size convention (default lucide size unless the local pattern already uses an explicit \`size={N}\`)
- [ ] **Semantic color tokens for status** — use \`--color-error\` for stderr/error states, \`--color-warning\` for starting/pending states; never hardcode status colors
- [ ] **Component reuse** — reach for existing classes (\`.btn\`, \`.btn-icon\`, \`.card\`, \`.input\`) before writing one-off styles
- [ ] **Responsive scaffolding** — add \`@media (max-width: 768px)\` overrides for any new layout; verify mobile usability
- [ ] **Single canonical nav destination** — each route must appear in exactly one of: Header primary nav, Header overflow menu, or MobileNavBar More; no duplicates across all three
- [ ] **Status-indicator dot convention** — use the existing \`.status-dot\` pattern (size, border, animation) rather than custom dot styling
- [ ] **Visual hierarchy preserved** — new elements must not disrupt heading levels, content flow, or information architecture established in the surrounding page
`;

const FRONTEND_UX_HEADING = "## Frontend UX Criteria";

/**
 * Pure deterministic injection helper. When `fileScopePaths` is omitted, the
 * helper parses `## File Scope` from the supplied prompt markdown using the same
 * section shape as the engine triage parser.
 */
export function applyFrontendUxCriteria(promptMarkdown: string, fileScopePaths?: string[]): string {
  if (promptMarkdown.includes(FRONTEND_UX_HEADING)) {
    return promptMarkdown;
  }

  const paths = fileScopePaths ?? parseFileScopeFromPromptMarkdown(promptMarkdown);
  if (!paths.some((path) => matchesFrontendUxPath(path))) {
    return promptMarkdown;
  }

  return insertFrontendUxCriteriaAfterMission(promptMarkdown);
}

export function matchesFrontendUxPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;

  if (matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[0])) return true;
  if (matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[1])) return true;
  if (matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[2])) return true;

  const isAppCssOrTsx = matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[3])
    || matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[4]);
  if (!isAppCssOrTsx) return false;

  return !matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[1])
    && !matchGlob(normalized, FRONTEND_UX_PATH_GLOBS[2]);
}

function parseFileScopeFromPromptMarkdown(text: string): string[] {
  const match = text.match(/^##\s+File Scope\s*\n([\s\S]*?)(?=^##\s+|$)/m);
  if (!match) return [];

  const entries: string[] = [];
  for (const line of match[1].split("\n")) {
    const cleaned = normalizeFileScopeLine(line);
    if (cleaned) entries.push(cleaned);
  }
  return entries;
}

function normalizeFileScopeLine(line: string): string {
  let cleaned = line.trim();
  if (!cleaned || cleaned.startsWith("<!--")) return "";
  cleaned = cleaned.replace(/^[-*]\s+/, "").trim();
  cleaned = cleaned.replace(/^`([^`]+)`.*$/, "$1").trim();
  cleaned = cleaned.replace(/`/g, "").trim();
  return cleaned;
}

function insertFrontendUxCriteriaAfterMission(content: string): string {
  const missionMatch = content.match(/^##\s+Mission\s*$/m);
  if (!missionMatch || missionMatch.index === undefined) {
    return content;
  }

  const headerEnd = missionMatch.index + missionMatch[0].length;
  const rest = content.slice(headerEnd);
  const nextHeading = rest.search(/\n##\s/);
  const sectionEndAbsolute = nextHeading === -1 ? content.length : headerEnd + nextHeading;
  const before = content.slice(0, sectionEndAbsolute).trimEnd();
  const after = content.slice(sectionEndAbsolute);
  return `${before}\n\n${FRONTEND_UX_CRITERIA_SECTION}${after}`;
}

/** Check if a path matches a glob pattern (simple glob support: * and **). */
function matchGlob(path: string, pattern: string): boolean {
  const regexPattern = globToRegexPattern(normalizePath(pattern));
  return new RegExp(`^${regexPattern}$`).test(normalizePath(path));
}

function globToRegexPattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    out += escapeRegex(char);
  }
  return out;
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
