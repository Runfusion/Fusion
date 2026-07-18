// @vitest-environment jsdom
/*
FNXC:GitHubImportTranslate 2026-07-15-17:05:
Auto-translation must be NON-BLOCKING and run in the background: the issue list renders immediately in
the original language, translated titles stream in per chunk as they land, and nothing in the panel
awaits the run. These pin that contract — a regression to a single all-or-nothing request would show up
as "no translations until every issue finishes", which is exactly what these detect.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

const { autoTranslateImportIssues } = vi.hoisted(() => ({ autoTranslateImportIssues: vi.fn() }));

/*
FNXC:GitHubImportTranslate 2026-07-15-17:05:
Mock the api module WITHOUT importOriginal: `app/api/legacy.ts` is enormous and pulling the real module
into this worker exhausts the jsdom heap (OOM), for three functions the hook actually uses.
*/
vi.mock("../../api", () => ({
  autoTranslateImportIssues,
  translateImportContent: vi.fn(),
  getTranslateErrorMessage: (err: unknown) => (err instanceof Error ? err.message : "error"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_k: string, f?: string) => f ?? _k }),
}));

import {
  useGitHubImportAutoTranslate,
  AUTO_TRANSLATE_CHUNK_SIZE,
  hashImportItemsForKey,
} from "../GitHubImportTranslateControls";

function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    title: `t${i + 1}`,
    body: "b",
    state: "open" as const,
  }));
}

function reply(items: { number: number }[]) {
  return {
    enabled: true,
    targetLocale: "en",
    capped: false,
    translations: Object.fromEntries(
      items.map((i) => [i.number, { title: `T${i.number}`, body: "B" }]),
    ),
  };
}

/*
FNXC:GitHubImportTranslate 2026-07-15-17:05:
Block body on purpose: `() => mock.mockReset()` implicitly RETURNS the mock, and vitest treats a
function returned from beforeEach as a teardown callback — it then invokes the mock with zero
arguments, which corrupts mock.calls and blows up any implementation that reads its args.
*/
beforeEach(() => {
  autoTranslateImportIssues.mockReset();
});
afterEach(() => {
  cleanup();
});

const base = { enabled: true, owner: "o", repo: "r", reloadGeneration: 0, targetLocale: "en" as const };

