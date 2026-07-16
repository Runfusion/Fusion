/**
 * Search entries for the Research Defaults (global) section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in ResearchGlobalSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The provider radio, limits grid, Enabled Sources grid, and credential empty-states stay bespoke and render no descriptor rows, so they carry no entries; the nav entry's own `searchableText` still surfaces the section for those.
 */
import type { SettingsSearchEntry } from "../search/types";

export const researchGlobalSearchEntries: SettingsSearchEntry[] = [
  {
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    This row lives behind the "Advanced — external search providers" disclosure, which is exactly why it is indexed: an operator who knows they want Brave or Tavily has no way to discover a control folded inside a closed `<details>`. The provider names are keywords because they are option labels, and only label and help are indexed automatically.
    */
    sectionId: "research-global",
    key: "researchGlobalWebSearchProvider",
    labelKey: "settings.researchGlobal.searchProvider",
    labelFallback: "Search Provider",
    keywords: ["SearXNG", "Brave", "Google Custom Search", "Tavily", "external search providers", "built-in"],
  },
  {
    sectionId: "research-global",
    key: "researchGlobalSearxngUrl",
    labelKey: "settings.researchGlobal.searXNGURL",
    labelFallback: "SearXNG URL",
    helpKey: "settings.researchGlobal.searXNGURLHint",
    helpFallback: "No default — unset.",
    keywords: ["endpoint", "instance", "self-hosted"],
  },
  {
    sectionId: "research-global",
    key: "researchGlobalGoogleSearchCx",
    labelKey: "settings.researchGlobal.googleSearchCX",
    labelFallback: "Google Search CX",
    helpKey: "settings.researchGlobal.googleSearchCXHint",
    helpFallback: "No default — unset.",
    keywords: ["custom search engine id", "programmable search"],
  },
];
