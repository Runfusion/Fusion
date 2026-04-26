import * as path from "node:path";
import { readFile } from "node:fs/promises";
import * as https from "node:https";
import * as child_process from "node:child_process";
import { getAuthFileCandidates } from "./auth-paths.js";

function execFileAsync(
  file: string,
  args: string[],
  options: child_process.ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    child_process.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

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
  resetAt?: string; // ISO 8601 timestamp of when the window resets (machine-readable)
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
  get?(provider: string): { type?: string; key?: string } | null | undefined;
  getApiKey?(provider: string): string | null | undefined | Promise<string | null | undefined>;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JWT payloads are untyped
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

// ── Auth storage reader ──────────────────────────────────────────────────

async function readAuthKeyFromFile(authPath: string, provider: string): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(authPath, "utf-8"));
    const entry = auth?.[provider];
    if (entry && (entry.type === "api_key" || entry.type === "key") && entry.key) {
      return entry.key;
    }
  } catch {
    // No auth file or invalid format - fall through to return null
  }
  return null;
}

/**
 * Read an API key from the same AuthStorage object used by the dashboard when
 * available, then fall back to conventional pi/fusion auth files.
 */
async function readConfiguredApiKey(provider: string, authStorage?: AuthStorageLike): Promise<string | null> {
  try {
    authStorage?.reload();
  } catch {
    // Reload may fail if no storage - ignore
  }

  try {
    const apiKey = await authStorage?.getApiKey?.(provider);
    if (apiKey) return apiKey;
  } catch {
    // getApiKey may not be implemented - ignore
  }

  try {
    const entry = authStorage?.get?.(provider);
    if (entry && (entry.type === "api_key" || entry.type === "key") && entry.key) {
      return entry.key;
    }
  } catch {
    // get() may not be implemented - ignore
  }

  for (const authPath of getAuthFileCandidates()) {
    const apiKey = await readAuthKeyFromFile(authPath, provider);
    if (apiKey) return apiKey;
  }

  return null;
}

// ── Claude fetcher ─────────────────────────────────────────────────────────

/**
 * Read Claude credentials from macOS keychain.
 * Returns the parsed credentials object or null if not found/error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped keychain data
async function readClaudeKeychainCredentials(): Promise<any | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", timeout: 5000 }
    );
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/** Max number of retries for transient 429 responses */
const CLAUDE_MAX_RETRIES = 3;
/** Initial retry delay in ms (doubles each attempt) */
const CLAUDE_INITIAL_RETRY_MS = 1000;

/**
 * In-memory cache for refreshed OAuth access tokens.
 * Never written back to disk/keychain — only lives for the process lifetime.
 */
let refreshedAccessToken: string | null = null;

/**
 * Anthropic OAuth token refresh endpoint on the Claude platform.
 * The OAuth token endpoint lives on platform.claude.com (not console.anthropic.com)
 * per the Anthropic OAuth 2.0 specification.
 */
const ANTHROPIC_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

/**
 * Public OAuth client ID for the Claude CLI / first-party OAuth flow.
 * Required as `client_id` in token refresh requests per the OAuth 2.0 spec.
 */
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * `anthropic-beta` header value required by the Anthropic API to authorize
 * OAuth-scoped access to `/api/oauth/usage`. Without this header the endpoint
 * returns 401 "OAuth authentication is currently not supported". Value mirrors
 * what the Claude CLI (`claude /usage`) sends — bump when the CLI does.
 */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/**
 * User-Agent sent alongside OAuth usage requests. Matches the format used by
 * the Claude CLI so the call is recognizable to Anthropic.
 */
const CLAUDE_USAGE_USER_AGENT = "claude-code-fusion-dashboard";

/**
 * Check whether an OAuth access token is expired using the `expiresAt` timestamp
 * from the credential store. Returns true if expired or expiring within 60 seconds.
 */
function isTokenExpired(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined) return false; // No expiry info — assume valid
  const bufferMs = 60_000; // Treat tokens expiring within 60s as expired
  return Date.now() >= expiresAt - bufferMs;
}

/**
 * Attempt to refresh the OAuth access token using the refresh token.
 * Returns the new access token on success, or null on failure.
 * The refreshed token is cached in memory only (not written to disk/keychain).
 *
 * Request shape mirrors what the Claude CLI sends: JSON body, includes a
 * `scope` field, and posts to platform.claude.com. Sending the body as
 * form-urlencoded or omitting `scope` causes Anthropic to respond with 4xx
 * errors (or silently rate-limit) even when the refresh token is valid.
 */
