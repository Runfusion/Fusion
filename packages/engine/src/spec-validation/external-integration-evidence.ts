import { extractSection } from "../step-session-executor.js";

export interface ExternalIntegrationEvidenceFinding {
  integrationHint: string;
  missing: Array<
    | "canonical-upstream-repo-url"
    | "docs-url"
    | "release-or-download-url"
    | "binary-or-cli-name"
    | "checksum-or-source-of-truth-evidence"
  >;
}

export interface ExternalIntegrationDetectorOverrides {
  integrationPattern?: RegExp;
  triggerTokens?: readonly string[];
  downloadVerbPattern?: RegExp;
}

export interface DetectExternalIntegrationEvidenceOptions {
  promptContent: string;
  detectorOverrides?: ExternalIntegrationDetectorOverrides;
}

const SECTION_NAMES = [
  "Mission",
  "Steps",
  "File Scope",
  "Context to Read First",
  "External Integration Evidence",
  "External-Integration Evidence",
];
const DEFAULT_TRIGGER_TOKENS = [
  "third-party",
  "third party",
  "external cli",
  "external tool",
  "external binary",
  "external integration",
  "behind a setting flag",
] as const;

const DEFAULT_INTEGRATION_PATTERN = /\b(?:worktrunk|cloudflared|tunnel|installer|releases?|upstream)\b/gi;
const DEFAULT_DOWNLOAD_VERB_PATTERN = /\b(?:install|download|probe|release|binary|cargo install|curl\s+[^\n]*-o|tar\s+-xz)\b/i;
const DUPLICATE_GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/i;

function collectSections(promptContent: string): string {
  return SECTION_NAMES.map((name) => extractSection(promptContent, name)).join("\n");
}

function collectHints(text: string, pattern: RegExp): string[] {
  const source = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  const hints = new Set<string>();
  for (const match of text.matchAll(source)) {
    const value = (match[0] || "").toLowerCase();
    if (value) hints.add(value);
  }
  return Array.from(hints).sort();
}

function hasLikelyCliName(text: string): boolean {
  const codeMatches = Array.from(text.matchAll(/`([a-z][a-z0-9-]{1,30})`/gi));
  if (codeMatches.length === 0) return false;
  for (const match of codeMatches) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;
    const window = text.slice(
      Math.max(0, idx - 80),
      Math.min(text.length, idx + (match[0]?.length ?? 0) + 80),
    );
    if (/\b(?:probe|invoke|run|spawn|which|where)\b/i.test(window)) return true;
    const leadingText = text.slice(Math.max(0, idx - 80), idx);
    if (/\b(?:(?:binary|cli)(?:\s*\/\s*|\s+or\s+)?(?:cli\s+)?name|cli\s+name)\s*:?\s*$/i.test(leadingText)) return true;
  }
  return false;
}

function collectHttpUrls(text: string): string[] {
  return Array.from(text.matchAll(/https:\/\/[^\s)\]`"']+/gi)).map((m) =>
    m[0].replace(/[),.;:!?]+$/, ""),
  );
}

function hasLabeledUrl(text: string, labelPattern: RegExp, urlPattern: RegExp = /https:\/\//i): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => labelPattern.test(line) && collectHttpUrls(line).some((url) => urlPattern.test(url)));
}

function isReleaseOrDownloadUrl(url: string): boolean {
  return (
    /https:\/\/github\.com\/[^\s)\]`"']*releases\/[^\s)\]`"']+/i.test(url) ||
    /https:\/\/[^\s)\]`"']*download[^\s)\]`"']*/i.test(url) ||
    /https:\/\/registry\.npmjs\.org\/[^\s)\]`"']+\/-\/[^\s)\]`"']+\.tgz(?:$|[?#])/i.test(url) ||
    /\.(?:tgz|tar\.gz)(?:$|[?#])/i.test(url)
  );
}

function isLikelyDocsUrl(url: string): boolean {
  return !/^https:\/\/github\.com\//i.test(url) && !isReleaseOrDownloadUrl(url);
}

