/*
 * FNXC:Changelog 2026-06-24-15:30:
 * Release-notes distillation module. Transforms parsed changeset entries
 * into grouped, end-user-facing release notes for Fusion operators.
 *
 * FNXC:Changelog 2026-07-13-15:45:
 * Highlights + X draft are AI-authored via the local Claude CLI
 * (`claude -p --model <model>`). Each release gets a fresh engagement-oriented
 * tweet (not a fixed template). Deterministic ranking remains only as a soft
 * fallback so offline/CI releases without Claude never block.
 *
 * FNXC:Changelog 2026-07-24-11:05:
 * Authored by Opus (see DEFAULT_CLAUDE_MODEL), and channel-aware: BOTH channels
 * get an X draft, with beta drafts written as a call for testers carrying the
 * `fn update --channel beta` opt-in.
 */

import { spawnSync } from "node:child_process";
import { CATEGORIES, CATEGORY_HEADINGS } from "./changeset-schema.mjs";

/** Preferred min/max size of the Highlights section when enough entries exist. */
export const HIGHLIGHTS_MIN = 3;
export const HIGHLIGHTS_MAX = 5;

/*
 * FNXC:Changelog 2026-07-24-11:05:
 * Release copy is authored by OPUS, not sonnet: highlights and the X draft are
 * the only release artifacts a human reads verbatim, they are written once per
 * release, and the quality gap shows. Opus is slower, so the CLI budget triples
 * to 4 minutes; the deterministic fallback still covers a timeout.
 * `FUSION_RELEASE_CLAUDE_MODEL` still overrides the model.
 */

/** Wall-clock budget for the Claude CLI call. */
export const RELEASE_LLM_TIMEOUT_MS = 240_000;

/** Default Claude model alias for release distillation. */
export const DEFAULT_CLAUDE_MODEL = "opus";

/** Tweet budget: X's hard cap, and the length below which a draft reads thin. */
export const TWEET_MAX_CHARS = 280;
export const TWEET_TARGET_MIN_CHARS = 200;

/**
 * Lower number = higher highlight priority (deterministic fallback only).
 */
export const HIGHLIGHT_PRIORITY = {
  breaking: 0,
  security: 1,
  feature: 2,
  fix: 3,
  performance: 4,
  internal: 5,
};

/*
 * FNXC:Changelog 2026-07-13-16:10:
 * Tweet links omit the https:// scheme to save characters on X
 * (github.com/.../CHANGELOG.md, or runfusion.ai when still too long).
 *
 * FNXC:Changelog 2026-07-13-16:25:
 * The tweet changelog CTA is always the main-branch file path (not a version tag)
 * so operators land on the live CHANGELOG.md: github.com/Runfusion/Fusion/blob/main/CHANGELOG.md
 */
/** Static scheme-free changelog path used in release tweets. */
export const STATIC_CHANGELOG_URL =
  "github.com/Runfusion/Fusion/blob/main/CHANGELOG.md";

/** Short product link used in tweets when the full changelog URL is too long. */
export const SHORT_RELEASE_URL = "runfusion.ai";

/**
 * System prompt for Claude distillation.
 * Produces highlights, full notes, and an engagement-driving tweet.
 */