async function refreshClaudeAccessToken(
  refreshToken: string,
  scopes?: string[],
): Promise<string | null> {
  try {
    const payload: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    };
    if (scopes && scopes.length > 0) {
      payload.scope = scopes.join(" ");
    }

    const res = await httpsRequest(ANTHROPIC_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": CLAUDE_USAGE_USER_AGENT,
      },
      body: JSON.stringify(payload),
      timeout: 10_000, // 10s timeout for refresh
    });

    if (res.status !== 200) {
      return null;
    }

    const data = JSON.parse(res.body);
    const newToken = data.access_token || data.accessToken;
    if (newToken) {
      // Cache in memory only — never written back to disk/keychain
      refreshedAccessToken = newToken;
      return newToken;
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the in-memory refreshed token cache (for testing) */
export function _clearRefreshedToken(): void {
  refreshedAccessToken = null;
}

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

// ── Claude CLI fallback (parses `claude /usage` TUI output) ──────────────────

/**
 * Strip ANSI escape codes from Claude CLI output.
 * Handles cursor-forward (ESC[nC) by converting to spaces to preserve word
 * boundaries — the Claude TUI uses these instead of real spaces.
 */
export function _stripClaudeAnsi(text: string): string {
  let clean = text
    // Cursor forward (CSI n C): replace with n spaces
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B\[(\d+)C/g, (_m, n) => " ".repeat(parseInt(n, 10)))
    // Cursor movement (up/down/back/position)
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B\[\d*[ABD]/g, "")
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B\[\d+;\d+[Hf]/g, "\n")
    // Remaining CSI sequences (colors, modes, etc.)
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, "")
    // OSC sequences
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
    // Other ESC sequences
    // eslint-disable-next-line no-control-regex -- terminal ANSI escape sequence
    .replace(/\x1B[A-Za-z]/g, "")
    // Carriage returns
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Handle backspaces
  /* eslint-disable no-control-regex -- backspace control character */
  while (clean.includes("\x08")) {
    clean = clean.replace(/[^\x08]\x08/, "");
    clean = clean.replace(/^\x08+/, "");
  }
  /* eslint-enable no-control-regex */

  // Strip remaining non-printable control characters (except newline)
  // eslint-disable-next-line no-control-regex -- control character cleanup
  clean = clean.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  return clean;
}

/**
 * Parse a percentage line from Claude CLI usage output.
 * Lines look like: "█████████████▌ 27% used" or "████████ 65% left"
 * Returns the USED percentage (0-100).
 */
export function _parseClaudePercentLine(line: string): number | null {
  const match = line.match(/(\d{1,3})\s*%\s*(left|used|remaining)/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const isUsed = match[2].toLowerCase() === "used";
  return isUsed ? value : 100 - value;
}

/**
 * Parse a reset line from Claude CLI usage output.
 * Lines like: "Resets in 2h 15m", "Resets 11am", "Resets Feb 19 at 3pm"
 */
export function _parseClaudeResetLine(line: string): string | null {
  const match = line.match(/(Resets?.*)$/i);
  if (!match) return null;
  let text = match[1];
  // Clean up percentage info that might be on the same line
  text = text.replace(/(\d{1,3})\s*%\s*(left|used|remaining)/i, "").trim();
  // Ensure space after "Resets" if missing
  text = text.replace(/(resets?)(\d)/i, "$1 $2");
  // Strip timezone like "(America/Los_Angeles)"
  text = text.replace(/\s*\([A-Za-z_/]+\)\s*$/, "").trim();
  return text || null;
}

/**
 * Parse a reset timestamp value from the API into milliseconds until reset.
 * Handles multiple formats: ISO strings, Unix timestamps (seconds or milliseconds),
 * and numeric strings. Returns null if the value is unparseable or in the past.
 */
export function _parseResetTimestamp(value: unknown): { msLeft: number; resetAt: string } | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  let timestampMs: number;

  // Handle numeric values (Unix timestamps in seconds or milliseconds)
  if (typeof value === "number") {
    // Detect format: if >= 1e12, assume milliseconds; otherwise seconds
    timestampMs = value >= 1e12 ? value : value * 1000;
  } else if (typeof value === "string") {
    // Try parsing as number first (for numeric strings)
    const numericValue = Number(value);
    if (!isNaN(numericValue)) {
      // Detect format: if >= 1e12, assume milliseconds; otherwise seconds
      timestampMs = numericValue >= 1e12 ? numericValue : numericValue * 1000;
    } else {
      // Try parsing as ISO string
      const parsed = new Date(value);
      if (isNaN(parsed.getTime())) {
        return null; // Invalid date string
      }
      timestampMs = parsed.getTime();
    }
  } else {
    return null;
  }

  const msLeft = timestampMs - Date.now();
  if (msLeft <= 0) {
    return null; // Already past
  }

  return {
    msLeft,
    resetAt: new Date(timestampMs).toISOString(),
  };
}

/**
 * Parse a reset-time text into an approximate ISO date string.
 */
