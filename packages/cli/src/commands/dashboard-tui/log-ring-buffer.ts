// ── Types ────────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: Date;
  level: "info" | "warn" | "error";
  message: string;
  prefix?: string;
}

// ── Ring Buffer ───────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 1000;

export class LogRingBuffer {
  private entries: LogEntry[] = [];
  private count = 0;

  push(entry: LogEntry): void {
    if (this.entries.length < MAX_LOG_ENTRIES) {
      this.entries.push(entry);
    } else {
      // Overwrite oldest entry in circular fashion
      this.entries[this.count % MAX_LOG_ENTRIES] = entry;
    }
    this.count++;
  }

  getAll(): LogEntry[] {
    if (this.count <= MAX_LOG_ENTRIES) {
      return this.entries.slice();
    }
    // Return entries in chronological order (oldest to newest)
    const start = this.count % MAX_LOG_ENTRIES;
    return [
      ...this.entries.slice(start),
      ...this.entries.slice(0, start),
    ];
  }

  clear(): void {
    this.entries = [];
    this.count = 0;
  }

  get total(): number {
    return this.count;
  }
}
