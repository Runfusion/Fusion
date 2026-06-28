import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyHtmlMutations, writeHtmlMutationsToFile, type HtmlMutationOperation } from "../html-mutation.js";

const BASE_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Plan</title><style>.callout{color:red}</style></head><body><main><h2 id="product-contract" data-stable="yes">Product Contract</h2><p>The plan has teh typo.</p><pre>teh code sample must stay</pre><section id="open-questions" data-kind="questions"><h2>Open Questions</h2><ul><li>Existing question?</li></ul></section></main><script>const untouched = "teh";</script></body></html>';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "ce-html-mutation-"));
}

function planPath(root: string): string {
  return join(root, "plan.html");
}

describe("HTML mutation helper", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("applies no-op round-trip-stable input without changing the document", () => {
    const result = applyHtmlMutations(BASE_HTML, []);

    expect(result).toEqual({ ok: true, html: BASE_HTML, fixesApplied: 0 });
  });

  it("refuses non-round-trip-stable input and leaves the file byte-identical", () => {
    root = makeRepo();
    const file = planPath(root);
    const unstable = "<html><body><p>Not parse5 stable";
    writeFileSync(file, unstable);

    const result = writeHtmlMutationsToFile(file, [{ type: "append-open-question", itemHtml: "<li>New?</li>" }], { rootDir: root });

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
    if (result.ok) throw new Error("expected unstable HTML write to be refused");
    expect(result.reason).toMatch(/round-trip stability/i);
    expect(readFileSync(file, "utf8")).toBe(unstable);
  });

  it("appends an Open Questions item once and is idempotent", () => {
    const op: HtmlMutationOperation = { type: "append-open-question", itemHtml: "<li>Should we launch?</li>" };

    const first = applyHtmlMutations(BASE_HTML, [op]);
    expect(first).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!first.ok) throw new Error(first.reason);
    expect(first.html.match(/Should we launch\?/g)).toHaveLength(1);

    const second = applyHtmlMutations(first.html, [op]);
    expect(second).toMatchObject({ ok: true, fixesApplied: 0, html: first.html });
  });

  it("accepts benign inline Open Questions markup and remains idempotent", () => {
    const op: HtmlMutationOperation = {
      type: "append-open-question",
      itemHtml: '<li><strong>Ship?</strong> <a href="/safe-path" title="details">details</a></li>',
    };

    const first = applyHtmlMutations(BASE_HTML, [op]);
    expect(first).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!first.ok) throw new Error(first.reason);
    expect(first.html).toContain('<li><strong>Ship?</strong> <a href="/safe-path" title="details">details</a></li>');

    const second = applyHtmlMutations(first.html, [op]);
    expect(second).toMatchObject({ ok: true, fixesApplied: 0, html: first.html });
  });

  it("repairs provable stable-registry heading depth while preserving ids and data attributes", () => {
    const result = applyHtmlMutations(BASE_HTML, [
      { type: "repair-heading-depth", anchorId: "product-contract", fromLevel: 2, toLevel: 3 },
    ]);

    expect(result).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain('<h3 id="product-contract" data-stable="yes">Product Contract</h3>');
    expect(result.html).toContain('<style>.callout{color:red}</style>');
    expect(result.html).toContain('<script>const untouched = "teh";</script>');
  });

  it("normalizes only duplicate inter-block whitespace and never raw-text whitespace", () => {
    const html = '<!DOCTYPE html><html><head><title>Plan</title></head><body><main><p>A</p>\n\n\n<p>B</p><pre>A\n\n\nB</pre><section id="open-questions"><ul><li>Existing?</li></ul></section></main></body></html>';

    const result = applyHtmlMutations(html, [{ type: "normalize-duplicate-inter-block-whitespace" }]);

    expect(result).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain("<p>A</p>\n<p>B</p>");
    expect(result.html).toContain("<pre>A\n\n\nB</pre>");
  });

  it("replaces exactly one visible prose typo without touching code, script, style, ids, or data attributes", () => {
    const result = applyHtmlMutations(BASE_HTML, [{ type: "replace-visible-text", from: "teh", to: "the" }]);

    expect(result).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain("<p>The plan has the typo.</p>");
    expect(result.html).toContain("<pre>teh code sample must stay</pre>");
    expect(result.html).toContain('<script>const untouched = "teh";</script>');
    expect(result.html).toContain('<h2 id="product-contract" data-stable="yes">Product Contract</h2>');
  });

  it("reconciles visible-text replacement against the anchored non-first occurrence", () => {
    const html = '<!DOCTYPE html><html><head><title>Plan</title></head><body><main><p id="first">colour and colour</p><p id="target">colour</p><section id="open-questions"><ul><li>Existing?</li></ul></section></main></body></html>';

    const result = applyHtmlMutations(html, [{ type: "replace-visible-text", from: "colour", to: "color", anchorId: "target" }]);

    expect(result).toMatchObject({ ok: true, fixesApplied: 1 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain('<p id="first">colour and colour</p>');
    expect(result.html).toContain('<p id="target">color</p>');
    expect(result.html).not.toContain('<p id="first">color and colour</p>');
  });

  it("refuses ambiguous visible-text replacements with report-only semantics", () => {
    const html = '<!DOCTYPE html><html><head><title>Plan</title></head><body><main><p>colour</p><p>colour</p><section id="open-questions"><ul><li>Existing?</li></ul></section></main></body></html>';

    const result = applyHtmlMutations(html, [{ type: "replace-visible-text", from: "colour", to: "color" }]);

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
    if (result.ok) throw new Error("expected ambiguous visible text replacement to be refused");
    expect(result.reason).toMatch(/exactly one text node/i);
  });

  it("refuses missing and ambiguous anchors with report-only semantics", () => {
    const missing = BASE_HTML.replace(' id="open-questions"', "").replace("Open Questions", "Parking Lot");
    expect(applyHtmlMutations(missing, [{ type: "append-open-question", itemHtml: "<li>New?</li>" }])).toMatchObject({
      ok: false,
      fixesApplied: 0,
    });

    const ambiguous = BASE_HTML.replace("</main>", '<section id="open-questions"><ul></ul></section></main>');
    expect(applyHtmlMutations(ambiguous, [{ type: "append-open-question", itemHtml: "<li>New?</li>" }])).toMatchObject({
      ok: false,
      fixesApplied: 0,
    });
  });

  it.each([
    ["root event handler", '<li onclick="bad()">Ok?</li>'],
    ["descendant event handler", '<li><a href="/safe" onclick="bad()">Ok?</a></li>'],
    ["javascript href", '<li><a href="javascript:bad()">Ok?</a></li>'],
    ["srcdoc attribute", '<li srcdoc="<p>bad</p>">Ok?</li>'],
    ["script element", "<li>Ok<script>bad()</script></li>"],
    ["style element", "<li>Ok<style>bad{}</style></li>"],
    ["iframe element", '<li><iframe src="https://example.com"></iframe></li>'],
    ["object element", '<li><object data="https://example.com"></object></li>'],
    ["embed element", '<li><embed src="https://example.com"></li>'],
    ["form element", '<li><form action="/submit"></form></li>'],
    ["base element", '<li><base href="https://example.com/"></li>'],
    ["meta element", '<li><meta charset="utf-8"></li>'],
    ["link element", '<li><link rel="stylesheet" href="/x.css"></li>'],
  ])("refuses unsafe Open Questions append fragment: %s", (_name, itemHtml) => {
    const result = applyHtmlMutations(BASE_HTML, [{ type: "append-open-question", itemHtml }]);

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
  });

  it("refuses unsafe fragments and unsupported checklist repair without writing", () => {
    root = makeRepo();
    const file = planPath(root);
    writeFileSync(file, BASE_HTML);

    const unsafe = writeHtmlMutationsToFile(file, [{ type: "append-open-question", itemHtml: "<li>Ok<script>bad()</script></li>" }], { rootDir: root });
    expect(unsafe).toMatchObject({ ok: false, fixesApplied: 0 });
    expect(readFileSync(file, "utf8")).toBe(BASE_HTML);

    const checklist = writeHtmlMutationsToFile(file, [{ type: "repair-malformed-checklist" } as unknown as HtmlMutationOperation], { rootDir: root });
    expect(checklist).toMatchObject({ ok: false, fixesApplied: 0 });
    expect(readFileSync(file, "utf8")).toBe(BASE_HTML);
  });

  it("rolls back atomically when post-write validation fails and removes temp files", () => {
    root = makeRepo();
    const file = planPath(root);
    writeFileSync(file, BASE_HTML);

    const result = writeHtmlMutationsToFile(
      file,
      [{ type: "append-open-question", itemHtml: "<li>Rollback?</li>" }],
      { rootDir: root, validateWrittenHtml: () => false },
    );

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
    expect(readFileSync(file, "utf8")).toBe(BASE_HTML);
    expect(readdirSync(root).filter((entry) => entry.includes("html-mutation"))).toEqual([]);
  });

  it("rolls back atomically when post-write validation throws and removes temp files", () => {
    root = makeRepo();
    const file = planPath(root);
    writeFileSync(file, BASE_HTML);

    const result = writeHtmlMutationsToFile(
      file,
      [{ type: "append-open-question", itemHtml: "<li>Rollback throw?</li>" }],
      {
        rootDir: root,
        validateWrittenHtml: () => {
          throw new Error("validator exploded");
        },
      },
    );

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
    if (result.ok) throw new Error("expected throwing validator to be refused");
    expect(result.reason).toMatch(/post-write validation failed/i);
    expect(readFileSync(file, "utf8")).toBe(BASE_HTML);
    expect(readdirSync(root).filter((entry) => entry.includes("html-mutation"))).toEqual([]);
  });

  it("rejects symlink artifact targets", () => {
    root = makeRepo();
    const real = join(root, "real.html");
    const link = planPath(root);
    writeFileSync(real, BASE_HTML);
    symlinkSync(real, link);

    const result = writeHtmlMutationsToFile(link, [{ type: "append-open-question", itemHtml: "<li>New?</li>" }], { rootDir: root });

    expect(result).toMatchObject({ ok: false, fixesApplied: 0 });
    expect(readFileSync(real, "utf8")).toBe(BASE_HTML);
  });
});
