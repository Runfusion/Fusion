import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SWR_CACHE_KEYS,
  SWR_DEFAULT_MAX_AGE_MS,
  SWR_LONG_MAX_AGE_MS,
  SWR_TASKS_MAX_AGE_MS,
  clearCache,
  readCache,
  writeCache,
} from "../swrCache";

describe("swrCache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null on cache miss", () => {
    expect(readCache("missing")).toBeNull();
  });

  it("writes and reads enveloped cache payload", () => {
    const payload = { value: "ok", count: 2 };
    writeCache("demo", payload);

    expect(readCache<typeof payload>("demo")).toEqual(payload);
    const raw = JSON.parse(localStorage.getItem("demo") ?? "null") as {
      savedAt?: number;
      data?: typeof payload;
    };
    expect(typeof raw.savedAt).toBe("number");
    expect(raw.data).toEqual(payload);
  });

  it("respects maxAgeMs for enveloped payloads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    writeCache("ttl", { value: "fresh" });
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

    expect(readCache<{ value: string }>("ttl", { maxAgeMs: 1_000 })).toBeNull();
    expect(readCache<{ value: string }>("ttl")).toEqual({ value: "fresh" });

    vi.useRealTimers();
  });

  it("supports legacy un-enveloped payloads even with maxAgeMs", () => {
    const payload = [{ id: "x" }];
    localStorage.setItem("legacy", JSON.stringify(payload));

    expect(readCache<typeof payload>("legacy")).toEqual(payload);
    expect(readCache<typeof payload>("legacy", { maxAgeMs: 1_000 })).toEqual(payload);
  });

  it("treats invalid savedAt envelope values as legacy payloads", () => {
    localStorage.setItem("bad-savedAt", JSON.stringify({ savedAt: "abc", data: [1, 2] }));
    localStorage.setItem("bad-savedAt-nan", JSON.stringify({ savedAt: Number.NaN, data: { ok: true } }));
    localStorage.setItem("bad-savedAt-no-data", JSON.stringify({ savedAt: "abc" }));

    expect(readCache<number[]>("bad-savedAt")).toEqual([1, 2]);
    expect(readCache<{ ok: boolean }>("bad-savedAt-nan")).toEqual({ ok: true });
    expect(readCache("bad-savedAt-no-data")).toBeNull();
  });

  it("treats clock-skew future savedAt as fresh", () => {
    const skewedSavedAt = Date.now() + 60_000;
    localStorage.setItem("clock-skew", JSON.stringify({ savedAt: skewedSavedAt, data: { ok: true } }));

    expect(readCache<{ ok: boolean }>("clock-skew", { maxAgeMs: 1_000 })).toEqual({ ok: true });
  });

  it("does not write when payload exceeds maxBytes", () => {
    writeCache("large", { value: "0123456789" }, { maxBytes: 5 });

    expect(localStorage.getItem("large")).toBeNull();
  });

  it("clearCache removes only matching prefix keys", () => {
    const backing = new Map<string, string>();
    const storage = {
      get length() {
        return backing.size;
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
    } satisfies Storage;

    vi.stubGlobal("localStorage", storage);

    writeCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}a`, [{ id: "1" }]);
    writeCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}b`, [{ id: "2" }]);
    writeCache(SWR_CACHE_KEYS.PROJECTS, [{ id: "p" }]);

    clearCache(SWR_CACHE_KEYS.TASKS_PREFIX);

    expect(readCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}a`)).toBeNull();
    expect(readCache(`${SWR_CACHE_KEYS.TASKS_PREFIX}b`)).toBeNull();
    expect(readCache(SWR_CACHE_KEYS.PROJECTS)).toEqual([{ id: "p" }]);
  });

  it("exports expected cache keys and TTL constants", () => {
    expect(SWR_CACHE_KEYS.INSIGHTS_PREFIX).toBe("kb-dashboard-insights-cache:");
    expect(SWR_CACHE_KEYS.INSIGHT_LATEST_RUN_PREFIX).toBe("kb-dashboard-insight-latest-run-cache:");
    expect(SWR_CACHE_KEYS.RESEARCH_RUNS_PREFIX).toBe("kb-dashboard-research-runs-cache:");
    expect(SWR_CACHE_KEYS.RESEARCH_SELECTED_ID_PREFIX).toBe("kb-dashboard-research-selected-cache:");
    expect(SWR_CACHE_KEYS.EVALS_RUNS_PREFIX).toBe("kb-dashboard-evals-runs-cache:");
    expect(SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX).toBe("kb-dashboard-evals-results-cache:");
    expect(SWR_CACHE_KEYS.MISSIONS_PREFIX).toBe("kb-dashboard-missions-cache:");
    expect(SWR_CACHE_KEYS.MISSIONS_SELECTED_ID_PREFIX).toBe("kb-dashboard-mission-selected-cache:");
    expect(SWR_CACHE_KEYS.CHAT_SESSIONS_PREFIX).toBe("kb-dashboard-chat-sessions-cache:");
    expect(SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX).toBe("kb-dashboard-chat-messages-cache:");
    expect(SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX).toBe("kb-dashboard-chat-agents-map-cache:");
    expect(SWR_CACHE_KEYS.MODELS).toBe("kb-dashboard-models-cache");
    expect(SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX).toBe("kb-dashboard-discovered-skills-cache:");
    expect(SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX).toBe("kb-dashboard-mailbox-inbox-cache:");
    expect(SWR_CACHE_KEYS.MAILBOX_OUTBOX_PREFIX).toBe("kb-dashboard-mailbox-outbox-cache:");
    expect(SWR_CACHE_KEYS.MAILBOX_UNREAD_COUNT_PREFIX).toBe("kb-dashboard-mailbox-unread-cache:");
    expect(SWR_DEFAULT_MAX_AGE_MS).toBe(10 * 60 * 1000);
    expect(SWR_TASKS_MAX_AGE_MS).toBe(60_000);
    expect(SWR_LONG_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("swallows quota errors", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => writeCache("quota", { ok: true })).not.toThrow();
  });
});
