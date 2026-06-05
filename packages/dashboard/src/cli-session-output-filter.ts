/**
 * cli-session-output-filter — outbound terminal-output hardening
 * (CLI Agent Executor, U10).
 *
 * The CLI agent's terminal byte stream is UNTRUSTED: the agent (or anything it
 * runs) controls the bytes, and a co-driving surface (browser xterm, TUI host
 * TTY) honors escape sequences. Some sequences let an attacker exfiltrate or
 * forge input, so the server-side WS bridge neutralizes them BEFORE forwarding
 * a data frame. `neutralizeTerminalOutput` is the single, pure, streaming-safe
 * implementation; the TUI (U14) re-imports it so every passthrough applies the
 * identical set.
 *
 * The neutralized set (KTD — output hardening):
 * - OSC 52 (clipboard write): `ESC ] 52 ; … BEL|ST` — a remote write to the
 *   user's clipboard. Stripped entirely.
 * - OSC 8 hyperlinks with a non-http/https scheme (e.g. `javascript:`,
 *   `file:`): `ESC ] 8 ; params ; URI BEL|ST`. The URI is stripped (replaced
 *   with an empty URI so the hyperlink is closed/neutral) while the visible
 *   link TEXT that follows is kept. http/https links pass through untouched.
 * - Device-status / query sequences whose auto-responses would forge INPUT back
 *   into the PTY: DSR (`ESC [ … n`), DA1/DA2 (`ESC [ c`, `ESC [ > c`), and
 *   DECRQSS (`ESC P $ q … ESC \`). A terminal answers these by writing bytes to
 *   stdin — which converge on the agent's input FIFO — so a malicious stream
 *   could smuggle keystrokes. Stripped.
 *
 * Streaming-safe: a sequence may be split across two chunks. The function takes
 * (and returns) a small carry buffer holding a trailing partial sequence; the
 * caller threads the carry across calls. `flush` emits any residual carry on
 * stream end. The carry is bounded so a never-terminated sequence can't grow
 * without limit.
 */

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\"; // String Terminator (ESC \)

/**
 * Maximum bytes held in the carry buffer for an in-progress sequence. A
 * sequence longer than this is almost certainly malformed/hostile (a real OSC /
 * CSI is short); once exceeded we flush the carry as literal text rather than
 * buffer unboundedly.
 */
export const MAX_CARRY_LENGTH = 8 * 1024;

/** Allowed URI schemes for OSC 8 hyperlinks. Everything else has its URI stripped. */
const SAFE_LINK_SCHEME = /^(https?):/i;

export interface NeutralizeResult {
  /** The sanitized, safe-to-forward text. */
  output: string;
  /**
   * Trailing bytes withheld because they may be the prefix of a sequence that
   * continues in the next chunk. Pass this back in as the next call's `carry`.
   */
  carry: string;
}

/**
 * Does `text` (already known to start at an ESC) look like it COULD be the start
 * of a longer sequence we care about, if more bytes arrive? Used to decide
 * whether to withhold a trailing partial as carry. Returns true when the buffer
 * is a strict, still-growing prefix of a recognized-but-unterminated sequence.
 */
function isIncompleteSequence(buf: string): boolean {
  if (buf === ESC) return true; // lone ESC — could begin anything
  // OSC: ESC ] … (terminated by BEL or ST). Incomplete until terminator seen.
  if (buf.startsWith(`${ESC}]`)) {
    return !buf.includes(BEL) && !buf.includes(ST);
  }
  // DCS (DECRQSS uses DCS): ESC P … ESC \  (terminated by ST).
  if (buf.startsWith(`${ESC}P`)) {
    return !buf.includes(ST);
  }
  // CSI: ESC [ params/intermediates, terminated by a final byte @-~.
  if (buf.startsWith(`${ESC}[`)) {
    // Final byte is in 0x40–0x7e. Incomplete while we've not seen one yet.
    return !/[@-~]/.test(buf.slice(2));
  }
  // ESC followed by exactly nothing-meaningful-yet: ESC + a single byte that
  // could still become "]" / "[" / "P". `${ESC}` alone handled above; a 2-char
  // ESC + intermediate is its own complete 2-byte sequence, not incomplete.
  if (buf.length === 1) return true;
  return false;
}

/**
 * Process a fully-terminated OSC body (the text between `ESC ]` and its
 * terminator, terminator excluded). Returns the replacement text to emit in
 * place of the WHOLE OSC sequence (including terminator handling done by the
 * caller).
 */
