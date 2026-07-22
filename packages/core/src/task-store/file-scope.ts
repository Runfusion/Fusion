/**
 * File Scope parsing and validation helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. store.ts re-imports these helpers.
 *
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * isValidFileScopeEntry is owned by file-scope-classification.ts so create/update
 * validation and extractEffectiveWriteScopeFromPrompt cannot drift. Root-level
 * files with extensions (global.json, Directory.Packages.props, MyApp.slnx) must
 * pass both paths — GitHub issue bodies that declare them were failing import.
 *
 * FNXC:FileScopeClassification 2026-07-21-18:05:
 * Token extraction and section location are shared with classification so fenced
 * code-block File Scope headings (issue repros) are ignored consistently on create,
 * sanitize, and effective write-scope paths.
 */
export { isValidFileScopeEntry, extractFileScopeTokens } from "../tasks/file-scope-classification.js";
import {
  isValidFileScopeEntry,
  extractFileScopeTokens,
  locateFileScopeSection,
} from "../tasks/file-scope-classification.js";

export function validateFileScopeInPromptContent(prompt: string): { valid: string[]; invalid: string[] } {
  const tokens = extractFileScopeTokens(prompt);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (isValidFileScopeEntry(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

export function sanitizeFileScopeInPromptContent(prompt: string): { sanitized: string; dropped: string[]; kept: string[] } {
  const located = locateFileScopeSection(prompt);
  if (!located) {
    return { sanitized: prompt, dropped: [], kept: [] };
  }

  const { sectionStart, sectionEnd } = located;
  const section = prompt.slice(sectionStart, sectionEnd);
  const { valid: kept, invalid: dropped } = validateFileScopeInPromptContent(prompt);
  if (dropped.length === 0) {
    return { sanitized: prompt, dropped, kept };
  }

  const sanitizedSection = section
    .split("\n")
    .filter((line) => {
      const tokens = Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1]);
      if (tokens.length === 0) return true;
      return tokens.every((token) => isValidFileScopeEntry(token));
    })
    .join("\n");

  return {
    sanitized: `${prompt.slice(0, sectionStart)}${sanitizedSection}${prompt.slice(sectionEnd)}`,
    dropped,
    kept,
  };
}