export function _parseClaudeResetText(text: string): string | null {
  const now = Date.now();

  // "Resets in 2h 15m" or "Resets in 30m"
  const durationMatch = text.match(/(\d+)\s*h(?:ours?)?(?:\s+(\d+)\s*m(?:in)?)?|(\d+)\s*m(?:in)?/i);
  if (durationMatch) {
    let hours = 0;
    let minutes = 0;
    if (durationMatch[1]) {
      hours = parseInt(durationMatch[1], 10);
      minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
    } else if (durationMatch[3]) {
      minutes = parseInt(durationMatch[3], 10);
    }
    return new Date(now + (hours * 60 + minutes) * 60 * 1000).toISOString();
  }

  // "Resets 11am" or "Resets 3pm"
  const simpleTimeMatch = text.match(/resets?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (simpleTimeMatch) {
    let hours = parseInt(simpleTimeMatch[1], 10);
    const minutes = simpleTimeMatch[2] ? parseInt(simpleTimeMatch[2], 10) : 0;
    const ampm = simpleTimeMatch[3].toLowerCase();
    if (ampm === "pm" && hours !== 12) hours += 12;
    else if (ampm === "am" && hours === 12) hours = 0;
    const resetDate = new Date(now);
    resetDate.setHours(hours, minutes, 0, 0);
    if (resetDate.getTime() <= now) resetDate.setDate(resetDate.getDate() + 1);
    return resetDate.toISOString();
  }

  // "Resets Feb 19 at 3pm" or "Resets Jan 15, 3:30pm"
  // Note: \s+at\s* (not \s+at\s+) to handle CLI output where "at" may be
  // immediately followed by the time with no space (e.g. "at3pm" from TUI cursor-forward).
  const dateMatch = text.match(
    /(?:resets?\s*)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+at\s*|\s*,?\s*)(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i
  );
  if (dateMatch) {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[dateMatch[1].toLowerCase().substring(0, 3)];
    const day = parseInt(dateMatch[2], 10);
    let hours = parseInt(dateMatch[3], 10);
    const minutes = dateMatch[4] ? parseInt(dateMatch[4], 10) : 0;
    const ampm = dateMatch[5].toLowerCase();
    if (ampm === "pm" && hours !== 12) hours += 12;
    else if (ampm === "am" && hours === 12) hours = 0;
    if (month !== undefined) {
      const resetDate = new Date(new Date().getFullYear(), month, day, hours, minutes);
      if (resetDate.getTime() < now) resetDate.setFullYear(resetDate.getFullYear() + 1);
      return resetDate.toISOString();
    }
  }

  return null;
}

/**
 * Fetch Claude usage by spawning `claude /usage` via PTY and parsing the TUI output.
 * Used as a fallback when the OAuth API returns 429 (rate limited).
 */
async function fetchClaudeUsageViaCli(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Claude",
    icon: "🟠",
    status: "error",
    windows: [],
  };

  try {
    // Dynamically import node-pty
    const pty = await import("node-pty");
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const cwd = process.cwd();
    const args = isWindows
      ? ["/c", "claude", "--add-dir", cwd]
      : ["-c", `claude --add-dir "${cwd}"`];

    const ptyOptions: Record<string, unknown> = {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    };
    if (isWindows) ptyOptions.useConpty = false;

    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      let settled = false;
      let sentCommand = false;
      let approvedTrust = false;
      let seenUsageData = false;

      const ptyProcess = pty.spawn(shell, args, ptyOptions);

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ptyProcess.kill(); } catch {
          // Kill may fail if process already exited - ignore
        }
        // Return whatever we have if it contains usage data
        const clean = _stripClaudeAnsi(buf);
        if (clean.includes("Current session") || clean.includes("% left") || clean.includes("% used")) {
          resolve(buf);
        } else {
          reject(new Error("Claude CLI timed out after 60s — got output but no usage data. Try running `claude /usage` manually."));
        }
      }, 60000);

      ptyProcess.onData((data: string) => {
        if (settled) return;
        buf += data;

        const clean = _stripClaudeAnsi(buf);

        // Check for auth errors
        if (
          clean.includes("OAuth token does not meet scope requirement") ||
          clean.includes("token_expired") ||
          clean.includes('"type":"authentication_error"') ||
          clean.includes('"type": "authentication_error"')
        ) {
          settled = true;
          clearTimeout(timeout);
          try { ptyProcess.kill(); } catch {
            // Kill may fail if process already exited - ignore
          }
          reject(new Error("Claude CLI auth error"));
          return;
        }

        // Auto-approve trust prompt
        if (
          !approvedTrust &&
          (clean.includes("Do you want to work in this folder?") ||
            clean.includes("Ready to code here") ||
            clean.includes("permission to work with your files") ||
            clean.includes("trust this folder"))
        ) {
          approvedTrust = true;
          setTimeout(() => {
            if (!settled) ptyProcess.write("\r");
          }, 1000);
        }

        // Detect REPL prompt and send /usage
        const isReplReady =
          clean.includes("❯") ||
          clean.includes("? for shortcuts");
        if (!sentCommand && isReplReady) {
          sentCommand = true;
          setTimeout(() => {
            if (!settled) {
              ptyProcess.write("/usage\r");
              // Confirm if autocomplete menu appeared
              setTimeout(() => {
                if (!settled) ptyProcess.write("\r");
              }, 1200);
            }
          }, 1500);
        }

        // Detect usage data, then exit after brief delay
        const hasUsage =
          clean.includes("Current session") ||
          clean.includes("Current week") ||
          /\d+%\s*(left|used|remaining)/i.test(clean);
        if (!seenUsageData && hasUsage && sentCommand) {
          seenUsageData = true;
          setTimeout(() => {
            if (!settled) {
              ptyProcess.write("\x1b"); // ESC to exit
              // Fallback kill after 2s
              setTimeout(() => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  try { ptyProcess.kill(); } catch {
                    // Kill may fail if process already exited - ignore
                  }
                  resolve(buf);
                }
              }, 2000);
            }
          }, 3000);
        }
      });

      ptyProcess.onExit(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(buf);
      });
    });

    // Parse the output
    const cleanOutput = _stripClaudeAnsi(output);
    const lines = cleanOutput.split("\n").map((l) => l.trim()).filter(Boolean);

    // Find sections by looking for known headers (use LAST occurrence since PTY output has redraws)
    const sections: { label: string; windowMs: number }[] = [
      { label: "Current session", windowMs: 5 * 60 * 60 * 1000 },
      { label: "Current week (all models)", windowMs: 7 * 24 * 60 * 60 * 1000 },
      { label: "Current week (Sonnet", windowMs: 7 * 24 * 60 * 60 * 1000 },
      { label: "Current week (Opus", windowMs: 7 * 24 * 60 * 60 * 1000 },
    ];

    usage.status = "ok";
    for (const section of sections) {
      // Find last occurrence
      let sectionIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].toLowerCase().includes(section.label.toLowerCase())) {
          sectionIdx = i;
          break;
        }
      }
      if (sectionIdx === -1) continue;

      const searchLines = lines.slice(sectionIdx, sectionIdx + 5);
      let percentUsed: number | null = null;
      let resetText: string | null = null;

      for (const line of searchLines) {
        if (percentUsed === null) {
          percentUsed = _parseClaudePercentLine(line);
        }
        if (!resetText) {
          resetText = _parseClaudeResetLine(line);
        }
      }

      if (percentUsed !== null) {
        const window: UsageWindow = {
          label: section.label,
          percentUsed: Math.min(100, Math.max(0, percentUsed)),
          percentLeft: Math.min(100, Math.max(0, 100 - percentUsed)),
          resetText,
          windowDurationMs: section.windowMs,
          resetMs: undefined,
        };

        // Parse reset time to calculate resetMs
        if (resetText) {
          const iso = _parseClaudeResetText(resetText);
          if (iso) {
            const msLeft = new Date(iso).getTime() - Date.now();
            window.resetMs = msLeft > 0 ? msLeft : 0;
            window.resetAt = iso;
            // Always replace raw CLI text (e.g. "Resets Apr 9 at 8pm") with
            // a relative duration (e.g. "resets in 3d 8h") for better UX.
            window.resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
          }
        }

        // Fallback for session window: when CLI output doesn't include reset info
        // but we have usage percentage data, use the full window duration as a
        // best-effort estimate. This enables pace calculation and reset text
        // for the session (5h) window even when the CLI output is incomplete.
        if (!window.resetText && section.windowMs === 5 * 60 * 60 * 1000) {
          window.resetMs = section.windowMs;
          window.resetText = "resets in 5h";
          window.resetAt = new Date(Date.now() + section.windowMs).toISOString();
        }

        usage.windows.push(window);
      }
    }

    if (usage.windows.length === 0) {
      usage.status = "error";
      usage.error = "Could not parse usage from CLI output";
    }
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "CLI fallback failed";
  }

  return usage;
}

