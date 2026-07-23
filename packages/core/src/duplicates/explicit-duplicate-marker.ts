export interface ExplicitDuplicateMarker {
  canonicalId: string;
}

function stripCodeFenceLayer(content: string): string {
  const fenceMatch = content.match(/^```(?:[\t ]*(?:text|markdown))?[\t ]*\n([\s\S]*?)\n```$/i);
  if (!fenceMatch) {
    return content;
  }
  return fenceMatch[1] ?? "";
}

function stripSingleWrapper(line: string): string {
  if (line.startsWith("`") && line.endsWith("`") && line.length >= 2) {
    return line.slice(1, -1).trim();
  }
  if (line.startsWith("**") && line.endsWith("**") && line.length >= 4) {
    return line.slice(2, -2).trim();
  }
  return line;
}

/**
 * Detects the canonical triage "redirect" marker emitted by the planning
 * agent when the new task duplicates an existing one.
 */
export function parseExplicitDuplicateMarker(content: string): ExplicitDuplicateMarker | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const withoutFence = stripCodeFenceLayer(trimmed).trim();
  const nonBlankLines = withoutFence
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonBlankLines.length !== 1) {
    return null;
  }

  const candidate = stripSingleWrapper(nonBlankLines[0] ?? "");
  const match = candidate.match(/^DUPLICATE:\s*(FN-\d+)\s*$/i);
  if (!match) {
    return null;
  }

  return {
    canonicalId: match[1].toUpperCase(),
  };
}
