/**
 * Search entries for the Commands section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per control the section renders, co-located so a setting and its index entry change in the same edit. `settings-search-index.test.ts` fails the build if a descriptor `key` here and in CommandsSection.tsx ever diverge, which is what keeps the index honest without anyone maintaining a keyword list by hand.
 * Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 */
import type { SettingsSearchEntry } from "../search/types";

export const commandsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "commands",
    key: "testCommand",
    labelKey: "settings.commands.testCommand",
    labelFallback: "Test Command",
    helpKey: "settings.commands.commandUsedToRunTestsInjectedIntoGenerated",
    helpFallback:
      "Command used to run tests — injected into generated task specs. No default — unset.",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    "verify"/"verification" are indexed because this project's own configured test command is `pnpm verify:fast`; operators search the command they run, which the label never says.
    */
    keywords: ["verify", "verification", "vitest", "pnpm test"],
  },
  {
    sectionId: "commands",
    key: "buildCommand",
    labelKey: "settings.commands.buildCommand",
    labelFallback: "Build Command",
    helpKey: "settings.commands.commandUsedToBuildTheProjectInjectedInto",
    helpFallback:
      "Command used to build the project — injected into generated task specs. No default — unset.",
    keywords: ["compile", "pnpm build"],
  },
];
