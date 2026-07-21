import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const locales = ["en", "es", "fr", "ko", "zh-CN", "zh-TW"] as const;

describe("database health banner catalogs", () => {
  it.each(locales)("uses renderable rich-text guidance in %s", (locale) => {
    const catalogPath = new URL(`../../locales/${locale}/app.json`, import.meta.url);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      dbBanner: { body: string; instructions: string; title: string };
    };

    expect(catalog.dbBanner.title).toBeTruthy();
    expect(catalog.dbBanner.body).toBeTruthy();
    expect(catalog.dbBanner.instructions).toContain("<cmd>");
    expect(catalog.dbBanner.instructions).toContain("</cmd>");
    expect(catalog.dbBanner.instructions).toContain("<docsLink>docs/storage.md</docsLink>");
    expect(catalog.dbBanner.instructions).not.toMatch(/\{\{(?:cmd|link)\}\}/);
  });
});
