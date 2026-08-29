import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function effectivePxForFontSize(fontSize: string, rootPx: number): number {
  if (fontSize.endsWith("rem")) {
    return Number.parseFloat(fontSize) * rootPx;
  }
  return Number.parseFloat(fontSize);
}

describe("board font scale", () => {
  let styleEl: HTMLStyleElement;

  beforeAll(() => {
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    styleEl.remove();
    document.documentElement.style.fontSize = "";
    document.body.innerHTML = "";
  });

  it("scales board typography when dashboard root font scale changes", () => {
    document.body.innerHTML = `
      <div class="column-header"><h2>Todo</h2></div>
      <div class="column-count">3</div>
      <div class="column-desc">work</div>
      <article class="card">
        <div class="card-id">FN-1</div>
        <div class="card-title">Task title</div>
        <div class="card-meta">meta</div>
      </article>
      <div class="quick-entry-box">
        <textarea class="quick-entry-input"></textarea>
        <span class="quick-entry-hint">Hint</span>
      </div>
    `;

    const titleEl = document.querySelector(".card-title") as Element;
    const headerEl = document.querySelector(".column-header h2") as Element;
    const quickEl = document.querySelector(".quick-entry-input") as Element;
    const countEl = document.querySelector(".column-count") as Element;

    const getPx = (el: Element): number => {
      const fontSize = getComputedStyle(el).fontSize;
      const rootInline = document.documentElement.style.fontSize;
      const rootPx = rootInline.endsWith("%")
        ? (Number.parseFloat(rootInline) / 100) * 16
        : Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return effectivePxForFontSize(fontSize, rootPx);
    };

    document.documentElement.style.fontSize = "85%";
    const title85 = getPx(titleEl);
    const header85 = getPx(headerEl);
    const quick85 = getPx(quickEl);

    document.documentElement.style.fontSize = "100%";
    const title100 = getPx(titleEl);
    const header100 = getPx(headerEl);
    const quick100 = getPx(quickEl);
    const count100 = getPx(countEl);

    document.documentElement.style.fontSize = "125%";
    const title125 = getPx(titleEl);
    const header125 = getPx(headerEl);
    const quick125 = getPx(quickEl);

    expect(title100).toBeCloseTo(13, 2);
    expect(header100).toBeCloseTo(14, 2);
    expect(quick100).toBeCloseTo(13, 2);
    expect(count100).toBeCloseTo(12, 2);

    expect(title85).toBeCloseTo(11.05, 2);
    expect(header85).toBeCloseTo(11.9, 2);
    expect(quick85).toBeCloseTo(11.05, 2);

    expect(title125).toBeCloseTo(16.25, 2);
    expect(header125).toBeCloseTo(17.5, 2);
    expect(quick125).toBeCloseTo(16.25, 2);
  });
});
