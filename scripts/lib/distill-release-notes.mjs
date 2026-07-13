/*
 * FNXC:Changelog 2026-06-24-15:30:
 * Release-notes distillation module. Transforms parsed changeset entries
 * into grouped, end-user-facing release notes for Fusion operators.
 *
 * FNXC:Changelog 2026-07-13-15:45:
 * Highlights + X draft are AI-authored via the local Claude CLI
 * (`claude -p --model sonnet`). Each release gets a fresh engagement-oriented
 * tweet (not a fixed template). Deterministic ranking remains only as a soft
 * fallback so offline/CI releases without Claude never block.
 */

import { spawnSync } from "node:child_process";
import { CATEGORIES, CATEGORY_HEADINGS } from "./changeset-schema.mjs";

/** Preferred min/max size of the Highlights section when enough entries exist. */
export const HIGHLIGHTS_MIN = 3;
export const HIGHLIGHTS_MAX = 5;

/** Wall-clock budget for the Claude CLI call. */
export const RELEASE_LLM_TIMEOUT_MS = 90_000;

/** Default Claude model alias for release distillation. */
export const DEFAULT_CLAUDE_MODEL = "sonnet";

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
  "highlights:",
  "- Top 3–5 user-facing changes (prefer breaking, security, features, then fixes).",
  "- Punchy, benefit-led phrasing. Do not invent features not in the input.",
  "- One short phrase/sentence per item; no markdown inside the strings.",
  "",
  "notes:",
  "- Markdown body only (no version heading).",
  "- Start with ### Highlights using the same 3–5 items as `- ` bullets.",
  "- Then group under (omit empty): ### New, ### Fixed, ### Breaking, ### Security, ### Performance, ### Internal.",
  "- One `- ` bullet per entry; lightly edit for clarity; no file paths or class names.",
  "",
  "tweet:",
  "- Ready to post on X. Hard max 280 characters including spaces and the URL.",
  "- Goal: drive engagement (curiosity, replies, clicks) — not a dry changelog dump.",
  "- Vary tone per release (excited, wry, bold, founder-voice). Never reuse a fixed template.",
  "- Open with Fusion + version + colon, no leading v — e.g. \"Fusion 0.58: …\" (drop .0 patch when patch is 0; keep 0.58.1 as-is). Never \"v0.58.0:\" alone.",
  "- Include a link: prefer the static GitHub changelog path when it fits.",
  "- Link form: no https:// scheme — always github.com/Runfusion/Fusion/blob/main/CHANGELOG.md (not a version tag).",
  "- If that still exceeds 280 chars, use runfusion.ai instead.",
  "- Weave 2–4 of the highlights into a scroll-stopping hook; questions, contrast, or a bold claim are fine.",
  "- Plain text only. At most one hashtag. Emoji optional and sparse.",
  "",
  "JSON only.",
].join("\n");

/**
 * Build the user-facing prompt for AI distillation.
 *
 * @param {Array<{summary: string, category: string, dev?: string, legacy?: boolean}>} entries
 * @param {string} version
 * @param {string} changelogUrl
 * @returns {string}
 */
export function buildDistillationPrompt(entries, version, changelogUrl) {
  const opener = `${formatTweetVersionLabel(version)}:`;
  const lines = [
    `Version: ${version}`,
    `Tweet opener (required form): ${opener}`,
    `Changelog URL (prefer in the tweet when it fits ≤280): ${changelogUrl}`,
    `Short link (use if the full changelog URL won't fit): ${SHORT_RELEASE_URL}`,
    "",
    "Write fresh, engagement-driving release copy from these changeset entries.",
    `Start the tweet with "${opener}" (no leading v; omit trailing .0 patch when patch is 0).`,
    "Do not use a stock \"X is out!\" opener every time — earn the click after that prefix.\n",
  ];
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
    const display = Number(patch) === 0
      ? `${major}.${minor}${rest}`
      : `${major}.${minor}.${patch}${rest}`;
    return `Fusion ${display}`;
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
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawnSync,
 * }} [options]
 * @returns {Promise<{notes: string, source: "ai", highlights: string[], tweet: string} | null>}
 */
export async function distillWithAi(entries, version, options = {}) {
  if (!entries || entries.length === 0) return null;

  const changelogUrl = options.changelogUrl || buildChangelogUrl(version);
  const system = DISTILLATION_SYSTEM_PROMPT;
  const user = buildDistillationPrompt(entries, version, changelogUrl);

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
