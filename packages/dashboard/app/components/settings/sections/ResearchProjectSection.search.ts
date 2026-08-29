/**
 * Search entries for the project Research section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in ResearchProjectSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * The Enabled Sources grid and the limits grid stay bespoke and render no descriptor rows, so they carry no entries; the nav entry's own `searchableText` still surfaces the section for those.
 */
import type { SettingsSearchEntry } from "../search/types";

export const researchProjectSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "research-project",
    key: "researchSettings.enabled",
    labelKey: "settings.researchProject.enableResearchInThisProject",
    labelFallback: " Enable research in this project ",
    helpKey: "settings.researchProject.enableResearchInThisProjectHint",
    helpFallback: "Default: enabled.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The copy is two words long and never names what it gates, so the master switch is unreachable by every term an operator would actually search. These keywords are the vocabulary of the feature it turns off, not a restatement of the label.
    */
    keywords: ["research", "web search", "citations", "sources", "turn off research"],
  },
];
