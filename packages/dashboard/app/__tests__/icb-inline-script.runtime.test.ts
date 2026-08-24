import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((source) => source.includes("--icb-bottom-offset") && source.includes("viewportOffset.ts"));
if (scripts.length !== 1) throw new Error(`Expected one ICB script, found ${scripts.length}`);
const source = scripts[0];

function setWindowNumber(name: "innerWidth" | "innerHeight", value: number) {
  Object.defineProperty(window, name, { configurable: true, value });
}
function installViewport(height: number, scale = 1) {
  const target = new EventTarget();
  const viewport = {
    width: 390, height, offsetTop: 0, offsetLeft: 0, scale,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}
function runScript() { new Function(source)(); }

describe("inline ICB compensation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.style.removeProperty("--icb-bottom-offset");
    document.documentElement.style.removeProperty("--icb-right-offset");
    setWindowNumber("innerWidth", 390); setWindowNumber("innerHeight", 844);
  });
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

  it("does not lift bars for a focused null-baseline viewport", () => {
    installViewport(508); const field = document.createElement("textarea"); document.body.append(field); field.focus();
    runScript();
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("0px");
  });

  it("does not retain a stale baseline after focus", () => {
    const viewport = installViewport(754); runScript();
    const field = document.createElement("textarea"); document.body.append(field); field.focus();
    (viewport as { height: number }).height = 508;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("0px");
  });

  it("safely publishes zero offsets without visualViewport, including focus and timeout tails", () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    const field = document.createElement("textarea"); document.body.append(field); field.focus();
    expect(runScript).not.toThrow();
    expect(windowAdd).toHaveBeenCalledWith("resize", expect.any(Function));
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("0px");
    expect(document.documentElement.style.getPropertyValue("--icb-right-offset")).toBe("0px");
    vi.advanceTimersByTime(3000);
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("0px");
    expect(document.documentElement.style.getPropertyValue("--icb-right-offset")).toBe("0px");
    windowAdd.mockRestore();
  });


  it("preserves unfocused and pinch-zoom compensation", () => {
    installViewport(508); runScript();
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("336px");
    document.body.replaceChildren(); const field = document.createElement("textarea"); document.body.append(field); field.focus();
    installViewport(508, 1.5); runScript();
    expect(document.documentElement.style.getPropertyValue("--icb-bottom-offset")).toBe("336px");
  });
});