function hasCanonicalGithubRepoUrl(text: string): boolean {
  const urls = Array.from(text.matchAll(/https:\/\/github\.com\/[^\s)\]`"']+/gi)).map((m) => m[0]);
  for (const url of urls) {
    const normalized = url.replace(/[),.;:!?]+$/, "");
    const match = normalized.match(DUPLICATE_GITHUB_REPO_PATTERN);
    if (!match) continue;
    const owner = match[1]?.toLowerCase();
    const repo = match[2]?.toLowerCase();
    if (owner && repo && owner !== repo) return true;
  }
  return false;
}

export function detectExternalIntegrationEvidenceGaps(
  opts: DetectExternalIntegrationEvidenceOptions,
): ExternalIntegrationEvidenceFinding[] {
  const text = collectSections(opts.promptContent);
  const triggerTokens = opts.detectorOverrides?.triggerTokens ?? DEFAULT_TRIGGER_TOKENS;
  const integrationPattern = opts.detectorOverrides?.integrationPattern ?? DEFAULT_INTEGRATION_PATTERN;
  const downloadVerbPattern = opts.detectorOverrides?.downloadVerbPattern ?? DEFAULT_DOWNLOAD_VERB_PATTERN;
  const lowered = text.toLowerCase();
  const hasTriggerToken = triggerTokens.some((token) => lowered.includes(token));
  const hasIntegrationHint = integrationPattern.test(text);
  const hasDownloadVerb = downloadVerbPattern.test(text);

  if (!((hasTriggerToken || hasIntegrationHint) && hasDownloadVerb)) return [];

  const hints = collectHints(text, integrationPattern);
  const findingHints = hints.length > 0 ? hints : ["external-integration"];

  const urls = collectHttpUrls(text);
  const hasDocsUrl =
    hasLabeledUrl(text, /\b(?:docs?|homepage)\b(?:\s*(?:\/|or)\s*\b(?:docs?|homepage)\b)?(?:\s+url)?\s*:/i) ||
    urls.some(isLikelyDocsUrl);
  const hasReleaseUrl =
    hasLabeledUrl(text, /\b(?:release|download)\b(?:\s*(?:\/|or)\s*\b(?:release|download)\b)?(?:\s+url)?\s*:/i) ||
    urls.some(isReleaseOrDownloadUrl);
  const hasChecksumMarker =
    /\bsha\d+\b|pinned manifest|validateExternalIntegrationManifest|WORKTRUNK_PINNED_RELEASE|upstream-pending-verification/i.test(
      text,
    );
  const hasCliName = hasLikelyCliName(text);
  const hasCanonicalRepo = hasCanonicalGithubRepoUrl(text);

  return findingHints
    .map((integrationHint) => {
      const missing: ExternalIntegrationEvidenceFinding["missing"] = [];
      if (!hasCanonicalRepo) missing.push("canonical-upstream-repo-url");
      if (!hasDocsUrl) missing.push("docs-url");
      if (!hasReleaseUrl) missing.push("release-or-download-url");
      if (!hasCliName) missing.push("binary-or-cli-name");
      if (!hasChecksumMarker) missing.push("checksum-or-source-of-truth-evidence");
      return { integrationHint, missing };
    })
    .filter((finding) => finding.missing.length > 0);
}

export function formatExternalIntegrationEvidenceDiagnostic(
  findings: ExternalIntegrationEvidenceFinding[],
): string {
  if (findings.length === 0) return "REVISE — External-integration evidence gaps in PROMPT.md: none.";
  const lines = ["REVISE — External-integration evidence gaps in PROMPT.md:"];
  for (const finding of findings) {
    lines.push(`  - ${finding.integrationHint}: missing ${finding.missing.join(", ")}`);
    lines.push(
      "    Fix: add canonical upstream repo/docs/release URL evidence, CLI name in backticks, and checksum or explicit upstream-pending-verification marker.",
    );
  }
  return lines.join("\n");
}
