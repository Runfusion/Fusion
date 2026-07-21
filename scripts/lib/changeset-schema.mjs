/*
 * FNXC:Changelog 2026-06-24-14:30:
 * Structured changeset body schema. Each changeset body uses labeled fields
 * (summary, category, dev) instead of freeform paragraphs. The `summary` is
 * the only content that flows into end-user release notes by default. The
 * `dev` field is preserved in per-package CHANGELOGs but excluded from
 * distilled release notes. Legacy freeform changesets are detected and
 * flagged so the linter can warn during the transition period.
 */

/** Maximum character length for the `summary` field. */
export const MAX_SUMMARY_LENGTH = 120;

/** Valid category values, in display order for release notes grouping. */
export const CATEGORIES = [
  "feature",
  "fix",
  "breaking",
  "security",
  "performance",
  "internal",
];

/** Human-readable headings for each category in release notes. */
export const CATEGORY_HEADINGS = {
  feature: "New",
  fix: "Fixed",
  breaking: "Breaking",
  security: "Security",
  performance: "Performance",
  internal: "Internal",
};

/**
 * Parse labeled fields from a changeset body.
 *
 * The body format is:
 *   summary: One-line user-facing description.
 *   category: feature
 *   dev: Optional developer detail (can span multiple lines).
 *
 * If no labeled fields are found, the entire body is treated as legacy
 * content: the first non-empty line becomes `summary`, and `category`
 * defaults to `internal` with `legacy: true`.
 *
 * @param {string} body - The changeset body (after frontmatter).
 * @returns {{summary: string, category: string, dev?: string, legacy: boolean} | null}
 */
export function parseChangesetBody(body) {
  if (!body || !body.trim()) {
    return null;
  }

  const fields = extractLabeledFields(body);

  if (fields.summary !== undefined || fields.category !== undefined || fields.dev !== undefined) {
    return {
      summary: (fields.summary ?? "").trim(),
      category: fields.category ?? "",
      dev: fields.dev?.trim() || undefined,
      legacy: false,
    };
  }

  // Legacy freeform: first non-empty line is the summary.
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!firstLine) {
    return null;
  }

  return {
    summary: firstLine,
    category: "internal",
    legacy: true,
  };
}

/**
 * FNXC:Changelog 2026-07-19-21:40:
 * Changesets renders each release entry as a commit-prefixed bullet followed by indented labeled fields. Release-note distillation must parse the complete bullet and remove only the generated commit prefix so `category` and `dev` are not lost or mislabeled as Internal.
 *
 * @param {string} notes - A version section from a Changesets package changelog.
 * @returns {Array<{summary: string, category: string, dev?: string, legacy: boolean}>}
 */
export function parseChangesetChangelogEntries(notes) {
  if (!notes || !notes.trim()) {
    return [];
  }

  const bodies = [];
  let current = null;

  const flush = () => {
    if (current?.length) {
      bodies.push(current.join("\n"));
    }
    current = null;
  };

  for (const line of notes.split(/\r?\n/)) {
    const bulletMatch = line.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      flush();
      current = [bulletMatch[1].trimEnd()];
      continue;
    }

    if (current && /^\s+\S/.test(line)) {
      current.push(line.trim());
      continue;
    }

    if (current && line.trim()) {
      flush();
    }
  }
  flush();

  return bodies
    .map((body) => body.replace(/^[0-9a-f]{7,40}:\s*(?=(?:summary|category|dev):)/i, ""))
    .map((body) => parseChangesetBody(body))
    .filter(Boolean);
}

/**
 * Extract `key: value` labeled fields from the changeset body.
 * `dev` allows multi-line content until the next labeled field or EOF.
 * Returns an empty object if no labeled fields are found.
 */
function extractLabeledFields(body) {
  const knownLabels = ["summary", "category", "dev"];
  const lines = body.split(/\r?\n/);
  const fields = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w+):\s*(.*)$/);

    if (match && knownLabels.includes(match[1])) {
      const label = match[1];
      const value = match[2];

      if (label === "dev") {
        // Multi-line: collect subsequent non-labeled lines.
        const devLines = [value];
        i += 1;
        while (i < lines.length) {
          const nextLine = lines[i];
          const nextMatch = nextLine.match(/^(\w+):\s*(.*)$/);
          if (nextMatch && knownLabels.includes(nextMatch[1])) {
            break;
          }
          devLines.push(nextLine);
          i += 1;
        }
        fields.dev = devLines.join("\n").trim();
      } else {
        fields[label] = value.trim();
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return fields;
}

/**
 * Validate a parsed changeset against the schema.
 * Returns errors for missing required fields, invalid categories,
 * or over-length summaries.
 *
 * @param {{summary: string, category: string, dev?: string, legacy: boolean}} parsed
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateChangeset(parsed) {
  const errors = [];

  if (parsed.legacy) {
    return { valid: true, errors: [] };
  }

  if (!parsed.summary) {
    errors.push("missing required `summary` field");
  } else if (parsed.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push(
      `\`summary\` exceeds max length (${parsed.summary.length}/${MAX_SUMMARY_LENGTH} chars)`,
    );
  }

  if (!parsed.category) {
    errors.push("missing required `category` field");
  } else if (!CATEGORIES.includes(parsed.category)) {
    errors.push(
      `invalid \`category\` value "${parsed.category}"; valid values: ${CATEGORIES.join(", ")}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse a full changeset markdown file (frontmatter + body).
 * Splits on the `---` delimited frontmatter and parses the body.
 *
 * @param {string} raw - Full file contents.
 * @returns {{frontmatter: string, body: string, parsed: object|null}}
 */
export function parseChangesetFile(raw) {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: "", body: raw, parsed: parseChangesetBody(raw) };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  return { frontmatter, body, parsed: parseChangesetBody(body) };
}
