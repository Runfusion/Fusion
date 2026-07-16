import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { SETTINGS_SEARCH_ENTRIES } from "../entries";
import { rankSettingsSearchResults, scoreSettingsSearchEntry } from "../match";
import type { SettingsSearchEntry } from "../types";

/**
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * The drift guard. "Every setting is searchable" is only true if it is enforced, and the previous design proved it: the index was a hand-written keyword array per nav entry, and settings shipped unfindable until someone complained (Project Models was patched twice — FN-7907, then title-summarization — because "summarize" matched nothing).
 * This asserts the invariant structurally instead: every descriptor `key` a section renders MUST have an index entry under that section's id. A new setting without one fails the build, so the index cannot silently fall behind the UI.
 * It reads section sources rather than rendering them: only the active section mounts in the real modal, and rendering all 34 would need each one's props, stores, and network mocks — a harness far more brittle than the invariant it checks. Descriptor keys are literal strings in the JSX, so the source is an honest inventory of what renders.
 */

const SECTIONS_DIR = resolve(__dirname, "../../sections");

/**
 * Extracts the descriptor keys a section renders. Matches the established
 * `descriptor={{ key: "..." }}` idiom every typed row uses (see GeneralSection
 * and AppearanceSection); `key` is always the first property by convention.
 */
