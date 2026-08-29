/**
 * GenericCliAdapter — heuristic-tier adapter for arbitrary CLI commands
 * (CLI Agent Executor, U6).
 *
 * The generic adapter drives ANY user-configured CLI command inside an
 * engine-owned PTY when no native-tier adapter (Claude Code / Codex / Droid /
 * Pi) applies. It has NO native completion signal, NO native waiting signal, and
 * NO structured transcript — every capability flag is disabled and its
 * transcript source is `"none"`. Surfaces render the honest heuristic tier from
 * these flags (origin R3, AE4).
 *
 * Because the command is opaque, state is inferred purely from the terminal byte
 * stream by {@link GenericHeuristicAnalyzer}:
 * - BUSY when output is progressing OR a spinner is animating (braille spinner
 *   glyphs, `/-\|` rotation, "Working"/"Thinking" tickers, an elapsed-time
 *   counter).
 * - IDLE after a configurable quiet window (default ~8s) of no output AND a
 *   prompt-like trailing glyph (`>`, `❯`, `$`, `:`, `?`, …) AND no active
 *   spinner override.
 *
 * Completion gating (origin R20, KTD — the generic tier NEVER reports done):
 * idle is emitted as the telemetry `"idle"` kind, which the state machine maps
 * to a busy-equivalent idle sub-state surfacing a "looks idle — confirm to
 * advance" affordance. It NEVER advances to `done`. Resumed output flips back to
 * busy. The only positive completion path is operator confirmation downstream.
 *
 * No resume (`supportsResume: false`) — a fresh launch only; the lack of resume
 * is surfaced honestly in the UI (U8 routes generic sessions to needs-attention
 * on engine death rather than auto-resuming).
 */

import type {
  CliAdapterCapabilities,
  CliAdapterLaunchContext,
  CliAgentAdapter,
  CliInjectionFormat,
  CliLaunchSpec,
  CliReadinessDetector,
} from "../adapter.js";
import { stripAnsiControl, type TelemetryEvent } from "../telemetry-hub.js";

// ── Capability flags (all disabled — honest heuristic tier) ─────────────────

const GENERIC_CAPABILITIES: CliAdapterCapabilities = {
  nativeDone: false,
  nativeWaiting: false,
  transcriptSource: "none",
  supportsResume: false,
};

// ── Heuristic detection constants ───────────────────────────────────────────

/** Default quiet window (ms) of no output before idle is considered. */
export const DEFAULT_QUIET_WINDOW_MS = 8_000;
/**
 * Default small grace (ms) after the FIRST output before the session is treated
 * as ready when no prompt-like glyph has appeared yet.
 */
export const DEFAULT_READY_AFTER_FIRST_OUTPUT_MS = 750;
/** How many trailing chars of the screen window to inspect for a prompt glyph. */
const PROMPT_TAIL_CHARS = 8;
/** Max chars retained in the analyzer's screen-ish window. */
const DEFAULT_SCREEN_WINDOW_CHARS = 4_096;
/**
 * Window (ms) over which spinner-glyph CHANGES count as "animating". If two
 * distinct spinner glyphs are observed within this window the spinner is treated
 * as active and overrides any prompt-glyph idle inference.
 */
const SPINNER_ANIMATION_WINDOW_MS = 2_000;

/**
 * Spinner glyphs: braille dots (the de-facto CLI spinner), the classic
 * `/ - \ |` rotation, and a few common block/arc spinners.
 */
const SPINNER_GLYPHS = new Set<string>([
  // Braille spinner frames.
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
  "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷",
  // ASCII rotation.
  "/", "-", "\\", "|",
  // Arc / circle / block spinners.
  "◜", "◝", "◞", "◟", "◐", "◓", "◑", "◒",
  "▖", "▘", "▝", "▗", "▌", "▐", "▀", "▄",
]);