export const DISTILLATION_SYSTEM_PROMPT = [
  "You are a release-notes writer and social copywriter for Fusion,",
  "a model-agnostic AI agent orchestration product.",
  "Audience: Fusion operators (developers who run Fusion), not internals.",
  "",
  "Return STRICT JSON only — no markdown fences, no preamble:",
  '{ "highlights": string[3..5], "notes": string, "tweet": string }',
  "",
  /*
   * FNXC:Changelog 2026-07-24-11:05:
   * Highlights are the section operators actually read, so they must name the
   * surface and the outcome. Vague filler ("various improvements", "enhanced
   * reliability") is what made past Highlights sections skimmable-but-useless.
   */
  "highlights:",
  "- The 3–5 changes an operator would most want to know about. Rank by impact:",
  "  breaking > security > the release's headline feature > widely-hit fixes > performance.",
  "- Each item names the SURFACE it lands on (board, Command Center, task detail, CLI,",
  "  dashboard, engine, mobile, desktop, updater…) and the OUTCOME for the operator.",
  "- Lead with the outcome, not the mechanism: \"Board scrolling stays smooth with 200+ tasks\",",
  "  not \"Refactored the kanban virtualization layer\".",
  "- Be concrete. Keep real numbers, versions, limits, and names from the input.",
  "- Merge duplicates: several entries about one area become ONE highlight.",
  "- Banned as vague filler: 'various', 'several improvements', 'under the hood',",
  "  'enhanced', 'better overall', 'general polish', 'misc'.",
  "- Never invent a change that is not in the input. Never name a file, class, or symbol.",
  "- ≤ 100 characters each, sentence case, no trailing period, no markdown.",
  "",
  "notes:",
  "- Markdown body only (no version heading).",
  "- Start with ### Highlights using the same 3–5 items as `- ` bullets.",
  "- Then group under (omit empty): ### New, ### Fixed, ### Breaking, ### Security, ### Performance, ### Internal.",
  "- One `- ` bullet per entry; lightly edit for clarity; no file paths or class names.",
  "- Within a group, most operator-visible first.",
  "",
  /*
   * FNXC:Changelog 2026-07-24-11:05:
   * The X draft must EARN the 280 characters: earlier drafts came back at ~120
   * chars of generic hype and wasted more than half the budget. Specifics from
   * the release are the engagement driver, so the prompt demands named changes
   * and a target length band, and bans the stock launch-announcement voice.
   */
  "tweet:",
  `- Ready to post on X. Hard max ${TWEET_MAX_CHARS} characters including spaces and the URL.`,
  `- USE THE BUDGET: aim for ${TWEET_TARGET_MIN_CHARS}–${TWEET_MAX_CHARS} characters. A short, vague tweet is a failure;`,
  "  spend the room on specifics instead of adjectives. Count characters before answering.",
  "- Open with Fusion + version + colon, no leading v — e.g. \"Fusion 0.58: …\" (drop .0 patch when patch is 0; keep 0.58.1 as-is). Never \"v0.58.0:\" alone.",
  "- After that opener, earn the read: a hook line, then 2–4 CONCRETE changes with their",
  "  real numbers/surfaces, then the link. Line breaks are fine and improve scannability.",
  "- Structure must vary release to release — pick one and commit: sharp one-liner + detail,",
  "  before→after contrast, a stat or limit that surprises, a pointed question, a bold claim",
  "  you then back up, or a tight list. Never reuse the previous release's shape.",
  "- Voice: a technical founder shipping to peers. Confident, specific, a little opinionated.",
  "- Banned openers and filler: 'excited to announce', 'we've been busy', 'thrilled',",
  "  'a lot to unpack', 'game-changer', 'supercharged', 'and much more', 'ships with'.",
  "- Do not enumerate every change — pick the ones a skeptical developer would stop for.",
  "- Include a link: prefer the static GitHub changelog path when it fits.",
  "- Link form: no https:// scheme — always github.com/Runfusion/Fusion/blob/main/CHANGELOG.md (not a version tag).",
  "- If that still exceeds the limit, use runfusion.ai instead.",
  "- Plain text only. At most one hashtag. At most one emoji, and only if it earns its place.",
  "",
  "JSON only.",
].join("\n");

/*
 * FNXC:Changelog 2026-07-24-11:05:
 * Betas get their own X draft too (previously stable-only). A beta post is a
 * call for testers, not a launch: it must say it is a beta and give the real
 * opt-in command (`fn update --channel beta`), so nobody reads a prerelease as
 * generally available.
 */
export const BETA_TWEET_GUIDANCE = [
  "This is a BETA prerelease, not a stable launch. Adjust the tweet accordingly:",
  "- Say plainly that it is a beta; never imply general availability.",
  "- Frame it as a call for testers: what to try, what feedback is useful.",
  "- Include the opt-in command `fn update --channel beta` (it counts toward the character budget).",
  "- Still specific and still ≤ the character limit; keep the same anti-hype rules.",
].join("\n");

/**
 * Build the user-facing prompt for AI distillation.
 *
 * @param {Array<{summary: string, category: string, dev?: string, legacy?: boolean}>} entries
 * @param {string} version
 * @param {string} changelogUrl
 * @returns {string}
 */
