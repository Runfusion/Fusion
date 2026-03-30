import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

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
    const res = await httpsRequest("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${oauthCreds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired — run 'claude' to re-login";
      return usage;
    }

    if (res.status === 429) {
      usage.status = "error";
      usage.error = "Rate limited — try again later";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}`;
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
      const modelGroups = new Map<string, { pctLeft: number; resetText: string | null; models: string[] }>();

      for (const b of buckets) {
        const modelId: string = b.modelId || "unknown";
        const remainFrac: number = b.remainingFraction ?? 1;
        const pctLeft = remainFrac * 100;

        let resetText: string | null = null;
        if (b.resetTime) {
          const resetMs = new Date(b.resetTime).getTime() - Date.now();
          resetText = resetMs > 0 ? `resets in ${formatDuration(resetMs)}` : "resetting now";
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
            models: existing ? [...existing.models, modelId] : [modelId],
          });
        } else {
          existing.models.push(modelId);
        }
      }

      for (const [family, info] of modelGroups) {
        usage.windows.push({
          label: family,
          percentUsed: Math.min(100, Math.max(0, 100 - info.pctLeft)),
          percentLeft: Math.min(100, Math.max(0, info.pctLeft)),
          resetText: info.resetText,
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
  ]);

  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      providers.push(r.value);
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