describe("useGitHubImportAutoTranslate — background streaming", () => {
  it("returns immediately with no translations (the list never waits on it)", () => {
    autoTranslateImportIssues.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items: makeItems(3) }));
    // Synchronously after render: nothing translated, caller renders originals.
    expect(result.current.translations.size).toBe(0);
  });

  it("streams each chunk in as it lands instead of waiting for the whole page", async () => {
    const items = makeItems(AUTO_TRANSLATE_CHUNK_SIZE * 2);
    let releaseSecond: (v: unknown) => void = () => {};
    const second = new Promise((res) => { releaseSecond = res; });

    autoTranslateImportIssues
      .mockImplementationOnce((_o, _r, chunk) => Promise.resolve(reply(chunk)))
      .mockImplementationOnce((_o, _r, chunk) => second.then(() => reply(chunk)));

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));

    // First chunk's translations are visible while the second is still in flight.
    await waitFor(() => expect(result.current.translations.size).toBe(AUTO_TRANSLATE_CHUNK_SIZE));
    expect(result.current.translations.get(1)?.title).toBe("T1");
    expect(result.current.loading).toBe(true);

    releaseSecond(null);
    await waitFor(() => expect(result.current.translations.size).toBe(items.length));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("chunks the work rather than sending one request for the whole page", async () => {
    const items = makeItems(AUTO_TRANSLATE_CHUNK_SIZE * 2);
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    await waitFor(() => expect(result.current.translations.size).toBe(items.length));

    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(2);
    for (const call of autoTranslateImportIssues.mock.calls) {
      expect(call[2].length).toBeLessThanOrEqual(AUTO_TRANSLATE_CHUNK_SIZE);
    }
  });

  it("keeps earlier chunks when a later chunk fails (fail-soft, not all-or-nothing)", async () => {
    const items = makeItems(AUTO_TRANSLATE_CHUNK_SIZE * 2);
    autoTranslateImportIssues
      .mockImplementationOnce((_o, _r, chunk) => Promise.resolve(reply(chunk)))
      .mockImplementationOnce(() => Promise.reject(new Error("boom")));

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.translations.size).toBe(AUTO_TRANSLATE_CHUNK_SIZE);
  });

  it("stops the background run when the server reports the setting is off", async () => {
    const items = makeItems(AUTO_TRANSLATE_CHUNK_SIZE * 2);
    autoTranslateImportIssues.mockResolvedValue({ enabled: false, targetLocale: null, capped: false, translations: {} });

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    // Wait for the run to FINISH (loading clears) rather than sleeping: a real-time
    // wait would make this negative assertion scheduler-dependent.
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Must not have marched through the remaining chunks.
    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(1);
  });

  it("never calls the server when auto-translate is disabled", async () => {
    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, enabled: false, items: makeItems(5) }));
    // Disabled means the effect never starts a run, so there is nothing to wait for.
    expect(result.current.loading).toBe(false);
    expect(autoTranslateImportIssues).not.toHaveBeenCalled();
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-15-18:40:
  Regression: PR #2147 review. A server "off" answer returned early and skipped the only
  setLoading(false), so the panel span stayed in the loading state indefinitely.
  */
  it("clears loading when the server reports the setting is off", async () => {
    autoTranslateImportIssues.mockResolvedValue({ enabled: false, targetLocale: null, capped: false, translations: {} });
    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items: makeItems(4) }));
    await waitFor(() => expect(autoTranslateImportIssues).toHaveBeenCalled());
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("clears loading even when every chunk fails", async () => {
    autoTranslateImportIssues.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items: makeItems(4) }));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-15-18:40:
  Regression: PR #2147 review. Keying the request on issue NUMBERS alone meant an edited issue —
  same number, new prose — produced an unchanged key, so the panel never re-requested and kept
  showing the translation of the OLD text.
  */
  it("re-requests when an issue's body is edited (same number, new prose)", async () => {
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));
    const first = [{ number: 1, title: "t1", body: "original", state: "open" as const }];
    const { rerender, result } = renderHook(
      ({ items }) => useGitHubImportAutoTranslate({ ...base, items }),
      { initialProps: { items: first } },
    );
    await waitFor(() => expect(autoTranslateImportIssues).toHaveBeenCalledTimes(1));

    // Same issue number, edited body -> must re-request.
    rerender({ items: [{ number: 1, title: "t1", body: "EDITED", state: "open" as const }] });
    await waitFor(() => expect(autoTranslateImportIssues).toHaveBeenCalledTimes(2));
    /*
    FNXC:GitHubImportTranslate 2026-07-18-10:10:
    Full-suite can observe the second request before the streamed map is committed.
    Wait for the translated title, not only the mock call count.
    */
    await waitFor(() => expect(result.current.translations.get(1)?.title).toBe("T1"));
  });

  it("does NOT re-request when the same issue set re-renders unchanged", async () => {
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));
    const items = [{ number: 1, title: "t1", body: "same", state: "open" as const }];
    const { rerender, result } = renderHook(
      ({ items: i }) => useGitHubImportAutoTranslate({ ...base, items: i }),
      { initialProps: { items } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A fresh array identity with identical content must not re-bill. Settling on
    // `loading` keeps this deterministic instead of racing a real-time sleep.
    rerender({ items: [{ number: 1, title: "t1", body: "same", state: "open" as const }] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-17-12:50:
  FN-8230 regression invariant: every reachable 30-item page translates, prior pages remain
  accumulated, and revisiting unchanged prose spends no additional requests.
  */
  it("translates page 2 issue #55 while retaining page 1 without re-billing it", async () => {
    const allItems = makeItems(60);
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));
    const { rerender, result } = renderHook(
      ({ items }) => useGitHubImportAutoTranslate({ ...base, items }),
      { initialProps: { items: allItems.slice(0, 30) } },
    );
    await waitFor(() => expect(result.current.translations.size).toBe(30));

    rerender({ items: allItems.slice(30, 60) });
    await waitFor(() => expect(result.current.translations.size).toBe(60));
    expect(result.current.translations.get(1)?.title).toBe("T1");
    expect(result.current.translations.get(55)?.title).toBe("T55");

    const callsAfterTwoPages = autoTranslateImportIssues.mock.calls.length;
    rerender({ items: allItems.slice(0, 30) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(callsAfterTwoPages);
  });

  it("re-requests changed prose and replaces its accumulated translation", async () => {
    autoTranslateImportIssues
      .mockImplementationOnce((_o, _r, chunk) => Promise.resolve(reply(chunk)))
      .mockImplementationOnce((_o, _r, chunk) => Promise.resolve({ ...reply(chunk), translations: { 1: { title: "UPDATED", body: "UPDATED" } } }));
    const original = [{ number: 1, title: "t1", body: "original", state: "open" as const }];
    const { rerender, result } = renderHook(
      ({ items }) => useGitHubImportAutoTranslate({ ...base, items }),
      { initialProps: { items: original } },
    );
    await waitFor(() => expect(result.current.translations.get(1)?.title).toBe("T1"));

    rerender({ items: [{ ...original[0], body: "edited" }] });
    await waitFor(() => expect(result.current.translations.get(1)?.title).toBe("UPDATED"));
    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(2);
  });

  it("clears accumulated prior pages when the reload generation changes", async () => {
    const allItems = makeItems(60);
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));
    const { rerender, result } = renderHook(
      ({ items, reloadGeneration }) => useGitHubImportAutoTranslate({ ...base, items, reloadGeneration }),
      { initialProps: { items: allItems.slice(0, 30), reloadGeneration: 0 } },
    );
    await waitFor(() => expect(result.current.translations.size).toBe(30));
    rerender({ items: allItems.slice(30, 60), reloadGeneration: 0 });
    await waitFor(() => expect(result.current.translations.size).toBe(60));

    rerender({ items: allItems.slice(30, 60), reloadGeneration: 1 });
    await waitFor(() => expect(result.current.translations.size).toBe(30));
    expect(result.current.translations.has(1)).toBe(false);
    expect(result.current.translations.get(55)?.title).toBe("T55");
  });

  it("never sends closed issues and caps the page at the 50 most recent open", async () => {
    const items = [...makeItems(60), { number: 999, title: "x", body: "b", state: "closed" as const }];
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const sent = autoTranslateImportIssues.mock.calls.flatMap((c) => c[2] as { number: number }[]);
    expect(sent).toHaveLength(50);
    expect(sent.some((i) => i.number === 999)).toBe(false);
  });
});

