/**
 * Search entries for the Source Control · Global section.
 *
 * FNXC:SettingsSearch 2026-07-15-20:30:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * These rows carry the same `key`s as their project counterparts in SourceControlSection.search.ts — they are the same dual-scope settings at the other tier, and `sectionId` is what keeps them distinct (the index's uniqueness rule is per section+key). Their labels are the operator-facing discriminator: every one reads "Global …".
 * The global default tracking repo is absent: TrackingRepoSelect is a bespoke widget with no descriptor `key`, so it has no `data-settings-key` anchor to scroll to. It stays reachable via the section's `searchableText` in SETTINGS_SECTIONS.
 */
import type { SettingsSearchEntry } from "../search/types";

export const sourceControlGlobalSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "source-control-global",
    key: "reportRoadmapDedupeEnabled",
    labelKey: "settings.globalGeneral.reportRoadmapDedupeEnabled",
    labelFallback: "Global public-roadmap deduplication",
    helpKey: "settings.globalGeneral.reportRoadmapDedupeEnabledHelp",
    helpFallback: "Fallback for projects that do not set a public-roadmap deduplication preference. No default — unset (projects default to enabled).",
    keywords: ["roadmap", "dedup", "report", "fallback"],
  },
  {
    sectionId: "source-control-global",
    key: "reportRoadmapLabel",
    labelKey: "settings.globalGeneral.reportRoadmapLabel",
    labelFallback: "Global public roadmap label",
    helpKey: "settings.globalGeneral.reportRoadmapLabelHelp",
    helpFallback: "Fallback label for open public-roadmap issues when a project does not set one. No default — unset (projects default to roadmap).",
    keywords: ["roadmap", "label", "report", "fallback"],
  },
  {
    sectionId: "source-control-global",
    key: "reportRoadmapRepo",
    labelKey: "settings.globalGeneral.reportRoadmapRepo",
    labelFallback: "Global public roadmap repository (optional)",
    helpKey: "settings.globalGeneral.reportRoadmapRepoHelp",
    helpFallback: "Fallback GitHub owner/repository for public-roadmap issues. When unset, uses the tracking repository. No default — unset.",
    keywords: ["roadmap", "repository", "repo", "tracking", "fallback"],
  },
  {
    sectionId: "source-control-global",
    key: "gitlabInstanceUrl",
    labelKey: "settings.globalGeneral.gitLabInstanceUrl",
    labelFallback: "Global GitLab instance URL",
    helpKey: "settings.globalGeneral.gitLabInstanceUrlHint",
    helpFallback:
      "Blank defaults to GitLab.com. Projects inherit this self-managed GitLab URL unless they set their own project value. No default — unset.",
    keywords: ["self managed", "self-hosted", "fallback", "inherit"],
  },
  {
    sectionId: "source-control-global",
    key: "gitlabApiBaseUrl",
    labelKey: "settings.globalGeneral.gitLabApiBaseUrlOptional",
    labelFallback: "Global GitLab API base URL (optional / advanced)",
    helpKey: "settings.globalGeneral.gitLabApiBaseUrlHint",
    helpFallback:
      "Blank derives <instance>/api/v4. Override only for self-managed GitLab API gateways that use a different absolute http:// or https:// URL. No default — unset.",
    keywords: ["api v4", "gateway", "fallback", "self managed"],
  },
  {
    sectionId: "source-control-global",
    key: "gitlabAuthTokenType",
    labelKey: "settings.globalGeneral.gitLabTokenType",
    labelFallback: "Global GitLab token type",
    helpKey: "settings.globalGeneral.gitLabTokenTypeHint",
    helpFallback:
      "No default — unset (the selector falls back to personal access token until you choose otherwise).",
    keywords: ["personal access token", "project access token", "group access token", "pat"],
  },
  {
    sectionId: "source-control-global",
    key: "gitlabAuthToken",
    labelKey: "settings.globalGeneral.gitLabAccessToken",
    labelFallback: "Global GitLab access token",
    helpKey: "settings.globalGeneral.gitLabAuthTokenHint",
    helpFallback:
      "Projects inherit this fallback only when they do not set a project GitLab token. Read-only operations need read_api or api; write actions need api; project/group tokens remain limited by resource membership. No default — unset.",
    keywords: ["glpat", "private-token", "credentials", "secret", "fallback"],
  },
];