/** Words that signal active work even without a glyph spinner. */
const WORKING_PATTERN = /\b(working|thinking|processing|loading|generating|running|compiling|building|esc to interrupt)\b/i;
/** Elapsed-time ticker, e.g. "(12s)", "0:42", "elapsed 3.2s". */
const ELAPSED_TICKER_PATTERN = /(\b\d{1,2}:\d{2}\b|\(\s*\d+(?:\.\d+)?\s*s\s*\)|\b\d+(?:\.\d+)?s\b|elapsed)/i;

/** Prompt-like trailing glyphs that suggest the CLI is waiting at a prompt. */
const PROMPT_GLYPHS = [">", "❯", "$", "#", ":", "?", "➜", "»", "▶", "λ"];

// ── Heuristic analyzer ──────────────────────────────────────────────────────

export interface GenericHeuristicOptions {
  /** Quiet window (ms) of no output before idle is emitted. */
  quietWindowMs?: number;
  /** Max chars retained in the screen-ish window. */
  screenWindowChars?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Timer scheduler injection for tests (fake timers). Returns a cancel handle. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Sink for synthesized telemetry events. */
  emit: (event: TelemetryEvent) => void;
}

/**
 * Stateful heuristic output analyzer. Fed ANSI-bearing PTY output chunks via
 * {@link observe}; emits normalized {@link TelemetryEvent}s onto the configured
 * sink:
 * - `outputProgress` (with stripped text) while output streams,
 * - `busy` when a spinner / working signal is detected after a quiet stretch,
 * - `idle` once the quiet window elapses with a prompt-like glyph and no spinner.
 *
 * The synthetic `idle` event is the ONLY idle signal; it maps (via the hub /
 * state machine) to a busy-equivalent idle sub-state and NEVER to `done`.
 */
export class GenericHeuristicAnalyzer {
  private readonly quietWindowMs: number;
  private readonly screenWindowChars: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly emit: (event: TelemetryEvent) => void;

  /** ANSI-stripped sliding screen window. */
  private window = "";
  /** Last time output was observed. */
  private lastOutputAt = 0;
  /** Whether we have currently emitted idle (de-dupe; re-armed on new output). */
  private idleEmitted = false;
  /** Whether ANY output has been seen yet. */
  private sawOutput = false;
  /** Pending quiet-window timer handle. */
  private quietTimer: unknown = null;

  /** Recent spinner-glyph observations: glyph + timestamp (animation detection). */
  private spinnerHistory: { glyph: string; at: number }[] = [];

  constructor(opts: GenericHeuristicOptions) {
    this.quietWindowMs = opts.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
    this.screenWindowChars = opts.screenWindowChars ?? DEFAULT_SCREEN_WINDOW_CHARS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.emit = opts.emit;
  }

  /** Observe a raw (ANSI-bearing) output chunk. */
  observe(rawChunk: string): void {
    const stripped = stripAnsiControl(rawChunk);
    const at = this.now();
    this.lastOutputAt = at;

    // Track spinner glyphs present in this chunk for animation detection.
    this.recordSpinnerGlyphs(stripped, at);

    // Append to the sliding window and trim.
    if (stripped.length > 0) {
      this.window = (this.window + stripped).slice(-this.screenWindowChars);
    }

    // Fresh output → progressing. If we had previously gone idle, this resumes
    // work; emit a `busy` so the state machine flips idle → busy. Always emit
    // outputProgress so the inactivity watchdog is re-armed.
    const wasIdle = this.idleEmitted;
    this.idleEmitted = false;

    if (stripped.length > 0) {
      this.emit({ kind: "outputProgress", payload: { text: stripped } });
    }
    if (wasIdle) {
      this.emit({ kind: "busy" });
    }
    this.sawOutput = true;

    // (Re)arm the quiet-window timer.
    this.armQuietTimer();
  }

  /** Whether a spinner is currently animating (recent distinct glyph changes). */
  isSpinnerActive(at: number = this.now()): boolean {
    const recent = this.spinnerHistory.filter((s) => at - s.at <= SPINNER_ANIMATION_WINDOW_MS);
    if (recent.length < 2) return false;
    const distinct = new Set(recent.map((s) => s.glyph));
    // Animation = at least two distinct frames in the window, OR repeated frames
    // arriving (a static `/` once is not a spinner, but several glyph updates are).
    return distinct.size >= 2 || recent.length >= 3;
  }

