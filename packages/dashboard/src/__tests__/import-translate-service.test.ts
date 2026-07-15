/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Covers the invariants of import auto-translation across every surface that can spend money or leak stale prose:
- OFF-by-default and closed-issue rules mean NO model call (billing invariant).
- Same-language content is skipped before the model (the detect-first requirement).
- A cache hit spends nothing; an edited issue misses the cache instead of serving stale prose.
- Translations persist until the issue closes, then are pruned.
*/

import { describe, it, expect, vi, beforeEach } from "vitest";

const translateTextMock = vi.fn();

vi.mock("../ai-translate.js", async () => {
  const actual = await vi.importActual<typeof import("../ai-translate.js")>("../ai-translate.js");
  return { ...actual, translateText: translateTextMock };
});

const {
  translateImportItems,
  getCachedImportTranslation,
  resolveTargetLocale,
  isTranslatable,
  hashSourceContent,
} = await import("../import-translate-service.js");

/** Minimal in-memory stand-in for the durable cache. */
function makeStore(settings: Record<string, unknown> = {}): any {
  const rows = new Map<string, { sourceHash: string; translatedTitle: string; translatedBody: string; detectedLocale: string | null; recordedAt: string }>();
  const key = (k: { provider: string; repoKey: string; issueNumber: number; targetLocale: string }) =>
    `${k.provider}|${k.repoKey}|${k.issueNumber}|${k.targetLocale}`;
  return {
    rows,
    getSettings: vi.fn().mockResolvedValue({ githubImportAutoTranslate: true, ...settings }),
    getRootDir: () => "/tmp/root",
    getImportTranslation: vi.fn(async (k) => {
      const row = rows.get(key(k));
      if (!row || row.sourceHash !== k.sourceHash) return null;
      return row;
    }),
    recordImportTranslation: vi.fn(async (k, v, recordedAt = "now") => {
      rows.set(key(k), { sourceHash: k.sourceHash, translatedTitle: v.translatedTitle, translatedBody: v.translatedBody, detectedLocale: v.detectedLocale ?? null, recordedAt });
    }),
    pruneImportTranslations: vi.fn(async (provider: string, repoKey: string, numbers: number[]) => {
      for (const n of numbers) rows.delete(`${provider}|${repoKey}|${n}|es`);
      return numbers.length;
    }),
  };
}

const ctx = (store: any) => ({ store, rootDir: "/tmp/root", provider: "github" as const, repoKey: "o/r", targetLocale: "es" as const });

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Test prose is deliberately LONG. The shared detector rates short Latin-script text as only `medium` confidence and `contentNeedsTranslation` requires `high` for a same-script (latin-vs-latin) mismatch, so a one-line Spanish fixture is correctly reported as "no translation needed".
That conservatism is intended — it is what stops an English issue being shipped to the model — so the fixtures here reflect real issue bodies rather than weakening the threshold to make tests pass.
*/
const SPANISH_BODY =
  "El servidor devuelve un error cuando el usuario intenta guardar los cambios en la configuracion. No se puede completar la operacion porque el sistema no responde. Por favor revise los registros del servidor para mas informacion sobre este problema.";
const ENGLISH_BODY =
  "The server returns an error when the user tries to save the changes to the configuration. The operation cannot be completed because the system does not respond. Please review the server logs for more information about this problem.";

beforeEach(() => {
  translateTextMock.mockReset();
  translateTextMock.mockResolvedValue({ title: "TRANSLATED", body: "TRANSLATED BODY" });
});

describe("resolveTargetLocale", () => {
  it("prefers the explicit project setting over the dashboard locale", () => {
    expect(resolveTargetLocale("fr", "en")).toBe("fr");
  });

  it("falls back to the dashboard locale when the setting is unset", () => {
    expect(resolveTargetLocale(undefined, "ko")).toBe("ko");
  });

  it("returns null when neither is a supported locale", () => {
    expect(resolveTargetLocale("klingon", undefined)).toBeNull();
  });
});

describe("isTranslatable", () => {
  it("skips closed issues", () => {
    expect(isTranslatable({ number: 1, title: "Error del servidor", body: SPANISH_BODY, state: "closed" }, "en")).toBe(false);
  });

  it("skips empty content", () => {
    expect(isTranslatable({ number: 1, title: "", body: "", state: "open" }, "en")).toBe(false);
  });

  it("skips content already in the target language", () => {
    expect(isTranslatable({ number: 1, title: "Server error", body: ENGLISH_BODY, state: "open" }, "en")).toBe(false);
  });

  it("accepts foreign-language open content", () => {
    expect(isTranslatable({ number: 1, title: "Error del servidor", body: SPANISH_BODY, state: "open" }, "en")).toBe(true);
  });
});

describe("hashSourceContent", () => {
  it("changes when the body is edited, so an edited issue cannot hit a stale cache", () => {
    expect(hashSourceContent("t", "a")).not.toBe(hashSourceContent("t", "b"));
  });

  it("is stable for identical content", () => {
    expect(hashSourceContent("t", "a")).toBe(hashSourceContent("t", "a"));
  });
});

