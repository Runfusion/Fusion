import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as child_process from "node:child_process";
import { promisify } from "node:util";

/**
 * Pace information for weekly usage windows
 */
export interface UsagePace {
  status: "ahead" | "on-track" | "behind";
  percentElapsed: number; // 0-100
  message: string;
}

/**
 * Usage window for a provider (e.g., "Session (5h)", "Weekly")
 */
export interface UsageWindow {
  label: string;
  percentUsed: number; // 0-100
  percentLeft: number; // 0-100
  resetText: string | null; // e.g., "resets in 2h"
  resetMs?: number; // ms until reset
  windowDurationMs?: number; // total window length
  pace?: UsagePace; // pace indicator for weekly windows
}

/**
 * Provider usage data
 */
export interface ProviderUsage {
  name: string;
  icon: string; // emoji
  status: "ok" | "error" | "no-auth";
  error?: string;
  plan?: string | null;
  email?: string | null;
  windows: UsageWindow[];
}

/**
 * Auth storage interface - minimal interface matching pi-coding-agent's AuthStorage
 */
export interface AuthStorageLike {
  reload(): void;
  hasAuth(provider: string): boolean;
}

// Cache for usage data with TTL
interface CacheEntry {
  data: ProviderUsage[];
  timestamp: number;
}

let usageCache: CacheEntry | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

// Pace threshold - matches frontend UsageIndicator.tsx
const PACE_THRESHOLD = 5; // 5% threshold for "on pace"

/**
 * Calculate pace information for a usage window.
 * Returns undefined if pace cannot be calculated (e.g., missing timing data or window reset).
 */
export function calculatePace(
  percentUsed: number,
  resetMs: number | undefined,
  windowDurationMs: number | undefined
): UsagePace | undefined {
  // Validate inputs
  if (resetMs === undefined || windowDurationMs === undefined) {
    return undefined;
  }

  // Window already reset or invalid duration
  if (resetMs <= 0 || windowDurationMs <= 0) {
    return undefined;
  }

  // Clamp percentUsed to valid range
  const clampedPercentUsed = Math.min(100, Math.max(0, percentUsed));

  // Calculate percent of time elapsed in the window
  // percentElapsed = 100 - (remainingTime / totalTime * 100)
  const percentElapsed = 100 - (resetMs / windowDurationMs * 100);

  // Calculate delta between usage and elapsed time
  const paceDelta = clampedPercentUsed - percentElapsed;

  // Determine status based on threshold
  if (paceDelta > PACE_THRESHOLD) {
    return {
      status: "ahead",
      percentElapsed: Math.round(percentElapsed),
      message: `${Math.abs(Math.round(paceDelta))}% over pace`,
    };
  } else if (paceDelta < -PACE_THRESHOLD) {
    return {
      status: "behind",
      percentElapsed: Math.round(percentElapsed),
      message: `${Math.abs(Math.round(paceDelta))}% under pace`,
    };
  } else {
    return {
      status: "on-track",
      percentElapsed: Math.round(percentElapsed),
      message: "On pace with time elapsed",
    };
  }
}

/**
 * Apply pace calculation to a usage window if applicable.
 * Applies to any window with valid timing data (resetMs and windowDurationMs).
 */
