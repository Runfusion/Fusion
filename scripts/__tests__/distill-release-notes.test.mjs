import test from "node:test";
import assert from "node:assert/strict";

import {
  distillDeterministic,
  distillReleaseNotes,
  distillWithAi,
  buildDistillationPrompt,
  DISTILLATION_SYSTEM_PROMPT,
  selectHighlights,
  formatReleaseTweet,
  formatTweetVersionLabel,
  ensureFusionVersionPrefix,
  buildChangelogUrl,
  parseJsonFromLlm,
  normalizeAiDistillResult,
  fitTweetToBudget,
  SHORT_RELEASE_URL,
  HIGHLIGHTS_MAX,
} from "../lib/distill-release-notes.mjs";

// --- distillDeterministic ---

test("groups entries by category in display order", () => {
  const entries = [
    { summary: "Fix mobile keyboard popup.", category: "fix", legacy: false },
    { summary: "Add LOC backfill control.", category: "feature", legacy: false },
    { summary: "Fix stale agent assignments.", category: "fix", legacy: false },
    { summary: "Remove deprecated API.", category: "breaking", legacy: false },
  ];
  const { notes, source } = distillDeterministic(entries, "1.0.0");
  assert.equal(source, "deterministic");

  // Feature section comes first among category sections; Highlights lead the doc.
  const highlightsIdx = notes.indexOf("### Highlights");
  const featureIdx = notes.indexOf("### New");
  const fixIdx = notes.indexOf("### Fixed");
  const breakingIdx = notes.indexOf("### Breaking");
  assert.ok(highlightsIdx > -1);
  assert.ok(highlightsIdx < featureIdx);
  assert.ok(featureIdx > -1);
  assert.ok(featureIdx < fixIdx);
  assert.ok(fixIdx < breakingIdx);
});