  /** The trailing non-empty line of the screen window (whitespace-trimmed). */
  private trailingLine(): string {
    const lines = this.window.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) return lines[i].trimEnd();
    }
    return "";
  }

  /** Whether the trailing screen content looks like a prompt waiting for input. */
  hasPromptGlyph(): boolean {
    const tail = this.trailingLine();
    if (tail.length === 0) return false;
    const lastChars = tail.slice(-PROMPT_TAIL_CHARS);
    return PROMPT_GLYPHS.some((g) => lastChars.endsWith(g) || lastChars.endsWith(g + " "));
  }

  /**
   * Whether the CURRENT trailing line shows an active-work textual signal. Scoped
   * to the trailing line so a stale "compiling…" earlier in the scrollback does
   * not pin the session busy once a fresh prompt line has rendered. (In a real
   * terminal the spinner line is overwritten in place; the accumulated window
   * keeps history, so recency must come from the trailing line / spinner timing.)
   */
  hasWorkingSignal(): boolean {
    const tail = this.trailingLine();
    return WORKING_PATTERN.test(tail) || ELAPSED_TICKER_PATTERN.test(tail);
  }

  /** Dispose pending timers. */
  dispose(): void {
    this.clearQuietTimer();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private recordSpinnerGlyphs(stripped: string, at: number): void {
    for (const ch of stripped) {
      if (SPINNER_GLYPHS.has(ch)) {
        this.spinnerHistory.push({ glyph: ch, at });
      }
    }
    // Bound history to the animation window plus a small margin.
    const cutoff = at - SPINNER_ANIMATION_WINDOW_MS * 2;
    if (this.spinnerHistory.length > 0 && this.spinnerHistory[0].at < cutoff) {
      this.spinnerHistory = this.spinnerHistory.filter((s) => s.at >= cutoff);
    }
  }

  private armQuietTimer(): void {
    this.clearQuietTimer();
    this.quietTimer = this.setTimer(() => {
      this.quietTimer = null;
      this.onQuietWindow();
    }, this.quietWindowMs);
  }

  private clearQuietTimer(): void {
    if (this.quietTimer != null) {
      this.clearTimer(this.quietTimer);
      this.quietTimer = null;
    }
  }

  /**
   * Quiet-window elapsed: classify idle vs still-busy.
   * - Spinner animating OR a working/elapsed signal present → still busy; re-arm.
   * - Prompt-like trailing glyph and no spinner override → emit synthetic idle.
   * - Otherwise (quiet but no prompt glyph) → ambiguous; stay busy, re-arm so a
   *   later prompt render can still flip to idle. Idle is NEVER inferred from
   *   silence alone — a prompt-like affordance is required (origin R20).
   */
  private onQuietWindow(): void {
    const at = this.now();
    if (this.isSpinnerActive(at) || this.hasWorkingSignal()) {
      // Spinner override: visible prompt + animating spinner → busy.
      this.armQuietTimer();
      return;
    }
    if (this.hasPromptGlyph()) {
      if (!this.idleEmitted) {
        this.idleEmitted = true;
        this.emit({ kind: "idle" });
      }
      return;
    }
    // Quiet but no prompt glyph: re-arm rather than assert idle.
    this.armQuietTimer();
  }
}

// ── Readiness detector ──────────────────────────────────────────────────────

/**
 * Generic readiness detector: ready on the first prompt-like glyph observed, or
 * (fallback) on the first output after a small configurable delay. Tolerant of
 * partial chunks — it accumulates a small tail window.
 */
class GenericReadinessDetector implements CliReadinessDetector {
  private buffer = "";
  private firstOutputAt: number | null = null;
  private readonly readyAfterMs: number;
  private readonly now: () => number;