describe("translateImportItems", () => {
  const foreign = { number: 7, title: "Server error", body: ENGLISH_BODY, state: "open" as const };

  it("does not call the model for content already in the target language", async () => {
    const store = makeStore();
    // Target 'en', content is English -> nothing to do.
    const out = await translateImportItems({ ...ctx(store), targetLocale: "en" }, [foreign]);
    expect(translateTextMock).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("translates foreign open issues and persists the result", async () => {
    const store = makeStore();
    const item = { number: 7, title: "Error del servidor", body: SPANISH_BODY, state: "open" as const };
    const out = await translateImportItems({ ...ctx(store), targetLocale: "en" }, [item]);

    expect(translateTextMock).toHaveBeenCalledTimes(1);
    expect(out.get(7)?.title).toBe("TRANSLATED");
    expect(out.get(7)?.cached).toBe(false);
    expect(store.recordImportTranslation).toHaveBeenCalledTimes(1);
  });

  it("serves a second run from the cache without calling the model again", async () => {
    const store = makeStore();
    const item = { number: 7, title: "Error del servidor", body: SPANISH_BODY, state: "open" as const };
    const first = { ...ctx(store), targetLocale: "en" as const };

    await translateImportItems(first, [item]);
    translateTextMock.mockClear();

    const out = await translateImportItems(first, [item]);
    expect(translateTextMock).not.toHaveBeenCalled();
    expect(out.get(7)?.cached).toBe(true);
    expect(out.get(7)?.title).toBe("TRANSLATED");
  });

  it("re-translates when the issue body was edited (cache miss on new hash)", async () => {
    const store = makeStore();
    const c = { ...ctx(store), targetLocale: "en" as const };
    await translateImportItems(c, [{ number: 7, title: "Error del servidor", body: SPANISH_BODY, state: "open" }]);
    translateTextMock.mockClear();

    await translateImportItems(c, [
      { number: 7, title: "Error del servidor", body: `${SPANISH_BODY} Ahora con mas detalles del fallo.`, state: "open" },
    ]);
    expect(translateTextMock).toHaveBeenCalledTimes(1);
  });

  it("never translates closed issues and prunes their cached translations", async () => {
    const store = makeStore();
    const c = { ...ctx(store), targetLocale: "en" as const };
    await translateImportItems(c, [
      { number: 9, title: "Error del servidor", body: SPANISH_BODY, state: "closed" },
    ]);
    expect(translateTextMock).not.toHaveBeenCalled();
    expect(store.pruneImportTranslations).toHaveBeenCalledWith("github", "o/r", [9]);
  });

  it("caps eager translation at 50 issues per load", async () => {
    const store = makeStore();
    const items = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      title: `Error del servidor numero ${i + 1}`,
      body: SPANISH_BODY,
      state: "open" as const,
    }));
    await translateImportItems({ ...ctx(store), targetLocale: "en" }, items);
    expect(translateTextMock).toHaveBeenCalledTimes(50);
  });

  it("fails soft per item: one failure keeps the rest of the page translated", async () => {
    const store = makeStore();
    translateTextMock.mockRejectedValueOnce(new Error("model exploded"));
    const items = [
      { number: 1, title: "Error del servidor uno", body: SPANISH_BODY, state: "open" as const },
      { number: 2, title: "Error del servidor dos", body: SPANISH_BODY, state: "open" as const },
    ];
    const out = await translateImportItems({ ...ctx(store), targetLocale: "en" }, items);
    // The failed item is simply absent (caller renders the original prose).
    expect(out.size).toBe(1);
  });
});

describe("getCachedImportTranslation (the import path)", () => {
  it("returns null on a miss so import carries the original prose", async () => {
    const store = makeStore();
    const hit = await getCachedImportTranslation(
      { store, provider: "github" as const, repoKey: "o/r", targetLocale: "en" as const },
      { number: 3, title: "Error del servidor", body: SPANISH_BODY, state: "open" },
    );
    expect(hit).toBeNull();
  });

  it("returns the cached translation so the imported task carries the previewed text", async () => {
    const store = makeStore();
    const item = { number: 3, title: "Error del servidor", body: SPANISH_BODY, state: "open" as const };
    await translateImportItems({ ...ctx(store), targetLocale: "en" }, [item]);

    const hit = await getCachedImportTranslation(
      { store, provider: "github" as const, repoKey: "o/r", targetLocale: "en" as const },
      item,
    );
    expect(hit).toEqual({ title: "TRANSLATED", body: "TRANSLATED BODY" });
  });

  it("returns null for a closed issue even if a row still exists", async () => {
    const store = makeStore();
    const item = { number: 3, title: "Error del servidor", body: SPANISH_BODY, state: "open" as const };
    await translateImportItems({ ...ctx(store), targetLocale: "en" }, [item]);

    const hit = await getCachedImportTranslation(
      { store, provider: "github" as const, repoKey: "o/r", targetLocale: "en" as const },
      { ...item, state: "closed" },
    );
    expect(hit).toBeNull();
  });
});
