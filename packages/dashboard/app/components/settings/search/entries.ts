/**
 * The settings search index — every searchable setting in the modal.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * Entries are co-located per section (`sections/<Name>Section.search.ts`) and aggregated here rather than declared in one list. Two reasons: a section's settings and its search entries change in the same edit, so keeping them adjacent is what makes the pairing obvious to the next editor; and one shared list would be a merge-conflict funnel while sections are migrated in parallel.
 * This barrel is the only place that knows the full set. `settings-search-index.test.ts` enforces the invariant that every descriptor `key` rendered by a section appears here under that section's id — a missing entry fails the build rather than silently producing a setting no one can find, which is how the previous hand-curated keyword lists rotted.
 * Sections absent from this list render no descriptor rows — dynamic flag lists, bespoke editors, CRUD managers, and controls the primitives cannot express safely (a password field would be rendered unmasked by SettingsTextRow, so token rows stay bespoke by design). They are still findable: the nav matches them on their `searchableText` keywords in SettingsModal.tsx. Only sections with addressable controls can offer jump-to-field.
 */
import type { SettingsSearchEntry } from "./types";
import { appearanceSearchEntries } from "../sections/AppearanceSection.search";
import { backupsSearchEntries } from "../sections/BackupsSection.search";
import { commandsSearchEntries } from "../sections/CommandsSection.search";
import { generalSearchEntries } from "../sections/GeneralSection.search";
import { globalGeneralSearchEntries } from "../sections/GlobalGeneralSection.search";
import { globalModelsSearchEntries } from "../sections/GlobalModelsSection.search";
import { memorySearchEntries } from "../sections/MemorySection.search";
import { mergeSearchEntries } from "../sections/MergeSection.search";
import { nodeRoutingSearchEntries } from "../sections/NodeRoutingSection.search";
import { nodeSyncSearchEntries } from "../sections/NodeSyncSection.search";
import { notificationsSearchEntries } from "../sections/NotificationsSection.search";
import { projectModelsSearchEntries } from "../sections/ProjectModelsSection.search";
import { remoteSearchEntries } from "../sections/RemoteSection.search";
import { researchGlobalSearchEntries } from "../sections/ResearchGlobalSection.search";
import { researchProjectSearchEntries } from "../sections/ResearchProjectSection.search";
import { scheduledEvalsSearchEntries } from "../sections/ScheduledEvalsSection.search";
import { schedulingSearchEntries } from "../sections/SchedulingSection.search";
import { worktreesSearchEntries } from "../sections/WorktreesSection.search";

/**
 * Flat index of every searchable setting. Order is not significant — results
 * are ranked and tie-broken alphabetically at query time.
 */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...appearanceSearchEntries,
  ...backupsSearchEntries,
  ...commandsSearchEntries,
  ...generalSearchEntries,
  ...globalGeneralSearchEntries,
  ...globalModelsSearchEntries,
  ...memorySearchEntries,
  ...mergeSearchEntries,
  ...nodeRoutingSearchEntries,
  ...nodeSyncSearchEntries,
  ...notificationsSearchEntries,
  ...projectModelsSearchEntries,
  ...remoteSearchEntries,
  ...researchGlobalSearchEntries,
  ...researchProjectSearchEntries,
  ...scheduledEvalsSearchEntries,
  ...schedulingSearchEntries,
  ...worktreesSearchEntries,
];

/** Entries owned by one section id. */
export function settingsSearchEntriesForSection(sectionId: string): SettingsSearchEntry[] {
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.sectionId === sectionId);
}
