import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getFusionOAuthAlertStatePath } from "../auth/auth-storage.js";

export interface OAuthAlertStateEntry {
  expires: number;
  lastAlertAt: number;
}

export interface OAuthAlertStateFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string, encoding: BufferEncoding): string;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { force?: boolean }): void;
  writeFileSync(path: string, content: string, encoding: BufferEncoding): void;
}

export interface OAuthAlertStateStoreOptions {
  statePath?: string;
  clock?: () => number;
  fs?: OAuthAlertStateFs;
}

export class OAuthAlertStateStore {
  private readonly statePath: string;
  private readonly clock: () => number;
  private readonly fs: OAuthAlertStateFs;

  constructor(options: OAuthAlertStateStoreOptions = {}) {
    this.statePath = options.statePath ?? getFusionOAuthAlertStatePath();
    this.clock = options.clock ?? Date.now;
    this.fs = options.fs ?? {
      existsSync: (path) => existsSync(path),
      mkdirSync: (path, options) => {
        mkdirSync(path, options);
      },
      readFileSync: (path, encoding) => readFileSync(path, encoding),
      renameSync: (oldPath, newPath) => {
        renameSync(oldPath, newPath);
      },
      rmSync: (path, options) => {
        rmSync(path, options);
      },
      writeFileSync: (path, content, encoding) => {
        writeFileSync(path, content, encoding);
      },
    };
  }

  get(providerId: string): OAuthAlertStateEntry | undefined {
    return this.readState()[providerId];
  }

  getLastAlertAt(providerId: string): number | undefined {
    return this.get(providerId)?.lastAlertAt;
  }

  recordAlert(providerId: string, expires: number, lastAlertAt = this.clock()): void {
    const state = this.readState();
    state[providerId] = { expires, lastAlertAt };
    this.writeState(state);
  }

  clear(providerIds?: Iterable<string>): void {
    if (!providerIds) {
      this.writeState({});
      return;
    }

    const state = this.readState();
    let changed = false;
    for (const providerId of providerIds) {
      if (!(providerId in state)) {
        continue;
      }
      delete state[providerId];
      changed = true;
    }
    if (changed) {
      this.writeState(state);
    }
  }

  private readState(): Record<string, OAuthAlertStateEntry> {
    if (!this.fs.existsSync(this.statePath)) {
      return {};
    }

    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.statePath, "utf-8")) as unknown;
      return sanitizeState(parsed);
    } catch {
      return {};
    }
  }

  private writeState(state: Record<string, OAuthAlertStateEntry>): void {
    const sanitized = sanitizeState(state);
    const dir = dirname(this.statePath);
    this.fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${this.statePath}.${process.pid}.${this.clock()}.tmp`;
    const body = `${JSON.stringify(sanitized, null, 2)}\n`;
    this.fs.writeFileSync(tempPath, body, "utf-8");
    try {
      this.fs.renameSync(tempPath, this.statePath);
    } catch (error) {
      this.fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }
}

function sanitizeState(parsed: unknown): Record<string, OAuthAlertStateEntry> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const sanitized: Record<string, OAuthAlertStateEntry> = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const expires = (value as { expires?: unknown }).expires;
    const lastAlertAt = (value as { lastAlertAt?: unknown }).lastAlertAt;
    if (typeof expires !== "number" || Number.isNaN(expires)) {
      continue;
    }
    if (typeof lastAlertAt !== "number" || Number.isNaN(lastAlertAt)) {
      continue;
    }
    sanitized[providerId] = { expires, lastAlertAt };
  }

  return sanitized;
}
