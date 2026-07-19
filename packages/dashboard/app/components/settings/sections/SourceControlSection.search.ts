/**
 * Search entries for the Source Control · Project section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 *
 * FNXC:SettingsSearch 2026-07-15-20:30:
 * These entries moved here with their controls from GeneralSection.search.ts and MergeSection.search.ts. An entry's `sectionId` must track the section that actually RENDERS the row — a stale id would surface the result, jump to a section that no longer holds the anchor, and do nothing.
 * The token rows are indexed for the first time: they were unindexable while they had to stay hand-rolled to avoid rendering a secret through a `type="text"` primitive, and SettingsTextRow's `type: "password"` support is what makes them addressable. The index stores their label and help copy only — never a value.
 * Still absent by design: the tracking-mode select and the tracking-repo select are bespoke widgets with no descriptor `key`, so they carry no `data-settings-key` anchor to scroll to. They stay reachable via the section's `searchableText` in SETTINGS_SECTIONS.
 */
import type { SettingsSearchEntry } from "../search/types";

export const sourceControlSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "source-control",
    key: "githubLinkImportedIssuesToTracking",
    labelKey: "settings.general.alwaysLinkImportedGitHubIssuesToTracking",
    labelFallback: " Always link imported GitHub issues to GitHub tracking ",
    helpKey: "settings.general.whenEnabledImportedGitHubIssuesUseTheirSource",
    helpFallback:
      "When enabled, GitHub issue imports become tracked tasks that adopt the source issue. This does not turn GitHub tracking on for ordinary new tasks. Default: disabled.",
    keywords: ["adopt issue", "import"],
  },
  {
    sectionId: "source-control",
    key: "githubTrackingDedupEnabled",
    labelKey: "settings.general.searchTheTrackingRepoForLikelyDuplicatesBefore",
    labelFallback: " Search the tracking repo for likely duplicates before opening a new issue ",
    helpKey: "settings.general.whenEnabledFusionChecksOpenAndClosedIssues",
    helpFallback:
      " When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue. Default: enabled. ",
    keywords: ["dedupe", "deduplication"],
  },
  {
    sectionId: "source-control",
    key: "githubAuthMode",
    labelKey: "settings.merge.gitHubAuthMode",
    labelFallback: "GitHub auth mode",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    No helpKey/helpFallback: this row carries no help copy in the section either, and inventing index-only text would let search match words that appear nowhere on screen. The keywords carry the vocabulary instead.
    */
    keywords: ["gh cli", "personal access token", "pat", "credentials", "login"],
  },
  {
    sectionId: "source-control",
    key: "githubAuthToken",
    labelKey: "settings.merge.gitHubPersonalAccessToken",
    labelFallback: "GitHub personal access token",
    helpKey: "settings.merge.githubAuthTokenHint",
    helpFallback: "No default — unset.",
    keywords: ["pat", "credentials", "secret", "ghp"],
  },
  {
    sectionId: "source-control",
    key: "gitlabInstanceUrl",
    labelKey: "settings.general.gitLabInstanceUrl",
    labelFallback: "GitLab instance URL",
    helpKey: "settings.general.gitLabInstanceUrlHint",
    helpFallback:
      "Blank uses GitLab.com or the global default. Set an absolute http:// or https:// URL for self-managed GitLab, such as https://gitlab.example.com/gitlab.",
    keywords: ["self managed", "self-hosted", "on premise"],
  },
  {
    sectionId: "source-control",
    key: "gitlabApiBaseUrl",
    labelKey: "settings.general.gitLabApiBaseUrlOptional",
    labelFallback: "GitLab API base URL (optional / advanced)",
    helpKey: "settings.general.gitLabApiBaseUrlHint",
    helpFallback:
      "Blank derives <instance>/api/v4. Override only when a self-managed GitLab API is served from a different absolute http:// or https:// URL.",
    keywords: ["api v4", "gateway", "self managed"],
  },
  {
    sectionId: "source-control",
    key: "gitlabAuthTokenType",
    labelKey: "settings.merge.gitLabTokenType",
    labelFallback: "GitLab token type",
    /*
    FNXC:SettingsSearch 2026-07-15-20:30:
    No helpKey/helpFallback: the row carries none in the section either. Its enable/disable context comes from the disclosure hint above it, which belongs to no single row and so cannot be indexed as one row's help.
    */
    keywords: ["personal access token", "project access token", "group access token", "pat"],
  },
  {
    sectionId: "source-control",
    key: "gitlabAuthToken",
    labelKey: "settings.merge.gitLabAccessToken",
    labelFallback: "GitLab access token",
    helpKey: "settings.merge.gitLabAuthTokenHint",
    helpFallback:
      "Read-only GitLab operations need read_api or api. Future write actions such as comments and auto-close need api. Project and group tokens are limited to their associated resource and role membership. No default — unset.",
    keywords: ["glpat", "private-token", "credentials", "secret", "read_api"],
  },
];
