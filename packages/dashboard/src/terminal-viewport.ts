/*
FNXC:TerminalSharing 2026-08-19-03:05:
Several browsers can attach to one PTY, but a PTY has exactly ONE size. Each viewer reports the size
of its own window, so the naive "apply every resize" behaviour is last-writer-wins: when a second
browser attaches on a bigger screen the PTY grows to match it and the first viewer — still rendering
its old column count — sees wrapped lines and a broken cursor, with full-screen programs (vim, htop,
less) worst hit. Measured against a live instance: viewer A at 80x24, viewer B attaches at 200x50,
and A's shell reports 200x50 while A still draws 80 columns.

The fix is the one terminal multiplexers settled on: size the PTY to the SMALLEST attached viewer,
per dimension. Content then fits inside every viewer's window; viewers larger than the agreed size
simply have unused space, which is recoverable, whereas content wider than a viewer is not.

Only viewers that have actually reported a size participate — a freshly attached socket must not
pin the session to a placeholder size before its client has measured itself.
*/

export interface ViewportSize {
  cols: number;
  rows: number;
}

function isUsable(size: ViewportSize): boolean {
  return Number.isFinite(size.cols) && Number.isFinite(size.rows) && size.cols > 0 && size.rows > 0;
}

/**
 * Tracks each attached viewer's requested size per session and resolves the size the PTY should use.
 *
 * Deliberately pure and transport-free: the WebSocket layer owns viewer identity and lifetime, this
 * owns only the arithmetic, so the min-sizing rule is testable without sockets or a real PTY.
 */
export class TerminalViewportRegistry {
  private readonly sessions = new Map<string, Map<string, ViewportSize>>();

  /** Record (or update) one viewer's requested size. */
  set(sessionId: string, viewerId: string, size: ViewportSize): void {
    if (!isUsable(size)) return;
    let viewers = this.sessions.get(sessionId);
    if (!viewers) {
      viewers = new Map();
      this.sessions.set(sessionId, viewers);
    }
    viewers.set(viewerId, { cols: Math.floor(size.cols), rows: Math.floor(size.rows) });
  }

  /** Drop a viewer, e.g. on socket close. The remaining viewers may then get more room back. */
  remove(sessionId: string, viewerId: string): void {
    const viewers = this.sessions.get(sessionId);
    if (!viewers) return;
    viewers.delete(viewerId);
    if (viewers.size === 0) this.sessions.delete(sessionId);
  }

  /** Forget a session entirely (PTY exited). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** How many viewers have reported a size for this session. */
  viewerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * The size the PTY should be: the per-dimension minimum across attached viewers, or null when no
   * viewer has reported one yet (in which case the session keeps whatever size it was created with).
   */
  effectiveSize(sessionId: string): ViewportSize | null {
    const viewers = this.sessions.get(sessionId);
    if (!viewers || viewers.size === 0) return null;

    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;
    for (const size of viewers.values()) {
      cols = Math.min(cols, size.cols);
      rows = Math.min(rows, size.rows);
    }
    return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : null;
  }
}