export function buildDistillationPrompt(entries, version, changelogUrl, options = {}) {
  const channel = options.channel === "beta" ? "beta" : "stable";
  const opener = `${formatTweetVersionLabel(version)}:`;
  const lines = [
    `Version: ${version}`,
    `Channel: ${channel}`,
    `Tweet opener (required form): ${opener}`,
    `Changelog URL (prefer in the tweet when it fits ≤${TWEET_MAX_CHARS}): ${changelogUrl}`,
    `Short link (use if the full changelog URL won't fit): ${SHORT_RELEASE_URL}`,
    "",
    "Write fresh, engagement-driving release copy from these changeset entries.",
    `Start the tweet with "${opener}" (no leading v; omit trailing .0 patch when patch is 0).`,
    "Do not use a stock \"X is out!\" opener every time — earn the click after that prefix.",
    `Target ${TWEET_TARGET_MIN_CHARS}–${TWEET_MAX_CHARS} characters for the tweet; count them before answering.`,
  ];
  if (channel === "beta") {
    lines.push("", BETA_TWEET_GUIDANCE);
  }
  lines.push("");
  entries.forEach((entry, i) => {
    const num = i + 1;
    lines.push(`[${num}]`);
    lines.push(`  category: ${entry.category}`);
    lines.push(`  summary: ${entry.summary}`);
    if (entry.dev) {
      lines.push(`  dev: ${entry.dev}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Rank and pick the top 3–5 highlight summaries (deterministic fallback only).
 *
 * @param {Array<{summary: string, category: string, legacy?: boolean}>} entries
 * @param {{min?: number, max?: number}} [opts]
 * @returns {string[]}
 */
export function selectHighlights(entries, opts = {}) {
  const min = opts.min ?? HIGHLIGHTS_MIN;
  const max = opts.max ?? HIGHLIGHTS_MAX;

  if (!entries || entries.length === 0) {
    return [];
  }

  const ranked = entries
    .map((entry, index) => ({
      entry,
      index,
      priority: HIGHLIGHT_PRIORITY[entry.category] ?? HIGHLIGHT_PRIORITY.internal,
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.index - b.index;
    });

  const nonInternal = ranked.filter((r) => r.entry.category !== "internal");
  const pool = nonInternal.length >= Math.min(min, ranked.length) ? nonInternal : ranked;

  const count = Math.min(max, pool.length);
  return pool.slice(0, count).map((r) => r.entry.summary);
}

/**
 * Static changelog path for release tweets (scheme-free, always main).
 * @param {string} [_version] - unused; kept for call-site compatibility
 * @returns {string}
 */
export function buildChangelogUrl(_version) {
  return STATIC_CHANGELOG_URL;
}

/**
 * Deterministic tweet formatter (soft fallback only).
 *
 * @param {{version: string, highlights: string[], changelogUrl?: string}} opts
 * @returns {string}
 */
/**
 * Canonical tweet version label: "Fusion 0.58" (drop patch when it is 0).
 * e.g. 0.58.0 → "Fusion 0.58", 0.58.1 → "Fusion 0.58.1". No leading v.
 * @param {string} version
 * @returns {string}
 */
export function formatTweetVersionLabel(version) {
  const bare = String(version || "").replace(/^v/i, "");
  const m = bare.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (m) {
    const [, major, minor, patch, rest] = m;
    const core = Number(patch) === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
    /*
     * FNXC:Changelog 2026-07-24-11:05:
     * Prereleases now get their own opener. Reusing the stable rule produced
     * "Fusion 0.74-beta.0" (patch dropped mid-identifier, unreadable); a beta
     * post reads as "Fusion 0.74 beta:" — the beta counter is noise on X.
     */
    if (rest) {
      const preTag = rest.replace(/^-/, "").split(".")[0];
      return `Fusion ${core} ${preTag || "pre"}`;
    }
    return `Fusion ${core}`;
  }
  return `Fusion ${bare}`;
}

/**
 * Bare version string for tweet matching (patch dropped when 0).
 * @param {string} version
 * @returns {string}
 */
export function formatTweetVersionBare(version) {
  return formatTweetVersionLabel(version).replace(/^Fusion\s+/i, "");
}

export function formatReleaseTweet({ version, highlights = [], changelogUrl }) {
  const url = changelogUrl || buildChangelogUrl(version);
  const header = `${formatTweetVersionLabel(version)}:`;
  const footer = url;

  const fit = (items) => {
    const body = items.length === 0
      ? ""
      : `\n\n${items.map((h) => `• ${h}`).join("\n")}`;
    return `${header}${body}\n\n${footer}`;
  };

  let items = [...highlights];
  let tweet = fit(items);
  while (tweet.length > 280 && items.length > 1) {
    items = items.slice(0, -1);
    tweet = fit(items);
  }

  if (tweet.length > 280 && items.length === 1) {
    const prefix = `${header}\n\n• `;
    const suffix = `\n\n${footer}`;
    const maxSummary = 280 - prefix.length - suffix.length;
    if (maxSummary >= 12) {
      let summary = items[0];
      if (summary.length > maxSummary) {
        summary = `${summary.slice(0, maxSummary - 1).trimEnd()}…`;
      }
      tweet = `${prefix}${summary}${suffix}`;
    }
  }

  if (tweet.length > 280) {
    tweet = `${header}\n\n${footer}`;
  }
  if (tweet.length > 280) {
    tweet = tweet.slice(0, 280);
  }

  return tweet;
}

/**
 * Deterministic fallback when Claude is unavailable.
 *
 * @param {Array<{summary: string, category: string, legacy?: boolean}>} entries
 * @param {string} version
 * @returns {{notes: string, source: "deterministic", highlights: string[], tweet: string}}
 */
export function distillDeterministic(entries, version) {
  const changelogUrl = buildChangelogUrl(version);

  if (!entries || entries.length === 0) {
    return {
      notes: `No changes in v${version}.`,
      source: "deterministic",
      highlights: [],
      tweet: formatReleaseTweet({ version, highlights: [], changelogUrl }),
    };
  }

  const highlights = selectHighlights(entries);

  const groups = new Map();
  for (const cat of CATEGORIES) {
    groups.set(cat, []);
  }

  for (const entry of entries) {
    const cat = groups.has(entry.category) ? entry.category : "internal";
    groups.get(cat).push(entry.summary);
  }

  const sections = [];

  if (highlights.length > 0) {
    const bullets = highlights.map((s) => `- ${s}`).join("\n");
    sections.push(`### Highlights\n\n${bullets}`);
  }

  for (const cat of CATEGORIES) {
    const summaries = groups.get(cat);
    if (summaries.length === 0) continue;

    const heading = CATEGORY_HEADINGS[cat];
    const bullets = summaries.map((s) => `- ${s}`).join("\n");
    sections.push(`### ${heading}\n\n${bullets}`);
  }

  return {
    notes: sections.join("\n\n"),
    source: "deterministic",
    highlights,
    tweet: formatReleaseTweet({ version, highlights, changelogUrl }),
  };
}

/**
 * @param {string} raw
 * @returns {unknown | null}
 */
export function parseJsonFromLlm(raw) {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} parsed
 * @param {string} version
 * @param {string} changelogUrl
 * @returns {{highlights: string[], notes: string, tweet: string} | null}
 */
export function normalizeAiDistillResult(parsed, version, changelogUrl) {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (parsed);

  const highlightsRaw = Array.isArray(obj.highlights) ? obj.highlights : null;
  if (!highlightsRaw || highlightsRaw.length === 0) return null;

  const highlights = highlightsRaw
    .filter((h) => typeof h === "string" && h.trim())
    .map((h) => h.trim())
    .slice(0, HIGHLIGHTS_MAX);
  if (highlights.length === 0) return null;

  const notes = typeof obj.notes === "string" ? obj.notes.trim() : "";
  if (!notes) return null;

  let notesOut = notes;
  if (!/^###\s+Highlights\b/m.test(notesOut)) {
    const bullets = highlights.map((s) => `- ${s}`).join("\n");
    notesOut = `### Highlights\n\n${bullets}\n\n${notesOut}`;
  }

  let tweet = typeof obj.tweet === "string" ? obj.tweet.trim() : "";
  if (!tweet) {
    tweet = formatReleaseTweet({ version, highlights, changelogUrl });
  }

  tweet = fitTweetToBudget(tweet, {
    version,
    highlights,
    changelogUrl,
  });

  return { highlights, notes: notesOut, tweet };
}

/**
 * Ensure a tweet is ≤280 chars. Prefer the full changelog URL; if too long,
 * swap to runfusion.ai (no scheme), then trim prose before the link if needed.
 *
 * @param {string} tweet
 * @param {{version: string, highlights: string[], changelogUrl: string}} ctx
 * @returns {string}
 */
export function fitTweetToBudget(tweet, { version, highlights, changelogUrl }) {
  let out = (tweet || "").trim();
  if (!out) {
    return formatReleaseTweet({ version, highlights, changelogUrl });
  }

  // Normalize any https:// forms the model may still emit.
  out = stripTweetLinkSchemes(out, changelogUrl);
  // Prefer "Fusion 0.58.0:" over bare "v0.58.0:" openers.
  out = ensureFusionVersionPrefix(out, version);

  const hasFull = out.includes(changelogUrl);
  const hasShort = out.includes(SHORT_RELEASE_URL);

  // Prefer attaching the GitHub changelog path when missing and it still fits.
  if (!hasFull && !hasShort && out.length + 1 + changelogUrl.length <= 280) {
    out = `${out}\n${changelogUrl}`;
  }

  if (out.length <= 280) {
    return out;
  }

  // Too long with the GitHub path — swap to the short product link.
  if (out.includes(changelogUrl)) {
    out = out.split(changelogUrl).join(SHORT_RELEASE_URL);
  } else if (!out.includes(SHORT_RELEASE_URL)) {
    out = out.replace(
      /(?:https?:\/\/)?github\.com\/Runfusion\/Fusion\/[^\s]+/g,
      SHORT_RELEASE_URL,
    );
  }

  if (out.length <= 280) {
    return out;
  }

  // Still over: keep the short URL, trim prose before it (never mid-link).
  const shortIdx = out.indexOf(SHORT_RELEASE_URL);
  if (shortIdx > 0) {
    const bodyBudget = 280 - SHORT_RELEASE_URL.length - 1;
    let body = out.slice(0, shortIdx).trimEnd();
    if (body.length > bodyBudget) {
      body = `${body.slice(0, Math.max(0, bodyBudget - 1)).trimEnd()}…`;
    }
    out = `${body}\n${SHORT_RELEASE_URL}`;
  } else if (out.length + 1 + SHORT_RELEASE_URL.length <= 280) {
    out = `${out}\n${SHORT_RELEASE_URL}`;
  } else {
    // Last resort: rebuild with short link so the CTA still fits.
    out = formatReleaseTweet({
      version,
      highlights,
      changelogUrl: SHORT_RELEASE_URL,
    });
  }

  if (out.length > 280) {
    out = formatReleaseTweet({
      version,
      highlights,
      changelogUrl: SHORT_RELEASE_URL,
    });
  }

  return out;
}

/**
 * Drop https:// from known release links so tweets stay scheme-free.
 * @param {string} text
 * @param {string} changelogUrl - scheme-free github.com/... path
 * @returns {string}
 */
export function stripTweetLinkSchemes(text, changelogUrl) {
  let out = text;
  out = out.replace(/https?:\/\/(?:www\.)?runfusion\.ai\/?/gi, SHORT_RELEASE_URL);
  // Any GitHub CHANGELOG link (scheme or version tag) → static main path.
  out = out.replace(
    /(?:https?:\/\/)?github\.com\/Runfusion\/Fusion\/blob\/(?:main|v[\w.-]+)\/CHANGELOG\.md/g,
    changelogUrl || STATIC_CHANGELOG_URL,
  );
  return out;
}

/**
 * Ensure the tweet opens with "Fusion <version>:" (no leading v on the number).
 * Rewrites common "vX.Y.Z:" / "Fusion vX.Y.Z" openers.
 *
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
export function ensureFusionVersionPrefix(text, version) {
  const label = formatTweetVersionLabel(version);
  const bareFull = String(version || "").replace(/^v/i, "");
  const bareDisplay = formatTweetVersionBare(version);
  // Match full semver or display form (with/without .0 patch).
  const versionAlt = bareFull === bareDisplay
    ? escapeRegExp(bareFull)
    : `(?:${escapeRegExp(bareFull)}|${escapeRegExp(bareDisplay)})`;
  let out = (text || "").trim();
  if (!out) return `${label}:`;

  // "Fusion v0.58.0" / "Fusion 0.58 is out" → "Fusion 0.58:"
  out = out.replace(
    new RegExp(`^Fusion\\s+v?${versionAlt}(?:\\s+is\\s+out!?)?\\s*:?\\s*`, "i"),
    `${label}: `,
  );
  // Bare "v0.58.0:" / "0.58:" opener → "Fusion 0.58:"
  out = out.replace(
    new RegExp(`^v?${versionAlt}\\s*:\\s*`, "i"),
    `${label}: `,
  );

  if (!new RegExp(`^Fusion\\s+${escapeRegExp(bareDisplay)}\\s*:`, "i").test(out)) {
    out = `${label}: ${out}`;
  }

  // Collapse accidental double spaces after the colon.
  return out.replace(/^([^:]+:)\s+/, "$1 ").trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve Claude CLI binary + model from env.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{claudeBin: string, model: string}}
 */
export function resolveClaudeDistillConfig(env = process.env) {
  return {
    claudeBin: env.FUSION_RELEASE_CLAUDE_BIN || "claude",
    model: env.FUSION_RELEASE_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
  };
}

/**
 * Call local Claude CLI headless: `claude -p --model sonnet`.
 * Tools disabled so this is a pure text completion.
 *
 * @param {{
 *   system: string,
 *   user: string,
 *   claudeBin?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawnSync,
 * }} opts
 * @returns {string | null}
 */
export function chatViaClaudeCli(opts) {
  const {
    system,
    user,
    claudeBin = "claude",
    model = DEFAULT_CLAUDE_MODEL,
    timeoutMs = RELEASE_LLM_TIMEOUT_MS,
    spawnImpl = spawnSync,
  } = opts;

  // Combined prompt: Claude --system-prompt can be long; keep it simple and reliable.
  const prompt = `${system}\n\n---\n\n${user}`;

  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "text",
    // No tools: pure generation for release copy.
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
  ];

  const r = spawnImpl(claudeBin, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });

  if (r.error || r.status !== 0) {
    return null;
  }
  const out = (r.stdout || "").trim();
  return out || null;
}

/**
 * Attempt Claude AI distillation. Returns null when Claude is unavailable or output is invalid.
 *
 * @param {Array<{summary: string, category: string, dev?: string, legacy?: boolean}>} entries
 * @param {string} version
 * @param {{
 *   changelogUrl?: string,
 *   env?: Record<string, string | undefined>,
 *   chatComplete?: (args: {system: string, user: string}) => Promise<string | null> | string | null,
 *   allowClaudeCli?: boolean,
 *   channel?: "beta" | "stable",
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawnSync,
 * }} [options]
 * @returns {Promise<{notes: string, source: "ai", highlights: string[], tweet: string} | null>}
 */
export async function distillWithAi(entries, version, options = {}) {
  if (!entries || entries.length === 0) return null;

  const changelogUrl = options.changelogUrl || buildChangelogUrl(version);
  const system = DISTILLATION_SYSTEM_PROMPT;
  const user = buildDistillationPrompt(entries, version, changelogUrl, {
    channel: options.channel,
  });

  let raw = null;

  if (typeof options.chatComplete === "function") {
    raw = await options.chatComplete({ system, user });
  } else if (options.allowClaudeCli !== false) {
    const cfg = resolveClaudeDistillConfig(options.env || process.env);
    raw = chatViaClaudeCli({
      system,
      user,
      claudeBin: cfg.claudeBin,
      model: cfg.model,
      timeoutMs: options.timeoutMs ?? RELEASE_LLM_TIMEOUT_MS,
      spawnImpl: options.spawnImpl,
    });
  }

  if (!raw) return null;
  const parsed = parseJsonFromLlm(raw);
  const normalized = normalizeAiDistillResult(parsed, version, changelogUrl);
  if (!normalized) return null;

  return {
    notes: normalized.notes,
    highlights: normalized.highlights,
    tweet: normalized.tweet,
    source: "ai",
  };
}

/**
 * Distill release notes: Claude AI first, deterministic soft fallback.
 *
 * @param {Array<{summary: string, category: string, dev?: string, legacy?: boolean}>} entries
 * @param {string} version
 * @param {Parameters<typeof distillWithAi>[2]} [options]
 * @returns {Promise<{notes: string, source: "ai" | "deterministic", highlights: string[], tweet: string}>}
 */
export async function distillReleaseNotes(entries, version, options = {}) {
  try {
    const ai = await distillWithAi(entries, version, options);
    if (ai) return ai;
  } catch {
    // Soft fallback — release must never fail on distillation.
  }
  return distillDeterministic(entries, version);
}