test("omits empty categories", () => {
  const entries = [
    { summary: "Add feature X.", category: "feature", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  assert.match(notes, /### New/);
  assert.doesNotMatch(notes, /### Fixed/);
  assert.doesNotMatch(notes, /### Breaking/);
  assert.doesNotMatch(notes, /### Security/);
  assert.doesNotMatch(notes, /### Performance/);
});

test("groups multiple entries in same category", () => {
  const entries = [
    { summary: "Fix bug A.", category: "fix", legacy: false },
    { summary: "Fix bug B.", category: "fix", legacy: false },
    { summary: "Fix bug C.", category: "fix", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  assert.match(notes, /### Fixed/);
  assert.match(notes, /Fix bug A\./);
  assert.match(notes, /Fix bug B\./);
  assert.match(notes, /Fix bug C\./);
  // All three should be in the same section.
  const fixedSection = notes.split("### Fixed")[1];
  assert.ok(fixedSection.includes("Fix bug A."));
  assert.ok(fixedSection.includes("Fix bug B."));
  assert.ok(fixedSection.includes("Fix bug C."));
});

test("handles empty entries array", () => {
  const { notes, source, highlights } = distillDeterministic([], "1.0.0");
  assert.equal(source, "deterministic");
  assert.match(notes, /No changes in v1\.0\.0/);
  assert.deepEqual(highlights, []);
});

test("handles null/undefined entries", () => {
  const { notes, highlights } = distillDeterministic(null, "1.0.0");
  assert.match(notes, /No changes/);
  assert.deepEqual(highlights, []);
});

test("single entry produces Highlights plus category section", () => {
  const entries = [
    { summary: "Add cool feature.", category: "feature", legacy: false },
  ];
  const { notes, highlights } = distillDeterministic(entries, "2.0.0");
  assert.deepEqual(highlights, ["Add cool feature."]);
  assert.match(notes, /^### Highlights\n\n- Add cool feature\.\n\n### New\n\n- Add cool feature\.$/);
});

test("includes internal category when entries exist", () => {
  const entries = [
    { summary: "Refactor internal modules.", category: "internal", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  assert.match(notes, /### Internal/);
});

test("handles legacy entries with category defaulting to internal", () => {
  const entries = [
    { summary: "Fix a bug in the parser.", category: "internal", legacy: true },
    { summary: "Add new dashboard widget.", category: "feature", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  assert.match(notes, /### New/);
  assert.match(notes, /### Internal/);
  // Feature comes before internal in display order.
  assert.ok(notes.indexOf("### New") < notes.indexOf("### Internal"));
});

test("unknown category falls back to internal", () => {
  const entries = [
    { summary: "Mystery change.", category: "unknown_cat", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  assert.match(notes, /### Internal/);
  assert.match(notes, /Mystery change\./);
});

test("preserves entry order within categories", () => {
  const entries = [
    { summary: "First fix.", category: "fix", legacy: false },
    { summary: "Second fix.", category: "fix", legacy: false },
    { summary: "A feature.", category: "feature", legacy: false },
    { summary: "Third fix.", category: "fix", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  const fixedSection = notes.split("### Fixed")[1];
  const firstIdx = fixedSection.indexOf("First fix.");
  const secondIdx = fixedSection.indexOf("Second fix.");
  const thirdIdx = fixedSection.indexOf("Third fix.");
  assert.ok(firstIdx < secondIdx);
  assert.ok(secondIdx < thirdIdx);
});

test("multiple categories render in correct order", () => {
  const entries = [
    { summary: "Security patch.", category: "security", legacy: false },
    { summary: "New feature.", category: "feature", legacy: false },
    { summary: "Performance boost.", category: "performance", legacy: false },
    { summary: "Breaking change.", category: "breaking", legacy: false },
    { summary: "Bug fix.", category: "fix", legacy: false },
    { summary: "Internal cleanup.", category: "internal", legacy: false },
  ];
  const { notes } = distillDeterministic(entries, "1.0.0");
  const order = ["### Highlights", "### New", "### Fixed", "### Breaking", "### Security", "### Performance", "### Internal"]
    .map((h) => notes.indexOf(h));
  // Each should be found and in ascending order.
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(order[i] > -1, `heading ${i} not found`);
    assert.ok(order[i] < order[i + 1], `headings ${i} and ${i + 1} out of order`);
  }
});

test("returns highlights alongside notes", () => {
  const entries = [
    { summary: "Breaking API.", category: "breaking", legacy: false },
    { summary: "New widget.", category: "feature", legacy: false },
    { summary: "Bug fix.", category: "fix", legacy: false },
  ];
  const { notes, highlights } = distillDeterministic(entries, "1.0.0");
  assert.equal(highlights.length, 3);
  assert.equal(highlights[0], "Breaking API.");
  assert.match(notes, /### Highlights/);
  for (const h of highlights) {
    assert.ok(notes.includes(`- ${h}`));
  }
});

// --- selectHighlights ---

test("selectHighlights prefers breaking and security over features", () => {
  const entries = [
    { summary: "Feature A.", category: "feature", legacy: false },
    { summary: "Security fix.", category: "security", legacy: false },
    { summary: "Breaking change.", category: "breaking", legacy: false },
    { summary: "Feature B.", category: "feature", legacy: false },
  ];
  const highlights = selectHighlights(entries);
  assert.equal(highlights[0], "Breaking change.");
  assert.equal(highlights[1], "Security fix.");
  assert.ok(highlights.includes("Feature A."));
});

test("selectHighlights caps at HIGHLIGHTS_MAX", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    summary: `Feature ${i}.`,
    category: "feature",
    legacy: false,
  }));
  const highlights = selectHighlights(entries);
  assert.equal(highlights.length, HIGHLIGHTS_MAX);
});

test("selectHighlights returns fewer than min when release is small", () => {
  const entries = [
    { summary: "Only one.", category: "feature", legacy: false },
    { summary: "Only two.", category: "fix", legacy: false },
  ];
  const highlights = selectHighlights(entries);
  assert.equal(highlights.length, 2);
});

test("selectHighlights prefers non-internal when enough user-facing exist", () => {
  const entries = [
    { summary: "Internal A.", category: "internal", legacy: false },
    { summary: "Feature A.", category: "feature", legacy: false },
    { summary: "Feature B.", category: "feature", legacy: false },
    { summary: "Feature C.", category: "feature", legacy: false },
    { summary: "Internal B.", category: "internal", legacy: false },
  ];
  const highlights = selectHighlights(entries);
  assert.ok(highlights.every((h) => !h.startsWith("Internal")));
  assert.equal(highlights.length, 3);
});

test("selectHighlights falls back to internal when no user-facing entries", () => {
  const entries = [
    { summary: "Internal A.", category: "internal", legacy: false },
    { summary: "Internal B.", category: "internal", legacy: false },
  ];
  const highlights = selectHighlights(entries);
  assert.deepEqual(highlights, ["Internal A.", "Internal B."]);
});

// --- formatReleaseTweet ---

test("formatReleaseTweet stays within 280 characters", () => {
  const highlights = [
    "Add an interactive worktree-rooted Terminal tab to the task detail view.",
    "Agents can now add files to a task's File Scope while working.",
    "Agents save screenshots, videos, HTML mockups, and PDFs as artifacts.",
    "Add a persistent Advanced settings toggle for uncommon Settings sections.",
    "Guide repeatable Compound Engineering cycles from product grounding.",
  ];
  const tweet = formatReleaseTweet({ version: "0.58.0", highlights });
  assert.ok(tweet.length <= 280, `tweet length ${tweet.length} exceeds 280`);
  assert.match(tweet, /^Fusion 0\.58:/);
  assert.match(tweet, /github\.com\/Runfusion\/Fusion\/blob\/main\/CHANGELOG\.md/);
  assert.doesNotMatch(tweet, /https?:\/\//);
});

test("formatReleaseTweet includes version and changelog link with no highlights", () => {
  const tweet = formatReleaseTweet({ version: "1.2.3", highlights: [] });
  assert.ok(tweet.length <= 280);
  assert.match(tweet, /^Fusion 1\.2\.3:/);
  assert.match(tweet, /github\.com\/Runfusion\/Fusion\/blob\/main\/CHANGELOG\.md/);
  assert.doesNotMatch(tweet, /•/);
});

test("formatReleaseTweet truncates when a single highlight is very long", () => {
  const long = "A".repeat(400);
  const tweet = formatReleaseTweet({ version: "9.9.9", highlights: [long] });
  assert.ok(tweet.length <= 280, `tweet length ${tweet.length}`);
  assert.match(tweet, /^Fusion 9\.9\.9:/);
  assert.match(tweet, /…/);
  assert.match(tweet, /github\.com\/Runfusion\/Fusion\/blob\/main\/CHANGELOG\.md/);
});

test("formatReleaseTweet drops excess highlights to stay under budget", () => {
  const highlights = Array.from({ length: 5 }, (_, i) =>
    `This is a fairly long highlight number ${i} describing a user-facing change in detail.`,
  );
  const tweet = formatReleaseTweet({ version: "0.1.0", highlights });
  assert.ok(tweet.length <= 280);
  // At least one bullet should survive when space allows.
  assert.match(tweet, /•/);
});

test("buildChangelogUrl is always main CHANGELOG without https", () => {
  assert.equal(
    buildChangelogUrl("0.58.0"),
    "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md",
  );
  assert.equal(buildChangelogUrl("9.9.9"), buildChangelogUrl("0.1.0"));
});

// --- buildDistillationPrompt ---

test("builds prompt with all entries", () => {
  const entries = [
    { summary: "Add feature.", category: "feature", legacy: false, dev: "Uses tool X." },
    { summary: "Fix bug.", category: "fix", legacy: false },
  ];
  const prompt = buildDistillationPrompt(entries, "1.0.0", "https://example.com/CHANGELOG.md");
  assert.match(prompt, /Version: 1\.0\.0/);
  assert.match(prompt, /Tweet opener \(required form\): Fusion 1\.0:/);
  assert.match(prompt, /Changelog URL/);
  assert.match(prompt, /\[1\]/);
  assert.match(prompt, /\[2\]/);
  assert.match(prompt, /category: feature/);
  assert.match(prompt, /summary: Add feature\./);
  assert.match(prompt, /dev: Uses tool X\./);
});

test("builds prompt without dev for entries lacking it", () => {
  const entries = [
    { summary: "Fix bug.", category: "fix", legacy: false },
  ];
  const prompt = buildDistillationPrompt(entries, "1.0.0", "https://example.com/CHANGELOG.md");
  assert.doesNotMatch(prompt, /dev:/);
});

// --- DISTILLATION_SYSTEM_PROMPT ---

test("system prompt contains key instructions", () => {
  assert.match(DISTILLATION_SYSTEM_PROMPT, /release-notes/i);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /operator/i);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /### Highlights/);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /### New/);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /### Fixed/);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /engagement/i);
  assert.match(DISTILLATION_SYSTEM_PROMPT, /280/);
});

// --- AI path (injected chatComplete; no live Claude required) ---

test("distillWithAi uses chatComplete and returns source ai", async () => {
  const entries = [
    { summary: "Add Terminal tab on tasks.", category: "feature", legacy: false },
    { summary: "Agents can expand File Scope mid-run.", category: "feature", legacy: false },
    { summary: "Artifacts gallery for screenshots and videos.", category: "feature", legacy: false },
  ];
  const aiPayload = {
    highlights: [
      "Task Terminal tab rooted in the worktree",
      "Agents expand File Scope as they work",
      "Artifacts gallery for media deliverables",
    ],
    notes: [
      "### Highlights",
      "",
      "- Task Terminal tab rooted in the worktree",
      "- Agents expand File Scope as they work",
      "- Artifacts gallery for media deliverables",
      "",
      "### New",
      "",
      "- Add Terminal tab on tasks.",
      "- Agents can expand File Scope mid-run.",
      "- Artifacts gallery for screenshots and videos.",
    ].join("\n"),
    tweet:
      "Fusion 0.58: Terminals in the worktree, File Scope that grows with the agent, and an Artifacts gallery that actually shows the work.\ngithub.com/Runfusion/Fusion/blob/main/CHANGELOG.md",
  };
  const result = await distillWithAi(entries, "0.58.0", {
    chatComplete: async () => JSON.stringify(aiPayload),
  });
  assert.ok(result);
  assert.equal(result.source, "ai");
  assert.equal(result.highlights.length, 3);
  assert.ok(result.tweet.length <= 280);
  assert.match(result.notes, /### Highlights/);
  assert.match(result.tweet, /Fusion 0\.58:/);
});

test("distillReleaseNotes falls back when AI is unavailable", async () => {
  const entries = [
    { summary: "Add feature X.", category: "feature", legacy: false },
  ];
  const result = await distillReleaseNotes(entries, "1.2.3", {
    chatComplete: async () => null,
  });
  assert.equal(result.source, "deterministic");
  assert.match(result.notes, /### Highlights/);
  assert.ok(result.tweet.length <= 280);
});

test("parseJsonFromLlm strips fences", () => {
  const parsed = parseJsonFromLlm('```json\n{"highlights":["A"],"notes":"### Highlights\\n\\n- A","tweet":"hi"}\n```');
  assert.deepEqual(parsed.highlights, ["A"]);
});

test("normalizeAiDistillResult injects missing Highlights heading", () => {
  const changelogUrl = "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";
  const normalized = normalizeAiDistillResult(
    {
      highlights: ["One thing", "Two thing", "Three thing"],
      notes: "### New\n\n- One thing",
      tweet: `Fusion v1.0.0 shipped three things.\n${changelogUrl}`,
    },
    "1.0.0",
    changelogUrl,
  );
  assert.ok(normalized);
  assert.match(normalized.notes, /^### Highlights/);
});

test("formatTweetVersionLabel drops leading v and .0 patch", () => {
  assert.equal(formatTweetVersionLabel("0.58.0"), "Fusion 0.58");
  assert.equal(formatTweetVersionLabel("v0.58.0"), "Fusion 0.58");
  assert.equal(formatTweetVersionLabel("0.58.1"), "Fusion 0.58.1");
  assert.equal(formatTweetVersionLabel("1.0.0"), "Fusion 1.0");
});

test("ensureFusionVersionPrefix rewrites bare vX openers", () => {
  assert.equal(
    ensureFusionVersionPrefix("v0.58.0: terminals in task detail", "0.58.0"),
    "Fusion 0.58: terminals in task detail",
  );
  assert.equal(
    ensureFusionVersionPrefix("Fusion v0.58.0 is out! terminals", "0.58.0"),
    "Fusion 0.58: terminals",
  );
  assert.equal(
    ensureFusionVersionPrefix("Fusion 0.58.1: patch release", "0.58.1"),
    "Fusion 0.58.1: patch release",
  );
});

test("fitTweetToBudget keeps GitHub changelog path when under 280", () => {
  const changelogUrl = "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";
  const tweet = `Fusion 0.58: Terminals in task detail.\n${changelogUrl}`;
  const fit = fitTweetToBudget(tweet, {
    version: "0.58.0",
    highlights: ["Terminals in task detail"],
    changelogUrl,
  });
  assert.ok(fit.length <= 280);
  assert.ok(fit.includes(changelogUrl));
  assert.match(fit, /^Fusion 0\.58:/);
  assert.doesNotMatch(fit, /https?:\/\//);
});

test("fitTweetToBudget strips https and version tags to static main path", () => {
  const changelogUrl = "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";
  const tweet =
    "Fusion v0.58.0: Terminals in task detail.\nhttps://github.com/Runfusion/Fusion/blob/v0.58.0/CHANGELOG.md";
  const fit = fitTweetToBudget(tweet, {
    version: "0.58.0",
    highlights: ["Terminals in task detail"],
    changelogUrl,
  });
  assert.ok(fit.includes(changelogUrl));
  assert.doesNotMatch(fit, /https?:\/\//);
  assert.doesNotMatch(fit, /blob\/v0\.58\.0\//);
});

test("fitTweetToBudget swaps to runfusion.ai when full changelog URL is too long", () => {
  const changelogUrl = "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";
  // Long prose + full changelog path intentionally over 280.
  const body =
    "Fusion 0.58: your agents can now open a real terminal in the task itself, grab extra files into scope mid-run instead of stranding edits, and stash screenshots/videos/PDFs in a proper artifact gallery. Grok CLI joins as a bundled runtime plugin too.";
  const tweet = `${body}\n${changelogUrl}`;
  assert.ok(tweet.length > 280, "precondition: over budget");
  const fit = fitTweetToBudget(tweet, {
    version: "0.58.0",
    highlights: ["Terminal", "File Scope", "Artifacts"],
    changelogUrl,
  });
  assert.ok(fit.length <= 280, `fit length ${fit.length}`);
  assert.match(fit, /^Fusion 0\.58:/);
  assert.ok(fit.includes(SHORT_RELEASE_URL), "should use short product link");
  assert.ok(!fit.includes(changelogUrl), "should drop full changelog URL");
  assert.doesNotMatch(fit, /https?:\/\//);
});

test("normalizeAiDistillResult uses short URL when AI tweet is over budget", () => {
  const changelogUrl = "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";
  const longTweet =
    "v0.58.0 ships a worktree Terminal tab, mid-task File Scope expansion so edits never strand at merge, a full artifact gallery for screenshots videos and PDFs, plus Grok CLI as a bundled plugin with thinking-level controls everywhere. " +
    changelogUrl;
  assert.ok(longTweet.length > 280);
  const normalized = normalizeAiDistillResult(
    {
      highlights: ["Terminal tab", "File Scope expansion", "Artifact gallery"],
      notes: "### Highlights\n\n- Terminal tab\n- File Scope expansion\n- Artifact gallery",
      tweet: longTweet,
    },
    "0.58.0",
    changelogUrl,
  );
  assert.ok(normalized);
  assert.ok(normalized.tweet.length <= 280);
  assert.ok(normalized.tweet.includes(SHORT_RELEASE_URL));
  assert.doesNotMatch(normalized.tweet, /https?:\/\//);
});
