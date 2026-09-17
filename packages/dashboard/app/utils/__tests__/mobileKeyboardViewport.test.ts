import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _keyboardViewportListenerCount,
  areKeyboardViewportFramesEqual,
  getKeyboardViewportFrame,
  isKeyboardEditableElement,
  readKeyboardViewportFrame,
  subscribeKeyboardViewport,
  type KeyboardViewportFrame,
} from "../mobileKeyboardViewport";
import {
  installManualAnimationFrames,
  installMobileKeyboardViewport,
  flushAnimationFrames,
  type MobileKeyboardViewportHarness,
} from "../../test/mobileKeyboardViewport";

let harness: MobileKeyboardViewportHarness | null = null;
let restoreFrames: (() => void) | null = null;

afterEach(() => {
  restoreFrames?.();
  restoreFrames = null;
  harness?.restore();
  harness = null;
});

const PHONE = { layoutHeight: 844, visualHeight: 844, visualWidth: 390 };

describe("readKeyboardViewportFrame — visible rectangle", () => {
  it("reports the whole layout viewport with no keyboard", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const frame = readKeyboardViewportFrame()!;
    expect(frame.visibleBottom).toBe(844);
    expect(frame.residualBottomInset).toBe(0);
    expect(frame.coherent).toBe(true);
  });

  it("bounds the visible area at the visual height when only the visual viewport shrinks (WebKit)", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    const frame = readKeyboardViewportFrame()!;
    expect(frame.visibleBottom).toBe(500);
    expect(frame.residualBottomInset).toBe(344);
  });

  it("adds a positive offsetTop to the visible bottom edge", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500, offsetTop: 40 });
    const frame = readKeyboardViewportFrame()!;
    expect(frame.visibleBottom).toBe(540);
    expect(frame.residualBottomInset).toBe(304);
  });

  it("reports ZERO residual inset when the browser already resized the layout viewport", () => {
    // Android Chrome with interactive-widget=resizes-content. innerHeight deliberately lags.
    harness = installMobileKeyboardViewport({
      layoutHeight: 500,
      innerHeight: 844,
      visualHeight: 500,
      visualWidth: 390,
    });
    const frame = readKeyboardViewportFrame()!;
    expect(frame.visibleBottom).toBe(500);
    expect(frame.residualBottomInset).toBe(0);
  });

  it("never derives a keyboard height from the screen on a first already-shrunk sample", () => {
    harness = installMobileKeyboardViewport({ layoutHeight: 500, visualHeight: 500, visualWidth: 390 });
    const frame = readKeyboardViewportFrame()!;
    // The only bound available is what the browser published; nothing is invented from screen size.
    expect(frame.residualBottomInset).toBe(0);
    expect(frame.visibleBottom).toBe(frame.layoutHeight);
  });

  it("marks a physically impossible transitional sample incoherent", () => {
    harness = installMobileKeyboardViewport({ layoutHeight: 500, visualHeight: 844, offsetTop: 40, visualWidth: 390 });
    expect(readKeyboardViewportFrame()!.coherent).toBe(false);
  });

  it("flags zoom instead of reporting it as occlusion", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500, scale: 2 });
    const frame = readKeyboardViewportFrame()!;
    expect(frame.zoomed).toBe(true);
    expect(frame.visibleBottom).toBe(500);
  });

  it("falls back to the layout viewport when the Visual Viewport API is absent", () => {
    harness = installMobileKeyboardViewport(PHONE);
    harness.removeVisualViewport();
    const frame = readKeyboardViewportFrame()!;
    expect(frame.residualBottomInset).toBe(0);
    expect(frame.visibleBottom).toBe(844);
    expect(Number.isNaN(frame.visibleBottom)).toBe(false);
  });

  it.each([
    ["NaN height", Number.NaN],
    ["negative height", -12],
    ["zero height", 0],
  ])("falls back safely on a transient %s sample", (_label, visualHeight) => {
    harness = installMobileKeyboardViewport(PHONE);
    harness.viewport.height = visualHeight as number;
    const frame = readKeyboardViewportFrame()!;
    expect(Number.isFinite(frame.visibleBottom)).toBe(true);
    expect(frame.residualBottomInset).toBeGreaterThanOrEqual(0);
  });
});