function extractDescriptorKeys(source: string): string[] {
  return [...source.matchAll(/descriptor=\{\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Section .tsx files, excluding co-located tests and non-section helpers. */
function sectionFiles(): string[] {
  return readdirSync(SECTIONS_DIR)
    .filter((f) => f.endsWith("Section.tsx") || f.endsWith("Card.tsx"))
    .filter((f) => !f.includes(".test."));
}

/**
 * Maps a section source filename to the nav section id its entries must use.
 * Only sections that render descriptor rows need an entry here; the map is
 * asserted to cover every migrated file below, so a migration that forgets to
 * register its id fails rather than being skipped silently.
 */
const SECTION_FILE_TO_ID: Record<string, string> = {
  "AppearanceSection.tsx": "appearance",
  "BackupsSection.tsx": "backups",
  "DatabaseBackupsSection.tsx": "backups-global",
  "CommandsSection.tsx": "commands",
  "GeneralSection.tsx": "general",
  "GlobalGeneralSection.tsx": "global-general",
  "GlobalModelsSection.tsx": "global-models",
  "MemorySection.tsx": "memory",
  "MergeSection.tsx": "merge",
  "NodeRoutingSection.tsx": "node-routing",
  "NodeSyncSection.tsx": "node-sync",
  "NotificationsSection.tsx": "notifications",
  "ProjectModelsSection.tsx": "project-models",
  "RemoteSection.tsx": "remote",
  "ResearchGlobalSection.tsx": "research-global",
  "ResearchProjectSection.tsx": "research-project",
  "ScheduledEvalsSection.tsx": "scheduled-evals",
  "SchedulingGlobalSection.tsx": "scheduling-global",
  "SchedulingSection.tsx": "scheduling",
  "SourceControlGlobalSection.tsx": "source-control-global",
  "SourceControlSection.tsx": "source-control",
  "WorktreesSection.tsx": "worktrees",
};

describe("settings search index", () => {
  it("indexes every setting rendered by a migrated section", () => {
    const missing: string[] = [];

    for (const [file, sectionId] of Object.entries(SECTION_FILE_TO_ID)) {
      const source = readFileSync(join(SECTIONS_DIR, file), "utf8");
      const rendered = extractDescriptorKeys(source);
      expect(rendered.length, `${file} renders no descriptor rows — is it migrated?`).toBeGreaterThan(0);

      const indexed = new Set(
        SETTINGS_SEARCH_ENTRIES.filter((e) => e.sectionId === sectionId).map((e) => e.key),
      );
      for (const key of rendered) {
        if (!indexed.has(key)) missing.push(`${sectionId}: ${key} (rendered by ${file})`);
      }
    }

    expect(
      missing,
      `Settings rendered but absent from the search index — operators cannot find them:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("does not index settings that no section renders", () => {
    const renderedBySection = new Map<string, Set<string>>();
    for (const [file, sectionId] of Object.entries(SECTION_FILE_TO_ID)) {
      const source = readFileSync(join(SECTIONS_DIR, file), "utf8");
      const keys = renderedBySection.get(sectionId) ?? new Set<string>();
      for (const key of extractDescriptorKeys(source)) keys.add(key);
      renderedBySection.set(sectionId, keys);
    }

    // A stale entry points search at a control that no longer exists: the
    // result renders, the jump finds no anchor, and nothing happens.
    const stale = SETTINGS_SEARCH_ENTRIES.filter(
      (e) => renderedBySection.has(e.sectionId) && !renderedBySection.get(e.sectionId)!.has(e.key),
    ).map((e) => `${e.sectionId}: ${e.key}`);

    expect(stale, `Indexed settings that no section renders:\n${stale.join("\n")}`).toEqual([]);
  });

  it("registers a section id for every section that renders descriptor rows", () => {
    const unregistered = sectionFiles()
      .filter((file) => !(file in SECTION_FILE_TO_ID))
      .filter((file) => extractDescriptorKeys(readFileSync(join(SECTIONS_DIR, file), "utf8")).length > 0);

    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    A section that renders no descriptor rows is legitimately absent from the map — some are dynamic flag lists or bespoke editors with no addressable control, and some rows stay bespoke on purpose (a password field would render unmasked through SettingsTextRow).
    But the moment a section renders its first descriptor row it MUST register an id, or its settings would be silently exempt from the coverage assertion above — the exact hole this guard closes. No exceptions are carved out here for that reason.
    */
    expect(
      unregistered,
      `Sections rendering descriptor rows without a search-index id:\n${unregistered.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps entries unique per section+key", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of SETTINGS_SEARCH_ENTRIES) {
      const id = `${e.sectionId}:${e.key}`;
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    // Duplicates would render the same setting twice in the result list.
    expect(dupes).toEqual([]);
  });
});

describe("settings search ranking", () => {
  const entry: SettingsSearchEntry = {
    sectionId: "appearance",
    key: "showCostBadgeOnCards",
    labelKey: "l",
    labelFallback: "Show cost badges on task cards",
    helpKey: "h",
    helpFallback: "Board cards show derived model cost next to execution time.",
    keywords: ["spend"],
  };

  const resolveEnglish = (_key: string, fallback: string) => fallback;

  it("ranks a label hit above a help-text hit", () => {
    const label = scoreSettingsSearchEntry(entry, "cost badges", entry.labelFallback, entry.helpFallback);
    const help = scoreSettingsSearchEntry(entry, "execution time", entry.labelFallback, entry.helpFallback);
    expect(label).not.toBeNull();
    expect(help).not.toBeNull();
    expect(label!).toBeLessThan(help!);
  });

  it("matches help text, which the pre-rewrite keyword index could not", () => {
    // The FN-7907 class of miss: the word appears in the copy on screen but in
    // no hand-written keyword list.
    expect(
      scoreSettingsSearchEntry(entry, "derived model cost", entry.labelFallback, entry.helpFallback),
    ).not.toBeNull();
  });

  it("matches the stored field name so a config-file name finds its control", () => {
    expect(
      scoreSettingsSearchEntry(entry, "showcostbadgeoncards", entry.labelFallback, entry.helpFallback),
    ).not.toBeNull();
  });

  it("matches curated synonyms absent from the copy", () => {
    expect(scoreSettingsSearchEntry(entry, "spend", entry.labelFallback, entry.helpFallback)).not.toBeNull();
  });

  it("returns null for a non-match", () => {
    expect(scoreSettingsSearchEntry(entry, "cloudflared", entry.labelFallback, entry.helpFallback)).toBeNull();
  });

  it("returns nothing for an empty query rather than the whole index", () => {
    expect(rankSettingsSearchResults([entry], "   ", resolveEnglish)).toEqual([]);
  });

  it("orders results by score then alphabetically for a stable list", () => {
    const other: SettingsSearchEntry = {
      sectionId: "appearance",
      key: "aCostThing",
      labelKey: "l2",
      labelFallback: "A cost thing",
    };
    const results = rankSettingsSearchResults([entry, other], "cost", resolveEnglish);
    expect(results.map((r) => r.key)).toEqual(["aCostThing", "showCostBadgeOnCards"]);
  });

  it("finds the real 'summarize' miss that motivated the rewrite", () => {
    // FN-7907 / 2026-07-14: operators searched "summarize"; the section's
    // keyword list did not carry it, so Project Models did not surface.
    const autoSummarize: SettingsSearchEntry = {
      sectionId: "project-models",
      key: "autoSummarizeTitles",
      labelKey: "settings.projectModels.autoSummarizeLongDescriptionsAsTitles",
      labelFallback: "Auto-summarize long descriptions as titles",
    };
    const results = rankSettingsSearchResults([autoSummarize], "summarize", resolveEnglish);
    expect(results).toHaveLength(1);
    expect(results[0].sectionId).toBe("project-models");
  });
});