/*
FNXC:GitHubImportTranslate 2026-07-15-19:30:
Regression: PR #2147 review. The signature delimiter was ambiguous because prose may contain it, so
moving a `|` between title and body produced an unchanged signature and the panel kept serving the
OLD translation. Length-prefixing makes the encoding injective.
*/
describe("hashImportItemsForKey", () => {
  it("distinguishes content that only differs in where a delimiter falls", () => {
    const a = [{ number: 1, title: "a|b", body: "c", state: "open" as const }];
    const b = [{ number: 1, title: "a", body: "b|c", state: "open" as const }];
    expect(hashImportItemsForKey(a)).not.toBe(hashImportItemsForKey(b));
  });

  it("distinguishes an edit that shifts text across the field boundary", () => {
    const a = [{ number: 1, title: "ab", body: "c", state: "open" as const }];
    const b = [{ number: 1, title: "a", body: "bc", state: "open" as const }];
    expect(hashImportItemsForKey(a)).not.toBe(hashImportItemsForKey(b));
  });

  it("is stable for identical content and changes when prose changes", () => {
    const items = [{ number: 1, title: "t", body: "b", state: "open" as const }];
    expect(hashImportItemsForKey(items)).toBe(hashImportItemsForKey([{ ...items[0] }]));
    expect(hashImportItemsForKey(items)).not.toBe(
      hashImportItemsForKey([{ ...items[0], body: "b2" }]),
    );
  });

  it("distinguishes different issue numbers with identical prose", () => {
    const a = [{ number: 1, title: "t", body: "b", state: "open" as const }];
    const b = [{ number: 2, title: "t", body: "b", state: "open" as const }];
    expect(hashImportItemsForKey(a)).not.toBe(hashImportItemsForKey(b));
  });
});