function applyPaceToWindow(window: UsageWindow): UsageWindow {
  // Apply pace to any window that has both resetMs and windowDurationMs
  if (window.resetMs === undefined || window.windowDurationMs === undefined) {
    return window;
  }

  const pace = calculatePace(window.percentUsed, window.resetMs, window.windowDurationMs);
  if (pace) {
    return { ...window, pace };
  }
  return window;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Make HTTPS request and return response
 */
function httpsRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  }
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") hdrs[k.toLowerCase()] = v;
            else if (Array.isArray(v)) hdrs[k.toLowerCase()] = v.join(", ");
          }
          resolve({
            status: res.statusCode || 0,
            headers: hdrs,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Decode JWT payload without verification
 */
function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ── Claude fetcher ─────────────────────────────────────────────────────────

/**
 * Read Claude credentials from macOS keychain.
 * Returns the parsed credentials object or null if not found/error.
 */
function readClaudeKeychainCredentials(): any | null {
  try {
    const result = child_process.execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", timeout: 5000 }
    );
    return JSON.parse(result.trim());
  } catch {
    return null;
  }
}

/** Max number of retries for transient 429 responses */
const CLAUDE_MAX_RETRIES = 3;
/** Initial retry delay in ms (doubles each attempt) */
const CLAUDE_INITIAL_RETRY_MS = 1000;

/**
 * Sleep for the given duration. Exported for test mocking.
 */
export const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Allow tests to swap the sleep implementation
let sleepFn = _sleep;
export function _setSleepFn(fn: typeof _sleep): void {
  sleepFn = fn;
}
export function _resetSleepFn(): void {
  sleepFn = _sleep;
}

async function fetchClaudeUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Claude",
    icon: "🟠",
    status: "no-auth",
    windows: [],
  };

  // Load Claude CLI credentials
  const credPaths = [
    path.join(process.env.HOME || "~", ".claude", ".credentials.json"),
    path.join(process.env.HOME || "~", ".config", "claude", ".credentials.json"),
  ];

  let creds: any = null;
  for (const p of credPaths) {
    try {
      creds = JSON.parse(fs.readFileSync(p, "utf-8"));
      break;
    } catch {}
  }

  // Fallback to macOS keychain if file credentials not found
  if (!creds) {
    creds = readClaudeKeychainCredentials();
  }

  const oauthCreds = creds?.claudeAiOauth || creds;
  if (!oauthCreds?.accessToken) {
    usage.error = "No Claude CLI credentials — run 'claude' to login";
    return usage;
  }

  // Check scopes
  const scopes: string[] = oauthCreds.scopes || [];
  if (!scopes.includes("user:profile")) {
    usage.error = "Claude CLI token missing user:profile scope";
    return usage;
  }

  // Infer plan from rateLimitTier
  if (oauthCreds.subscriptionType) {
    usage.plan = oauthCreds.subscriptionType.charAt(0).toUpperCase() + oauthCreds.subscriptionType.slice(1);
  } else if (oauthCreds.rateLimitTier) {
    const tier = oauthCreds.rateLimitTier.toLowerCase();
    if (tier.includes("max")) usage.plan = "Max";
    else if (tier.includes("pro")) usage.plan = "Pro";
    else if (tier.includes("team")) usage.plan = "Team";
    else usage.plan = oauthCreds.rateLimitTier;
  }

  try {
    // Retry loop for transient 429 responses
    let res: { status: number; headers: Record<string, string>; body: string } | undefined;
    let lastStatus = 0;

    for (let attempt = 0; attempt < CLAUDE_MAX_RETRIES; attempt++) {
      res = await httpsRequest("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          authorization: `Bearer ${oauthCreds.accessToken}`,
        },
      });

      lastStatus = res.status;

      // Auth errors are not transient — fail immediately
      if (res.status === 401 || res.status === 403) {
        usage.status = "error";
        usage.error = "Auth expired — run 'claude' to re-login";
        return usage;
      }

      // 429 is potentially transient — retry with exponential backoff
      if (res.status === 429) {
        if (attempt < CLAUDE_MAX_RETRIES - 1) {
          // Use retry-after header if available, otherwise exponential backoff
          const retryAfter = res.headers["retry-after"];
          let delayMs: number;
          if (retryAfter && !isNaN(Number(retryAfter))) {
            delayMs = Number(retryAfter) * 1000;
          } else {
            delayMs = CLAUDE_INITIAL_RETRY_MS * Math.pow(2, attempt);
          }
          await sleepFn(delayMs);
          continue;
        }
        // All retries exhausted
        usage.status = "error";
        usage.error = "Rate limited — try again later";
        return usage;
      }

      // Any other non-200 status — fail immediately (not transient)
      if (res.status !== 200) {
        usage.status = "error";
        usage.error = `HTTP ${res.status}`;
        return usage;
      }

      // Success — break out of retry loop
      break;
    }

    if (!res || lastStatus !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${lastStatus}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const parseWindow = (key: string, label: string, windowDurationMs: number): UsageWindow | null => {
      const w = data[key];
      if (!w || typeof w !== "object") return null;

      const pctUsed: number = w.utilization ?? w.percent_used ?? w.percentUsed ?? 0;
      let resetText: string | null = null;
      let resetMs: number | undefined;

      const resetAt = w.resets_at || w.reset_at || w.resetAt;
      if (resetAt) {
        const msLeft = new Date(resetAt).getTime() - Date.now();
        resetMs = msLeft > 0 ? msLeft : 0;
        resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
      }

      return {
        label,
        percentUsed: Math.min(100, Math.max(0, pctUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - pctUsed)),
        resetText,
        windowDurationMs,
        resetMs,
      };
    };

    const fiveHour = parseWindow("five_hour", "Session (5h)", FIVE_HOURS_MS);
    const sevenDay = parseWindow("seven_day", "Weekly", SEVEN_DAYS_MS);
    const sonnet = parseWindow("seven_day_sonnet", "Weekly (Sonnet)", SEVEN_DAYS_MS);
    const opus = parseWindow("seven_day_opus", "Weekly (Opus)", SEVEN_DAYS_MS);

    if (fiveHour) usage.windows.push(fiveHour);
    if (sevenDay) usage.windows.push(sevenDay);
    if (sonnet) usage.windows.push(sonnet);
    if (opus) usage.windows.push(opus);
  } catch (e: any) {
    usage.status = "error";
    usage.error = e.message || "Failed to fetch";
  }

  return usage;
}

