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

import { useGitHubImportAutoTranslate, AUTO_TRANSLATE_CHUNK_SIZE } from "../GitHubImportTranslateControls";

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

const base = { enabled: true, owner: "o", repo: "r", targetLocale: "en" as const };

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

    renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    await waitFor(() => expect(autoTranslateImportIssues).toHaveBeenCalledTimes(1));
    // Must not keep marching through the remaining chunks.
    await new Promise((r) => setTimeout(r, 20));
    expect(autoTranslateImportIssues).toHaveBeenCalledTimes(1);
  });

  it("never calls the server when auto-translate is disabled", async () => {
    renderHook(() => useGitHubImportAutoTranslate({ ...base, enabled: false, items: makeItems(5) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(autoTranslateImportIssues).not.toHaveBeenCalled();
  });

  it("never sends closed issues and caps the page at the 50 most recent open", async () => {
    const items = [...makeItems(60), { number: 999, title: "x", body: "b", state: "closed" as const }];
    autoTranslateImportIssues.mockImplementation((_o, _r, chunk) => Promise.resolve(reply(chunk)));

    const { result } = renderHook(() => useGitHubImportAutoTranslate({ ...base, items }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const sent = autoTranslateImportIssues.mock.calls.flatMap((c) => c[2] as { number: number }[]);
    expect(sent).toHaveLength(50);
    expect(sent.some((i) => i.number === 999)).toBe(false);
    expect(result.current.capped).toBe(true);
  });
});
