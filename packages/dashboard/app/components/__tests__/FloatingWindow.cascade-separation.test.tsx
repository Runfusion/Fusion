import { afterEach, describe, expect, it } from "vitest";
import {
  FLOATING_WINDOW_CASCADE_STEP_PX,
  resolveFloatingWindowCascade,
  type FloatingWindowPosition,
  type FloatingWindowSize,
} from "../FloatingWindow";

const VIEWPORT_PADDING = 16;
const originalViewport = {
  width: Object.getOwnPropertyDescriptor(window, "innerWidth"),
  height: Object.getOwnPropertyDescriptor(window, "innerHeight"),
};

interface CascadeCase {
  name: string;
  viewport: FloatingWindowSize;
  base: FloatingWindowPosition;
  size: FloatingWindowSize;
  minSize: FloatingWindowSize;
}

const cascadeCases: CascadeCase[] = [
  {
    name: "a window that fills a 1440x900 viewport",
    viewport: { width: 1440, height: 900 },
    base: { x: 16, y: 16 },
    size: { width: 1408, height: 868 },
    minSize: { width: 1200, height: 720 },
  },
  {
    name: "a window that fills a 1280x800 viewport",
    viewport: { width: 1280, height: 800 },
    base: { x: 16, y: 16 },
    size: { width: 1248, height: 768 },
    minSize: { width: 1080, height: 640 },
  },
  {
    name: "a large offset window",
    viewport: { width: 1440, height: 900 },
    base: { x: 120, y: 50 },
    size: { width: 1200, height: 800 },
    minSize: { width: 960, height: 640 },
  },
  {
    name: "a centered medium window",
    viewport: { width: 1440, height: 900 },
    base: { x: 230, y: 110 },
    size: { width: 980, height: 680 },
    minSize: { width: 720, height: 520 },
  },
];

function setViewport(viewport: FloatingWindowSize): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
}

function restoreViewport(): void {
  Object.defineProperty(window, "innerWidth", originalViewport.width!);
  Object.defineProperty(window, "innerHeight", originalViewport.height!);
}

afterEach(restoreViewport);

describe("resolveFloatingWindowCascade", () => {
  it.each(cascadeCases)("keeps $name visibly cascaded and contained", ({ viewport, base, size, minSize }) => {
    setViewport(viewport);

    const cascades = [1, 2, 3, 4].map((cascadeIndex) => ({
      cascadeIndex,
      ...resolveFloatingWindowCascade(base, size, minSize, cascadeIndex),
    }));

    for (const { offset, size: cascadedSize } of cascades) {
      expect(Math.max(Math.abs(offset.x), Math.abs(offset.y))).toBeGreaterThanOrEqual(FLOATING_WINDOW_CASCADE_STEP_PX);
      expect(cascadedSize.width).toBeGreaterThanOrEqual(minSize.width);
      expect(cascadedSize.height).toBeGreaterThanOrEqual(minSize.height);
      expect(base.x + offset.x).toBeGreaterThanOrEqual(VIEWPORT_PADDING);
      expect(base.y + offset.y).toBeGreaterThanOrEqual(VIEWPORT_PADDING);
      expect(base.x + offset.x + cascadedSize.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_PADDING);
      expect(base.y + offset.y + cascadedSize.height).toBeLessThanOrEqual(viewport.height - VIEWPORT_PADDING);
    }

    expect(new Set(cascades.map(({ offset, size: cascadedSize }) => JSON.stringify({ offset, size: cascadedSize })))).toHaveLength(cascades.length);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "returns the canonical geometry for cascade index %s",
    (cascadeIndex) => {
      const base = { x: 120, y: 80 };
      const size = { width: 900, height: 600 };
      const minSize = { width: 720, height: 480 };
      setViewport({ width: 1440, height: 900 });

      expect(resolveFloatingWindowCascade(base, size, minSize, cascadeIndex)).toEqual({
        offset: { x: 0, y: 0 },
        size,
      });
    },
  );
});