  constructor(opts: { readyAfterFirstOutputMs?: number; now?: () => number } = {}) {
    this.readyAfterMs = opts.readyAfterFirstOutputMs ?? DEFAULT_READY_AFTER_FIRST_OUTPUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  observe(chunk: string): boolean {
    const stripped = stripAnsiControl(chunk);
    if (stripped.length === 0) return false;
    if (this.firstOutputAt === null) this.firstOutputAt = this.now();
    this.buffer = (this.buffer + stripped).slice(-256);

    // Prompt-like glyph at the trailing edge → ready immediately.
    const tail = this.buffer.replace(/[ \t\r\n]+$/g, "").slice(-PROMPT_TAIL_CHARS);
    if (PROMPT_GLYPHS.some((g) => tail.endsWith(g))) return true;

    // Fallback: first output plus the small grace window.
    return this.now() - this.firstOutputAt >= this.readyAfterMs;
  }
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Settings the generic adapter reads off the launch context. The command is
 * mandatory (the operator configures it); args are optional. `extraArgs` from
 * the shared launch settings are appended after the configured args.
 */
export interface GenericAdapterSettings {
  /** The binary to invoke (required for the generic adapter). */
  command?: string;
  /** Argument vector for the configured command. */
  args?: readonly string[];
  /** Extra args appended after `args` (shared launch-settings convention). */
  extraArgs?: readonly string[];
  /** Env keys the operator opts to forward (allowlist; never inherit-all). */
  envAllowlist?: readonly string[];
}

/** Error thrown when the generic adapter is launched without a configured command. */
export class GenericCommandMissingError extends Error {
  readonly code = "GENERIC_COMMAND_MISSING";
  constructor() {
    super("Generic CLI adapter requires a configured `command` in launch settings");
    this.name = "GenericCommandMissingError";
  }
}

export class GenericCliAdapter implements CliAgentAdapter {
  readonly id = "generic";
  readonly name = "Generic CLI";
  readonly capabilities = GENERIC_CAPABILITIES;
  // The generic tier has no native autonomy concept, but common bypass flags
  // smuggled through args/extraArgs are still caught so the posture chip is
  // honest. The shared generic env-pattern detector applies on top of this.
  readonly elevationMarkers = {
    argPatterns: [
      /dangerous/i,
      /skip[-_]permissions?/i,
      /bypass[-_](approvals?|permissions?|sandbox)/i,
      /^--yolo$/i,
      /^--full-auto$/i,
      /auto[-_]approve/i,
    ],
  };

  buildLaunch(ctx: CliAdapterLaunchContext): CliLaunchSpec {
    const settings = ctx.settings as GenericAdapterSettings & { command?: string };
    const command = settings.command;
    if (!command || command.trim().length === 0) {
      throw new GenericCommandMissingError();
    }
    const baseArgs = Array.isArray(settings.args) ? [...settings.args] : [];
    const extraArgs = Array.isArray(settings.extraArgs) ? [...settings.extraArgs] : [];
    return { command, args: [...baseArgs, ...extraArgs] };
  }

  buildEnvAllowlist(ctx: CliAdapterLaunchContext): string[] {
    const settings = ctx.settings as GenericAdapterSettings;
    // Honest minimal default: only the terminal-shaping vars a CLI needs to
    // render. The operator may extend the allowlist explicitly. NEVER an
    // inherit-everything posture.
    const base = ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "SHELL"];
    const extra = Array.isArray(settings.envAllowlist)
      ? settings.envAllowlist.filter((k): k is string => typeof k === "string")
      : [];
    return [...new Set([...base, ...extra])];
  }

  createReadinessDetector(): CliReadinessDetector {
    return new GenericReadinessDetector();
  }

  formatInjection(text: string, _opts: { bracketedPasteActive: boolean }): CliInjectionFormat {
    // Submit with a carriage return only. Bracketed-paste wrapping is handled
    // exclusively by the session manager's security path; if we also wrapped
    // here when bracketedPasteActive, the payload would be double-wrapped with
    // \x1b[200~...\x1b[201~. Like every native adapter, generic ignores the
    // bracketedPasteActive hint and only appends \r.
    return { payload: `${text}\r` };
  }

  // No buildResume: supportsResume is false (fresh launch only).
}

/** Shared singleton instance for registration. */
export const genericCliAdapter = new GenericCliAdapter();