// ── Codex fetcher ──────────────────────────────────────────────────────────

async function fetchCodexUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Codex",
    icon: "🟢",
    status: "no-auth",
    windows: [],
  };

  // Load Codex auth
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || "~", ".codex");
  const authPath = path.join(codexHome, "auth.json");

  let auth: any = null;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    usage.error = "No Codex credentials — run 'codex' to login";
    return usage;
  }

  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    usage.error = "No Codex access token found";
    return usage;
  }

  // Extract plan and email from id_token
  if (auth?.tokens?.id_token) {
    const claims = decodeJwtPayload(auth.tokens.id_token);
    if (claims) {
      usage.email = claims.email || null;
      const openaiAuth = claims["https://api.openai.com/auth"];
      if (openaiAuth?.chatgpt_plan_type) {
        usage.plan = openaiAuth.chatgpt_plan_type.charAt(0).toUpperCase() + openaiAuth.chatgpt_plan_type.slice(1);
      }
    }
  }

  try {
    const res = await httpsRequest("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired — run 'codex' to re-login";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    // Override email/plan from response if available
    if (data.email) usage.email = data.email;
    if (data.plan_type) usage.plan = data.plan_type.charAt(0).toUpperCase() + data.plan_type.slice(1);

    const parseWindow = (win: any, label: string): UsageWindow | null => {
      if (!win || typeof win !== "object") return null;
      const pctUsed: number = win.used_percent ?? 0;
      let resetText: string | null = null;
      let resetMs: number | undefined;
      const windowDurationMs: number | undefined = win.limit_window_seconds
        ? win.limit_window_seconds * 1000
        : undefined;

      if (win.reset_at) {
        const msLeft = win.reset_at * 1000 - Date.now();
        resetMs = msLeft > 0 ? msLeft : 0;
        resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
      } else if (win.reset_after_seconds) {
        resetMs = win.reset_after_seconds * 1000;
        resetText = `resets in ${formatDuration(resetMs)}`;
      }
      return {
        label,
        percentUsed: Math.min(100, Math.max(0, pctUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - pctUsed)),
        resetText,
        windowDurationMs,
        resetMs,
      };
    };

    // Main rate limits
    if (data.rate_limit) {
      const primary = parseWindow(data.rate_limit.primary_window, "Session (5h)");
      const secondary = parseWindow(data.rate_limit.secondary_window, "Weekly");
      if (primary) usage.windows.push(primary);
      if (secondary) usage.windows.push(secondary);
    }
  } catch (e: any) {
    usage.status = "error";
    usage.error = e.message || "Failed to fetch";
  }

  return usage;
}

// ── Gemini fetcher ─────────────────────────────────────────────────────────