/**
 * Fetch Claude usage data via the Anthropic OAuth usage API.
 *
 * Reads credentials from the Claude CLI's credential store (files or macOS
 * keychain) and calls api.anthropic.com/api/oauth/usage directly.
 * Includes retry logic with exponential backoff for transient 429 responses.
 * Falls back to parsing `claude /usage` CLI output when rate limited.
 */
async function fetchClaudeUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Claude",
    icon: "🟠",
    status: "no-auth",
    windows: [],
  };

  // ── Credential reading for plan detection & auth check ──────────────
  const credPaths = [
    path.join(process.env.HOME || "~", ".claude", ".credentials.json"),
    path.join(process.env.HOME || "~", ".config", "claude", ".credentials.json"),
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped credentials JSON
  let creds: any = null;
  for (const p of credPaths) {
    try {
      creds = JSON.parse(await readFile(p, "utf-8"));
      break;
    } catch {
      // File doesn't exist or invalid JSON - continue to next path
    }
  }

  // Fallback to macOS keychain if file credentials not found
  if (!creds) {
    creds = await readClaudeKeychainCredentials();
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

  // Infer plan from credential metadata
  if (oauthCreds.subscriptionType) {
    usage.plan = oauthCreds.subscriptionType.charAt(0).toUpperCase() + oauthCreds.subscriptionType.slice(1);
  } else if (oauthCreds.rateLimitTier) {
    const tier = oauthCreds.rateLimitTier.toLowerCase();
    if (tier.includes("max")) usage.plan = "Max";
    else if (tier.includes("pro")) usage.plan = "Pro";
    else if (tier.includes("team")) usage.plan = "Team";
    else usage.plan = oauthCreds.rateLimitTier;
  }

  // ── Resolve the best available access token ─────────────────────────
  // If we have a previously refreshed token in memory, prefer it.
  // Otherwise check if the stored token is expired and attempt refresh.
  let activeToken: string = refreshedAccessToken || oauthCreds.accessToken;

  const tokenExpired = isTokenExpired(oauthCreds.expiresAt);
  if (tokenExpired && !refreshedAccessToken) {
    // Token is expired — attempt refresh before calling the usage API
    if (oauthCreds.refreshToken) {
      const newToken = await refreshClaudeAccessToken(oauthCreds.refreshToken, scopes);
      if (newToken) {
        activeToken = newToken;
      } else {
        // Refresh failed — fall back to CLI which has its own auth mechanism
        return fetchClaudeUsageViaCli();
      }
    } else {
      // No refresh token available — fall back to CLI which has its own auth
      return fetchClaudeUsageViaCli();
    }
  }

  // ── Fetch usage via direct API call with retry for 429 ─────────────
  try {
    let res: { status: number; headers: Record<string, string>; body: string } | undefined;
    let lastStatus = 0;

    for (let attempt = 0; attempt < CLAUDE_MAX_RETRIES; attempt++) {
      res = await httpsRequest("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          authorization: `Bearer ${activeToken}`,
          "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          "user-agent": CLAUDE_USAGE_USER_AGENT,
        },
      });

      lastStatus = res.status;

      // Auth errors — attempt token refresh once before giving up
      if (res.status === 401 || res.status === 403) {
        if (oauthCreds.refreshToken && activeToken !== refreshedAccessToken) {
          // Try refreshing the token as a recovery path
          const newToken = await refreshClaudeAccessToken(oauthCreds.refreshToken, scopes);
          if (newToken) {
            activeToken = newToken;
            continue; // Retry with refreshed token
          }
        }
        // All refresh attempts exhausted — fall back to CLI which has its own auth
        return fetchClaudeUsageViaCli();
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
        // All retries exhausted — fall back to CLI parsing
        return fetchClaudeUsageViaCli();
      }

      // Any other non-200 status — fail immediately (not transient)
      if (res.status !== 200) {
        usage.status = "error";
        const bodySnippet = res.body ? res.body.slice(0, 100).replace(/\n/g, " ") : "";
        usage.error = bodySnippet ? `HTTP ${res.status}: ${bodySnippet}` : `HTTP ${res.status}`;
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

    /**
     * Get a window data object from the API response, checking multiple possible keys
     * for backward compatibility (API may use `session` instead of `five_hour`).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const getWindowData = (primaryKey: string, fallbackKeys: string[] = []): any => {
      if (data[primaryKey] && typeof data[primaryKey] === "object") {
        return data[primaryKey];
      }
      for (const key of fallbackKeys) {
        if (data[key] && typeof data[key] === "object") {
          return data[key];
        }
      }
      return null;
    };

    const parseWindow = (key: string, label: string, windowDurationMs: number, fallbackKeys: string[] = []): UsageWindow | null => {
      const w = getWindowData(key, fallbackKeys);
      if (!w) return null;

      const pctUsed: number = w.utilization ?? w.percent_used ?? w.percentUsed ?? w.used_percent ?? w.usage_percent ?? 0;
      let resetText: string | null = null;
      let resetMs: number | undefined;
      let resetAt: string | undefined;

      const resetAtValue = w.resets_at ?? w.reset_at ?? w.resetAt ?? w.resetsAt ?? w.reset_time ?? w.resetsAtTime;
      const parsedReset = _parseResetTimestamp(resetAtValue);

      if (parsedReset) {
        resetMs = parsedReset.msLeft;
        resetAt = parsedReset.resetAt;
        resetText = `resets in ${formatDuration(parsedReset.msLeft)}`;
      } else if (windowDurationMs === FIVE_HOURS_MS) {
        // Fallback for session window: when the API doesn't provide a valid reset time,
        // use the full window duration as a best-effort estimate. This enables
        // pace calculation and reset text for the session (5h) window even when
        // the API omits resets_at / reset_at / resetAt fields, or provides invalid values.
        resetMs = windowDurationMs;
        resetText = "resets in 5h";
        resetAt = new Date(Date.now() + windowDurationMs).toISOString();
      }

      return {
        label,
        percentUsed: Math.min(100, Math.max(0, pctUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - pctUsed)),
        resetText,
        windowDurationMs,
        resetMs,
        resetAt,
      };
    };

    const fiveHour = parseWindow("five_hour", "Session (5h)", FIVE_HOURS_MS, ["session"]);
    const sevenDay = parseWindow("seven_day", "Weekly", SEVEN_DAYS_MS);
    const sonnet = parseWindow("seven_day_sonnet", "Weekly (Sonnet)", SEVEN_DAYS_MS);
    const opus = parseWindow("seven_day_opus", "Weekly (Opus)", SEVEN_DAYS_MS);

    if (fiveHour) usage.windows.push(fiveHour);
    if (sevenDay) usage.windows.push(sevenDay);
    if (sonnet) usage.windows.push(sonnet);
    if (opus) usage.windows.push(opus);
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "Failed to fetch Claude usage";
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped auth JSON
  let auth: any = null;
  try {
    auth = JSON.parse(await readFile(authPath, "utf-8"));
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const parseWindow = (win: any, label: string): UsageWindow | null => {
      if (!win || typeof win !== "object") return null;
      const pctUsed: number = win.used_percent ?? 0;
      let resetText: string | null = null;
      let resetMs: number | undefined;
      const windowDurationMs: number | undefined = win.limit_window_seconds
        ? win.limit_window_seconds * 1000
        : undefined;

      let resetAt: string | undefined;
      if (win.reset_at) {
        const msLeft = win.reset_at * 1000 - Date.now();
        resetMs = msLeft > 0 ? msLeft : 0;
        resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
        resetAt = new Date(win.reset_at * 1000).toISOString();
      } else if (win.reset_after_seconds) {
        resetMs = win.reset_after_seconds * 1000;
        resetText = `resets in ${formatDuration(resetMs)}`;
        resetAt = new Date(Date.now() + resetMs).toISOString();
      }
      return {
        label,
        percentUsed: Math.min(100, Math.max(0, pctUsed)),
        percentLeft: Math.min(100, Math.max(0, 100 - pctUsed)),
        resetText,
        windowDurationMs,
        resetMs,
        resetAt,
      };
    };

    // Main rate limits
    if (data.rate_limit) {
      const primary = parseWindow(data.rate_limit.primary_window, "Session (5h)");
      const secondary = parseWindow(data.rate_limit.secondary_window, "Weekly");
      if (primary) usage.windows.push(primary);
      if (secondary) usage.windows.push(secondary);
    }
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "Failed to fetch";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped OAuth JSON
  let oauthCreds: any = null;
  try {
    oauthCreds = JSON.parse(await readFile(oauthPath, "utf-8"));
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
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const authType = settings?.security?.auth?.selectedType;
    if (authType === "api-key" || authType === "vertex-ai") {
      usage.status = "error";
      usage.error = `Unsupported auth type: ${authType} (need oauth-personal)`;
      return usage;
    }
  } catch {
    // Settings file doesn't exist or invalid JSON - continue
  }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const buckets: any[] = data.buckets || [];
    if (Array.isArray(buckets) && buckets.length > 0) {
      // Group by model family, pick lowest remainingFraction per family
      const modelGroups = new Map<string, { pctLeft: number; resetText: string | null; resetMs: number | undefined; resetAt: string | undefined; models: string[] }>();

      for (const b of buckets) {
        const modelId: string = b.modelId || "unknown";
        const remainFrac: number = b.remainingFraction ?? 1;
        const pctLeft = remainFrac * 100;

        let resetText: string | null = null;
        let resetMs: number | undefined;
        let resetAt: string | undefined;
        if (b.resetTime) {
          const msLeft = new Date(b.resetTime).getTime() - Date.now();
          resetMs = msLeft > 0 ? msLeft : 0;
          resetText = msLeft > 0 ? `resets in ${formatDuration(msLeft)}` : "resetting now";
          resetAt = new Date(b.resetTime).toISOString();
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
            resetAt,
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
          resetAt: info.resetAt,
          windowDurationMs: DAILY_WINDOW_MS,
        });
      }
    }
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "Failed to fetch";
  }

  return usage;
}

// ── Minimax fetcher ─────────────────────────────────────────────────────────

async function fetchMinimaxUsage(authStorage?: AuthStorageLike): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Minimax",
    icon: "🟣",
    status: "no-auth",
    windows: [],
  };

  // Load Minimax API key from the same auth storage the dashboard uses.
  const apiKey = await readConfiguredApiKey("minimax", authStorage);
  if (!apiKey) {
    usage.error = "No Minimax credentials — add API key to pi";
    return usage;
  }

  try {
    const res = await httpsRequest("https://api.minimax.io/v1/api/openplatform/coding_plan/remains", {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired — check your Minimax API key";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    usage.status = "ok";

    // Parse model_remains array — group by model family
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const modelRemains: any[] = data?.model_remains || [];
    if (Array.isArray(modelRemains) && modelRemains.length > 0) {
      for (const model of modelRemains) {
        const modelName: string = model.model_name || "Unknown";
        const total: number = model.current_interval_total_count ?? 0;
        // Note: Minimax's current_interval_usage_count is actually REMAINING, not used
        // (known API quirk per https://github.com/MiniMax-AI/MiniMax-M2/issues/99)
        const remaining: number = model.current_interval_usage_count ?? 0;
        const used: number = Math.max(0, total - remaining);

        const percentUsed = total > 0 ? (used / total) * 100 : 0;

        let resetText: string | null = null;
        let resetMs: number | undefined;
        let windowDurationMs: number | undefined;

        const remainsTime: number = model.remains_time;
        let resetAt: string | undefined;
        if (remainsTime && remainsTime > 0) {
          resetMs = remainsTime;
          resetText = `resets in ${formatDuration(remainsTime)}`;
          resetAt = new Date(Date.now() + remainsTime).toISOString();
        }

        const startTime: number = model.start_time;
        const endTime: number = model.end_time;
        if (startTime && endTime) {
          windowDurationMs = endTime - startTime;
        }

        // Only show models that have a quota > 0 (skip unused model types)
        if (total > 0) {
          usage.windows.push({
            label: modelName,
            percentUsed: Math.min(100, Math.max(0, percentUsed)),
            percentLeft: Math.min(100, Math.max(0, 100 - percentUsed)),
            resetText,
            resetMs,
            resetAt,
            windowDurationMs,
          });
        }
      }
    }
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "Failed to fetch";
  }

  return usage;
}

// ── Zai (Zhipu AI) fetcher ──────────────────────────────────────────────────

async function fetchZaiUsage(authStorage?: AuthStorageLike): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "Zai",
    icon: "🟡",
    status: "no-auth",
    windows: [],
  };

  // Load Zai API key from the same auth storage the dashboard uses.
  const apiKey = await readConfiguredApiKey("zai", authStorage);
  if (!apiKey) {
    usage.error = "No Zai credentials — add API key to pi";
    return usage;
  }

  try {
    // Z.ai quota endpoint — uses raw API key in Authorization header (not Bearer)
    const res = await httpsRequest("https://api.z.ai/api/monitor/usage/quota/limit", {
      method: "GET",
      headers: {
        authorization: apiKey,
        "content-type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      usage.status = "error";
      usage.error = "Auth expired — check your Zai API key";
      return usage;
    }

    if (res.status !== 200) {
      usage.status = "error";
      usage.error = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      return usage;
    }

    const data = JSON.parse(res.body);
    if (!data?.success || data?.code !== 200) {
      usage.status = "error";
      usage.error = data?.msg || "API returned error";
      return usage;
    }

    usage.status = "ok";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const limits: any[] = data?.data?.limits || [];

    // Find TOKENS_LIMIT (5-hour rolling window)
    const tokensLimit = limits.find((l) => l.type === "TOKENS_LIMIT");
    if (tokensLimit) {
      const percentage: number = tokensLimit.percentage ?? 0;
      // The percentage field represents percentage USED
      // But the API actually reports percentage as the utilization level
      // remaining = 100 - percentage (if percentage is used%)
      // However the opencode-mystatus source treats it differently:
      // remainPercent = 100 - percentage (where percentage is used %)
      // Actually from the response: percentage=1 means 1% used, so 99% remaining

      let resetText: string | null = null;
      let resetMs: number | undefined;
      let windowDurationMs: number | undefined;
      let resetAt: string | undefined;

      const nextResetTime: number | undefined = tokensLimit.nextResetTime;
      if (nextResetTime) {
        resetMs = Math.max(0, nextResetTime - Date.now());
        resetText = resetMs > 0 ? `resets in ${formatDuration(resetMs)}` : "resetting now";
        resetAt = new Date(nextResetTime).toISOString();
        // 5-hour window
        windowDurationMs = 5 * 60 * 60 * 1000;
      }

      usage.windows.push({
        label: "Session (5h)",
        percentUsed: Math.min(100, Math.max(0, percentage)),
        percentLeft: Math.min(100, Math.max(0, 100 - percentage)),
        resetText,
        resetMs,
        resetAt,
        windowDurationMs,
      });
    }

    // Find TIME_LIMIT (MCP monthly search quota)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API response
    const timeLimit = limits.find((l: any) => l.type === "TIME_LIMIT");
    if (timeLimit) {
      const total: number = timeLimit.usage ?? 0;
      const used: number = timeLimit.currentValue ?? 0;
      const _remaining: number = timeLimit.remaining ?? Math.max(0, total - used);
      const percentage: number = timeLimit.percentage ?? 0;

      let resetText: string | null = null;
      let resetMs: number | undefined;
      let resetAt2: string | undefined;

      const nextResetTime: number | undefined = timeLimit.nextResetTime;
      if (nextResetTime) {
        resetMs = Math.max(0, nextResetTime - Date.now());
        resetText = resetMs > 0 ? `resets in ${formatDuration(resetMs)}` : "resetting now";
        resetAt2 = new Date(nextResetTime).toISOString();
      }

      usage.windows.push({
        label: "MCP Monthly",
        percentUsed: Math.min(100, Math.max(0, percentage)),
        percentLeft: Math.min(100, Math.max(0, 100 - percentage)),
        resetText,
        resetMs,
        resetAt: resetAt2,
        windowDurationMs: 30 * 24 * 60 * 60 * 1000,
      });
    }

    // Extract plan level if available
    if (data?.data?.level) {
      usage.plan = data.data.level.charAt(0).toUpperCase() + data.data.level.slice(1);
    }
  } catch (e: unknown) {
    usage.status = "error";
    usage.error = e instanceof Error ? e.message : "Failed to fetch";
  }

  return usage;
}

// ── GitHub Copilot fetcher ──────────────────────────────────────────────────

async function fetchGitHubCopilotUsage(): Promise<ProviderUsage> {
  const usage: ProviderUsage = {
    name: "GitHub Copilot",
    icon: "⚫",
    status: "no-auth",
    windows: [],
  };

  try {
    await execFileAsync("gh", ["auth", "status"], { encoding: "utf-8", timeout: 5000 });
  } catch {
    usage.error = "GitHub CLI not authenticated — run 'gh auth login'";
    return usage;
  }

  try {
    const { stdout } = await execFileAsync("gh", ["api", "/user/copilot", "--jq", "."], {
      encoding: "utf-8",
      timeout: 10000,
    });

    const data = JSON.parse(stdout.trim());
    usage.status = "ok";

    if (data.seat_management_setting) {
      usage.plan = data.seat_management_setting;
    }

    const planType: string | undefined = data.copilot_plan_type || data.plan_type;
    if (planType) {
      usage.plan = planType.charAt(0).toUpperCase() + planType.slice(1);
    }

    if (data.copilot_plan_type === "free" || data.plan_type === "free") {
      if (data.chat_messages_used !== undefined && data.chat_messages_limit !== undefined) {
        const chatPct =
          data.chat_messages_limit > 0
            ? (data.chat_messages_used / data.chat_messages_limit) * 100
            : 0;
        usage.windows.push({
          label: "Chat (Monthly)",
          percentUsed: Math.min(100, Math.max(0, chatPct)),
          percentLeft: Math.min(100, Math.max(0, 100 - chatPct)),
          resetText: null,
          windowDurationMs: 30 * 24 * 60 * 60 * 1000,
        });
      }

      if (data.completions_used !== undefined && data.completions_limit !== undefined) {
        const completionPct =
          data.completions_limit > 0
            ? (data.completions_used / data.completions_limit) * 100
            : 0;
        usage.windows.push({
          label: "Completions (Monthly)",
          percentUsed: Math.min(100, Math.max(0, completionPct)),
          percentLeft: Math.min(100, Math.max(0, 100 - completionPct)),
          resetText: null,
          windowDurationMs: 30 * 24 * 60 * 60 * 1000,
        });
      }
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : "Failed to fetch";
    if (errMsg.includes("404") || errMsg.includes("Not Found")) {
      usage.status = "error";
      usage.error = "No Copilot subscription found";
    } else if (errMsg.includes("401") || errMsg.includes("403")) {
      usage.status = "error";
      usage.error = "GitHub auth expired — run 'gh auth login'";
    } else {
      usage.status = "error";
      usage.error = errMsg;
    }
  }

  return usage;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Fetch usage data from all configured providers with caching.
 * Results are cached for 30 seconds to avoid hitting provider API rate limits.
 */
/** Max time to wait for any individual provider fetch (ms) */
const PROVIDER_FETCH_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Extended timeout for Claude provider fetch (ms).
 * Claude's flow can include up to 3 API retries with exponential backoff (~7s)
 * plus a 60-second CLI fallback via PTY, so the default 10s is insufficient.
 */
export const CLAUDE_FETCH_TIMEOUT_MS = 75_000; // 75 seconds

/**
 * Wrap a provider fetch with a timeout. Returns the provider result or an
 * error provider if the fetch takes longer than PROVIDER_FETCH_TIMEOUT_MS.
 */
export function withTimeout(
  providerPromise: Promise<ProviderUsage>,
  providerName: string,
  timeoutMs: number = PROVIDER_FETCH_TIMEOUT_MS,
): Promise<ProviderUsage> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        name: providerName,
        icon: "⏱️",
        status: "error",
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        windows: [],
      });
    }, timeoutMs);

    providerPromise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        resolve({
          name: providerName,
          icon: "⏱️",
          status: "error",
          error: err instanceof Error ? err.message : "Failed",
          windows: [],
        });
      });
  });
}

export async function fetchAllProviderUsage(authStorage?: AuthStorageLike): Promise<ProviderUsage[]> {
  // Check cache
  if (usageCache && Date.now() - usageCache.timestamp < CACHE_TTL_MS) {
    return usageCache.data;
  }

  // Fetch all providers in parallel with per-provider timeout
  // Currently includes: Claude, Codex, Gemini, Minimax, Zai, GitHub Copilot
  const results = await Promise.allSettled([
    withTimeout(fetchClaudeUsage(), "Claude", CLAUDE_FETCH_TIMEOUT_MS),
    withTimeout(fetchCodexUsage(), "Codex"),
    withTimeout(fetchGeminiUsage(), "Gemini"),
    withTimeout(fetchMinimaxUsage(authStorage), "Minimax"),
    withTimeout(fetchZaiUsage(authStorage), "Zai"),
    withTimeout(fetchGitHubCopilotUsage(), "GitHub Copilot"),
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