describe("frame identity", () => {
  it("treats identical metrics as the same frame", () => {
    harness = installMobileKeyboardViewport(PHONE);
    expect(areKeyboardViewportFramesEqual(readKeyboardViewportFrame(), readKeyboardViewportFrame())).toBe(true);
  });

  it("distinguishes a changed offsetTop", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    const first = readKeyboardViewportFrame();
    harness.viewport.offsetTop = 40;
    expect(areKeyboardViewportFramesEqual(first, readKeyboardViewportFrame())).toBe(false);
  });

  it("distinguishes a focus change that leaves the geometry identical", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    const blurred = readKeyboardViewportFrame()!;
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    const focused = readKeyboardViewportFrame()!;
    expect(focused.editableFocused).toBe(true);
    expect(blurred.editableFocused).toBe(false);
    expect(areKeyboardViewportFramesEqual(blurred, focused)).toBe(false);
    textarea.remove();
  });
});

describe("stale offset normalization", () => {
  it("drops a leftover offsetTop once the visual height fills the layout viewport again", () => {
    // WebKit restore shape: height already snapped back to 844 while offsetTop is still 120.
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 844, offsetTop: 120 });
    const frame = readKeyboardViewportFrame()!;
    expect(frame.offsetTop).toBe(0);
    expect(frame.visibleBottom).toBe(844);
    expect(frame.residualBottomInset).toBe(0);
    expect(frame.coherent).toBe(true);
  });

  it("keeps a genuine offsetTop while the visual viewport is really shorter", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500, offsetTop: 120 });
    expect(readKeyboardViewportFrame()!.offsetTop).toBe(120);
  });
});