function neutralizeOsc(body: string): string {
  // OSC 52 (clipboard): drop entirely.
  if (body.startsWith("52;") || body === "52") {
    return "";
  }
  // OSC 8 hyperlink: ESC ] 8 ; params ; URI
  if (body.startsWith("8;")) {
    const rest = body.slice(2); // params ; URI
    const sep = rest.indexOf(";");
    if (sep === -1) {
      // Malformed — strip the whole thing to be safe.
      return "";
    }
    const params = rest.slice(0, sep);
    const uri = rest.slice(sep + 1);
    // The closing OSC 8 (empty URI) is always safe — keep it so link state is
    // balanced.
    if (uri === "") {
      return `${ESC}]8;${params};${ST}`;
    }
    if (SAFE_LINK_SCHEME.test(uri)) {
      // Safe scheme — pass the hyperlink through verbatim.
      return `${ESC}]8;${params};${uri}${ST}`;
    }
    // Unsafe scheme — strip the URI (emit an opening link with empty URI so the
    // following visible text still renders, just not as a live link).
    return `${ESC}]8;${params};${ST}`;
  }
  // Any other OSC — pass through verbatim (re-add ST terminator).
  return `${ESC}]${body}${ST}`;
}

/**
 * Is this a CSI device-status / query sequence whose auto-response forges input?
 * `seq` is the full CSI starting at `ESC [` and ending at its final byte.
 */
function isForgingQueryCsi(seq: string): boolean {
  const body = seq.slice(2); // params + intermediates + final
  const final = body.slice(-1);
  const params = body.slice(0, -1);
  // DSR — Device Status Report: ESC [ … n  (e.g. 5n, 6n cursor-position report).
  if (final === "n") return true;
  // DA1 — Primary Device Attributes: ESC [ c  or  ESC [ 0 c
  if (final === "c" && !params.startsWith(">") && !params.startsWith("=")) return true;
  // DA2/DA3 — Secondary/Tertiary DA: ESC [ > c , ESC [ = c
  if (final === "c" && (params.startsWith(">") || params.startsWith("="))) return true;
  return false;
}

/**
 * Neutralize one chunk of (possibly mid-sequence) terminal output, threading a
 * carry buffer so sequences split across chunks are handled. Pure: no I/O, no
 * shared state.
 */
export function neutralizeTerminalOutput(chunk: string, carry = ""): NeutralizeResult {
  let input = carry + chunk;
  let out = "";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== ESC) {
      out += ch;
      i += 1;
      continue;
    }

    // We're at an ESC. Examine the remainder.
    const rest = input.slice(i);

    // ── OSC: ESC ] … BEL|ST ──
    if (rest.startsWith(`${ESC}]`)) {
      const belIdx = rest.indexOf(BEL);
      const stIdx = rest.indexOf(ST);
      let endIdx = -1;
      let termLen = 0;
      if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
        endIdx = belIdx;
        termLen = BEL.length;
      } else if (stIdx !== -1) {
        endIdx = stIdx;
        termLen = ST.length;
      }
      if (endIdx === -1) {
        // Unterminated — withhold as carry (bounded).
        break;
      }
      const body = rest.slice(2, endIdx);
      out += neutralizeOsc(body);
      i += endIdx + termLen;
      continue;
    }

    // ── DCS (DECRQSS): ESC P … ESC \ ──
    if (rest.startsWith(`${ESC}P`)) {
      const stIdx = rest.indexOf(ST, 2);
      if (stIdx === -1) {
        break; // unterminated — carry
      }
      // DECRQSS is a query (ESC P $ q …). Strip the whole DCS.
      i += stIdx + ST.length;
      continue;
    }

    // ── CSI: ESC [ … final(@-~) ──
    if (rest.startsWith(`${ESC}[`)) {
      const finalMatch = rest.slice(2).search(/[@-~]/);
      if (finalMatch === -1) {
        break; // unterminated — carry
      }
      const seq = rest.slice(0, 2 + finalMatch + 1);
      if (isForgingQueryCsi(seq)) {
        // Strip the query.
      } else {
        out += seq;
      }
      i += seq.length;
      continue;
    }

    // ── Lone ESC at end of buffer: could begin a sequence next chunk. ──
    if (rest.length === 1) {
      break; // carry the ESC
    }

    // ── Some other 2-byte ESC sequence (ESC <byte>) — pass through. ──
    out += rest.slice(0, 2);
    i += 2;
  }

  let newCarry = input.slice(i);
  // Bound the carry: if a "sequence" never terminates, don't buffer forever —
  // flush it as literal output (it isn't a recognized hazard if it's this long).
  if (newCarry.length > MAX_CARRY_LENGTH) {
    out += newCarry;
    newCarry = "";
  } else if (newCarry.length > 0 && !isIncompleteSequence(newCarry)) {
    // The residual isn't actually a growing prefix — emit it.
    out += newCarry;
    newCarry = "";
  }

  return { output: out, carry: newCarry };
}

/**
 * Flush a residual carry at stream end. The held bytes were an unterminated
 * sequence; emit them as literal text (we never got a terminator, so there's no
 * safe interpretation to apply — but withholding forever would lose output).
 */
export function flushTerminalOutput(carry: string): string {
  return carry;
}