async function fetchGeminiUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Gemini",
    icon: "🔵",
    status: "no-auth",
    windows: [],
  };

  // Load Gemini OAuth credentials
  const oauthPath = path.join(process.env.HOME || "~", ".gemini", "oauth_creds.json");
  let oauthCreds: any = null;
  try {
    oauthCreds = JSON.parse(fs.readFileSync(oauthPath, "utf-8"));
  } catch {
    usage.error = "No Gemini credentials — run 'gemini' to login";
    return usage;
  }

  if (!oauthCreds?.access_token) {
    usage.error = "No Gemini access token found";
    return usage;
  }

  // Extract email from id_token
  if (oauthCreds.id_token) {
    const claims = decodeJwtPayload(oauthCreds.id_token);
    if (claims?.email) usage.email = claims.email;
  }

  // Check auth type from settings
  const settingsPath = path.join(process.env.HOME || "~", ".gemini", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const authType = settings?.security?.auth?.selectedType;
    if (authType === "api-key" || authType === "vertex-ai") {
      usage.status = "error";
      usage.error = `Unsupported auth type: ${authType} (need oauth-personal)`;
      return usage;
    }
  } catch {}

  try {
    const res = await httpsRequest(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${oauthCreds.access_token}`,
        },
        body: JSON.stringify({}),
      }
    );

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired — run 'gemini' to re-login";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    // Parse buckets array
    const buckets: any[] = data.buckets || [];
    if (Array.isArray(buckets) && buckets.length > 0) {
      // Group by model family, pick lowest remainingFraction per family
      const modelGroups = new Map<string, { pctLeft: number; resetText: string | null; resetMs: number | undefined; models: string[] }>();

      for (const b of buckets) {
        const modelId: string = b.modelId || "unknown";
        const remainFrac: number = b.remainingFraction ?? 1;
        const pctLeft = remainFrac * 100;

        let resetText: string | null = null;
        let resetMs: number | undefined;
        if (b.resetTime) {
          const msLeft = new Date(b.resetTime).getTime() - Date.now();
          resetMs = msLeft > 0 ? msLeft : 0;
          resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
        }

        // Skip _vertex duplicates, classify by family
        if (modelId.endsWith("_vertex")) continue;

        let family: string;
        if (modelId.includes("pro")) family = "Pro models";
        else if (modelId.includes("flash-lite")) family = "Flash Lite";
        else if (modelId.includes("flash")) family = "Flash models";
        else family = modelId;

        const existing = modelGroups.get(family);
        if (!existing || pctLeft < existing.pctLeft) {
          modelGroups.set(family, {
            pctLeft,
            resetText,
            resetMs,
            models: existing ? [...existing.models, modelId] : [modelId],
          });
        } else {
          existing.models.push(modelId);
        }
      }

      // Gemini rate limits reset daily (24 hours)
      const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

      for (const [family, info] of modelGroups) {
        usage.windows.push({
          label: family,
          percentUsed: Math.min(100, Math.max(0, 100 - info.pctLeft)),
          percentLeft: Math.min(100, Math.max(0, info.pctLeft)),
          resetText: info.resetText,
          resetMs: info.resetMs,
          windowDurationMs: DAILY_WINDOW_MS,
        });
      }
    }
  } catch (e: any) {
    usage.status = "error";
    usage.error = e.message || "Failed to fetch";
  }

  return usage;
}

// ── Minimax fetcher ─────────────────────────────────────────────────────────

async function fetchMinimaxUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Minimax",
    icon: "🟣",
    status: "no-auth",
    windows: [],
  };

  // Load Minimax credentials
  const credPath = path.join(process.env.HOME || "~", ".minimax", "credentials.json");
  let creds: any = null;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
  } catch {
    usage.error = "No Minimax credentials configured";
    return usage;
  }

  const accessToken = creds?.access_token;
  if (!accessToken) {
    usage.error = "No Minimax access token found";
    return usage;
  }

  try {
    const res = await httpsRequest("https://api.minimaxi.com/user/quota", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    const quota = data?.quota;
    if (quota && typeof quota === "object") {
      const total: number = quota.total ?? 0;
      const used: number = quota.used ?? 0;
      const remaining: number = quota.remaining ?? Math.max(0, total - used);

      const percentUsed = total > 0 ? (used / total) * 100 : 0;

      let resetText: string | null = null;
      let resetMs: number | undefined;
      let windowDurationMs: number | undefined;

      const resetAt = data?.reset_at;
      if (resetAt) {
        const msLeft = new Date(resetAt).getTime() - Date.now();
        resetMs = msLeft > 0 ? msLeft : 0;
        resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
        // Weekly window duration (7 days)
        windowDurationMs = 7 * 24 * 60 * 60 * 1000;
      }

      usage.windows.push({
        label: "Weekly",
        percentUsed: Math.min(100, Math.max(0, percentUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - percentUsed)),
        resetText,
        resetMs,
        windowDurationMs,
      });
    }
  } catch (e: any) {
    usage.status = "error";
    usage.error = e.message || "Failed to fetch";
  }

  return usage;
}

// ── Zai (Zhipu AI) fetcher ──────────────────────────────────────────────────

async function fetchZaiUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Zai",
    icon: "🟡",
    status: "no-auth",
    windows: [],
  };

  // Load Zai credentials
  const authPath = path.join(process.env.HOME || "~", ".zai", "auth.json");
  let auth: any = null;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    usage.error = "No Zai credentials configured";
    return usage;
  }

  const accessToken = auth?.access_token;
  if (!accessToken) {
    usage.error = "No Zai access token found";
    return usage;
  }

  try {
    const res = await httpsRequest("https://api.zhipuai.com/v1/user/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    const usageData = data?.data;
    if (usageData && typeof usageData === "object") {
      const totalCredits: number = usageData.total_credits ?? 0;
      const usedCredits: number = usageData.used_credits ?? 0;

      const percentUsed = totalCredits > 0 ? (usedCredits / totalCredits) * 100 : 0;

      let dailyResetText: string | null = null;
      let dailyResetMs: number | undefined;
      let monthlyResetText: string | null = null;
      let monthlyResetMs: number | undefined;

      const resetDate = usageData.reset_date;
      if (resetDate) {
        const resetTime = new Date(resetDate).getTime();
        const msLeft = resetTime - Date.now();
        
        // Determine if this is daily or monthly based on time until reset
        const hoursLeft = msLeft / (1000 * 60 * 60);
        
        if (hoursLeft <= 24) {
          // Daily window
          dailyResetMs = msLeft > 0 ? msLeft : 0;
          dailyResetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
        } else {
          // Monthly window
          monthlyResetMs = msLeft > 0 ? msLeft : 0;
          monthlyResetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
        }
      }

      // Add Daily window
      usage.windows.push({
        label: "Daily",
        percentUsed: Math.min(100, Math.max(0, percentUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - percentUsed)),
        resetText: dailyResetText,
        resetMs: dailyResetMs,
        windowDurationMs: dailyResetMs ? 24 * 60 * 60 * 1000 : undefined,
      });

      // Add Monthly window if applicable
      if (monthlyResetMs) {
        usage.windows.push({
          label: "Monthly",
          percentUsed: Math.min(100, Math.max(0, percentUsed)),
          percentLeft: Math.min(100, Math.max(0, 100 - percentUsed)),
          resetText: monthlyResetText,
          resetMs: monthlyResetMs,
          windowDurationMs: 30 * 24 * 60 * 60 * 1000, // Approximate 30 days
        });
      }
    }
  } catch (e: any) {
    usage.status = "error";
    usage.error = e.message || "Failed to fetch";
  }

  return usage;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Fetch usage data from all configured providers with caching.
 * Results are cached for 30 seconds to avoid hitting provider API rate limits.
 */
export async function fetchAllProviderUsage(_authStorage?: AuthStorageLike): Promise<ProviderUsage[]> {
  // Check cache
  if (usageCache && Date.now() - usageCache.timestamp < CACHE_TTL_MS) {
    return usageCache.data;
  }

  // Fetch all providers in parallel
  const results = await Promise.allSettled([
    fetchClaudeUsage(),
    fetchCodexUsage(),
    fetchGeminiUsage(),
    fetchMinimaxUsage(),
    fetchZaiUsage(),
  ]);

  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      // Apply pace calculation to all windows
      const provider = r.value;
      provider.windows = provider.windows.map(applyPaceToWindow);
      providers.push(provider);
    }
  }

  // Update cache
  usageCache = {
    data: providers,
    timestamp: Date.now(),
  };

  return providers;
}

/**
 * Clear the usage cache (useful for testing or manual refresh)
 */
export function clearUsageCache(): void {
  usageCache = null;
}