describe("shared subscription", () => {
  it("installs one listener set for two consumers and publishes the same frame", () => {
    harness = installMobileKeyboardViewport(PHONE);
    restoreFrames = installManualAnimationFrames();

    const a: KeyboardViewportFrame[] = [];
    const b: KeyboardViewportFrame[] = [];
    const offA = subscribeKeyboardViewport((frame) => a.push(frame));
    const offB = subscribeKeyboardViewport((frame) => b.push(frame));
    expect(_keyboardViewportListenerCount()).toBe(2);

    harness.set({ ...PHONE, visualHeight: 500 });
    flushAnimationFrames();

    expect(a.at(-1)!.visibleBottom).toBe(500);
    expect(b.at(-1)!.visibleBottom).toBe(500);

    offA();
    offB();
    expect(_keyboardViewportListenerCount()).toBe(0);
  });

  it("does not re-publish for a duplicate event carrying identical metrics", () => {
    harness = installMobileKeyboardViewport(PHONE);
    restoreFrames = installManualAnimationFrames();
    const listener = vi.fn();
    const off = subscribeKeyboardViewport(listener);
    listener.mockClear();

    harness.emitResize();
    flushAnimationFrames();
    harness.emitResize();
    flushAnimationFrames();

    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("publishes a coherent height/offset pair from a scroll-only event", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    restoreFrames = installManualAnimationFrames();
    const frames: KeyboardViewportFrame[] = [];
    const off = subscribeKeyboardViewport((frame) => frames.push(frame));

    harness.viewport.offsetTop = 40;
    harness.emitScroll();
    flushAnimationFrames();

    const latest = frames.at(-1)!;
    expect(latest.offsetTop).toBe(40);
    expect(latest.visualHeight).toBe(500);
    expect(latest.visibleBottom).toBe(540);
    off();
  });

  it("holds the previous coherent frame while an impossible sample is in flight", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    restoreFrames = installManualAnimationFrames();
    const frames: KeyboardViewportFrame[] = [];
    const off = subscribeKeyboardViewport((frame) => frames.push(frame));
    const settled = frames.at(-1)!;

    harness.set({ layoutHeight: 500, visualHeight: 844, offsetTop: 40, visualWidth: 390 });
    flushAnimationFrames(1);

    expect(frames.at(-1)!.visibleBottom).toBe(settled.visibleBottom);
    off();
  });

  it("converges to the same frame whether resize precedes focus or follows it", () => {
    harness = installMobileKeyboardViewport(PHONE);
    restoreFrames = installManualAnimationFrames();
    const first: KeyboardViewportFrame[] = [];
    const offFirst = subscribeKeyboardViewport((frame) => first.push(frame));
    harness.set({ ...PHONE, visualHeight: 500 });
    harness.emitFocusIn();
    flushAnimationFrames(4);
    const resizeThenFocus = first.at(-1)!;
    offFirst();

    harness.restore();
    harness = installMobileKeyboardViewport(PHONE);
    const second: KeyboardViewportFrame[] = [];
    const offSecond = subscribeKeyboardViewport((frame) => second.push(frame));
    harness.emitFocusIn();
    harness.set({ ...PHONE, visualHeight: 500 });
    flushAnimationFrames(4);
    const focusThenResize = second.at(-1)!;
    offSecond();

    expect(focusThenResize.visibleBottom).toBe(resizeThenFocus.visibleBottom);
    expect(focusThenResize.residualBottomInset).toBe(resizeThenFocus.residualBottomInset);
  });

  it("removes every shared listener and pending frame once the last consumer leaves", () => {
    harness = installMobileKeyboardViewport(PHONE);
    restoreFrames = installManualAnimationFrames();
    const listener = vi.fn();
    const off = subscribeKeyboardViewport(listener);
    off();
    listener.mockClear();

    harness.set({ ...PHONE, visualHeight: 500 });
    flushAnimationFrames(4);

    expect(listener).not.toHaveBeenCalled();
    expect(getKeyboardViewportFrame()!.visibleBottom).toBe(500);
  });

  it("re-samples after a pageshow restore", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    restoreFrames = installManualAnimationFrames();
    const frames: KeyboardViewportFrame[] = [];
    const off = subscribeKeyboardViewport((frame) => frames.push(frame));

    harness.setSilently(PHONE);
    harness.emitPageShow();
    flushAnimationFrames(2);

    expect(frames.at(-1)!.visibleBottom).toBe(844);
    off();
  });

  it("re-samples when the document becomes visible again", () => {
    harness = installMobileKeyboardViewport({ ...PHONE, visualHeight: 500 });
    restoreFrames = installManualAnimationFrames();
    const frames: KeyboardViewportFrame[] = [];
    const off = subscribeKeyboardViewport((frame) => frames.push(frame));

    harness.setSilently(PHONE);
    harness.emitVisibility("visible");
    flushAnimationFrames(2);

    expect(frames.at(-1)!.visibleBottom).toBe(844);
    off();
  });
});

describe("isKeyboardEditableElement", () => {
  it("accepts a textarea and a text input", () => {
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    input.type = "text";
    expect(isKeyboardEditableElement(textarea)).toBe(true);
    expect(isKeyboardEditableElement(input)).toBe(true);
  });

  it.each(["checkbox", "radio", "button", "submit", "file", "range", "color"])(
    "rejects a %s input that raises no keyboard",
    (type) => {
      const input = document.createElement("input");
      input.type = type;
      expect(isKeyboardEditableElement(input)).toBe(false);
    },
  );

  it("rejects disabled and readonly editors", () => {
    const disabled = document.createElement("textarea");
    disabled.disabled = true;
    const readOnly = document.createElement("input");
    readOnly.type = "text";
    readOnly.readOnly = true;
    expect(isKeyboardEditableElement(disabled)).toBe(false);
    expect(isKeyboardEditableElement(readOnly)).toBe(false);
  });

  it("rejects null and non-editable nodes", () => {
    expect(isKeyboardEditableElement(null)).toBe(false);
    expect(isKeyboardEditableElement(document.createElement("div"))).toBe(false);
  });
});
