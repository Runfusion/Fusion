import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetInitialViewportHeight, useMobileKeyboard } from "../useMobileKeyboard";
import {
  installMobileKeyboardViewport,
  type MobileKeyboardViewportHarness,
} from "../../test/mobileKeyboardViewport";
import { _keyboardViewportListenerCount } from "../../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 symptom reproduction at the hook boundary. Two failures were reported, and they are opposite
errors of the same broken measurement:

  (A) WebKit shape — only the visual viewport shrinks. The occluded band is real and must be
      reported, or the composer stays UNDER the keyboard.
  (B) Android `interactive-widget=resizes-content` shape — layout AND visual shrink together, and
      `window.innerHeight` can still report the pre-keyboard value. Nothing is occluded, so any
      reserved keyboard height becomes the empty band between the keyboard and the field.

Both must be answered from the same reader. These are driven metric sequences, not rendered layout:
jsdom performs no layout, so this file proves published state, cancellation, and lifetime only.
*/

let harness: MobileKeyboardViewportHarness | null = null;

const PHONE_PORTRAIT = { layoutHeight: 844, visualHeight: 844, visualWidth: 390 };

function mountEditor(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  act(() => textarea.focus());
  return textarea;
}

beforeEach(() => {
  _resetInitialViewportHeight();
  document.body.replaceChildren();
});

afterEach(() => {
  harness?.restore();
  harness = null;
  _resetInitialViewportHeight();
  document.body.replaceChildren();
});

describe("scenario A — WebKit: only the visual viewport shrinks", () => {
  it("reports the occluded band and the visible bottom edge", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });

    expect(result.current.keyboardOpen).toBe(true);
    expect(result.current.keyboardOverlap).toBe(344);
    expect(result.current.visibleBottom).toBe(500);
  });

  it("moves the visible bottom edge down with a positive offsetTop instead of stacking two offsets", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500, offsetTop: 40 });

    expect(result.current.visibleBottom).toBe(540);
    expect(result.current.viewportOffsetTop).toBe(40);
    // The residual band is measured against the visible bottom, never offset + a keyboard height.
    expect(result.current.keyboardOverlap).toBe(844 - 540);
  });

  it("converges to the same answer for resize→scroll and scroll→resize", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const first = renderHook(() => useMobileKeyboard());
    mountEditor();
    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500, offsetTop: 40 });
    harness.emitScroll();
    const resizeThenScroll = { ...first.result.current, frame: null };
    first.unmount();

    harness.restore();
    document.body.replaceChildren();
    _resetInitialViewportHeight();
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const second = renderHook(() => useMobileKeyboard());
    mountEditor();
    harness.setSilently({ ...PHONE_PORTRAIT, visualHeight: 500, offsetTop: 40 });
    harness.emitScroll();
    harness.emitResize();
    const scrollThenResize = { ...second.result.current, frame: null };
    second.unmount();

    expect(scrollThenResize.keyboardOverlap).toBe(resizeThenScroll.keyboardOverlap);
    expect(scrollThenResize.visibleBottom).toBe(resizeThenScroll.visibleBottom);
    expect(scrollThenResize.viewportOffsetTop).toBe(resizeThenScroll.viewportOffsetTop);
  });
});

describe("scenario B — Android resizes-content: layout already reduced", () => {
  it("reserves NOTHING when layout and visual shrink together", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    // innerHeight deliberately lags at the pre-keyboard value, as Chrome can report.
    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });

    expect(result.current.keyboardOpen).toBe(true);
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.visibleBottom).toBe(500);
  });

  it("does not resurrect a keyboard height from the closed baseline", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });
    // A second identical geometry event must not accumulate anything either.
    harness.emitResize();

    expect(result.current.keyboardOverlap).toBe(0);
  });

  it("still reports a residual band if only part of the layout was reclaimed", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ layoutHeight: 700, visualHeight: 500, visualWidth: 390 });

    expect(result.current.keyboardOverlap).toBe(200);
  });
});

describe("scenario C — close, refocus, and field transfer", () => {
  it("releases the keyboard state the instant focus leaves, even mid dismissal animation", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    const editor = mountEditor();
    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    expect(result.current.keyboardOpen).toBe(true);

    // Blur while the visual viewport is still reporting the keyboard-open size.
    act(() => editor.blur());
    harness.emitFocusOut();

    expect(result.current.keyboardOpen).toBe(false);
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.viewportHeight).toBeNull();
  });

  it("restores the resting geometry exactly after close → reopen → close", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    const editor = mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    act(() => editor.blur());
    harness.set(PHONE_PORTRAIT);
    const resting = { ...result.current, frame: null };

    act(() => editor.focus());
    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    expect(result.current.keyboardOpen).toBe(true);

    act(() => editor.blur());
    harness.set(PHONE_PORTRAIT);

    expect(result.current.keyboardOverlap).toBe(resting.keyboardOverlap);
    expect(result.current.viewportHeight).toBe(resting.viewportHeight);
    expect(result.current.viewportOffsetTop).toBe(resting.viewportOffsetTop);
    expect(result.current.keyboardOpen).toBe(false);
  });

  it("treats a field-to-field transfer as one continuous interaction", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    const first = mountEditor();
    const second = document.createElement("textarea");
    document.body.append(second);

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    expect(result.current.keyboardOpen).toBe(true);

    act(() => {
      first.blur();
      second.focus();
    });
    harness.emitFocusIn();

    // Geometry is unchanged, so the interaction must not be torn down and rebuilt.
    expect(result.current.keyboardOpen).toBe(true);
    expect(result.current.keyboardOverlap).toBe(344);
  });

  it("ignores a viewport shrink while no editable element is focused", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });

    expect(result.current.keyboardOpen).toBe(false);
  });

  it("never treats a non-editable control as a keyboard trigger", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.append(checkbox);
    act(() => checkbox.focus());

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });

    expect(result.current.keyboardOpen).toBe(false);
  });

  it("treats pinch zoom as zoom, not as occlusion", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 420, scale: 2 });

    expect(result.current.keyboardOpen).toBe(false);
    expect(result.current.keyboardOverlap).toBe(0);
  });
});

describe("lifetime and sharing", () => {
  it("shares one subscription across simultaneously mounted consumers and releases it fully", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const a = renderHook(() => useMobileKeyboard());
    const b = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    expect(a.result.current.keyboardOverlap).toBe(344);
    expect(b.result.current.keyboardOverlap).toBe(344);

    a.unmount();
    expect(_keyboardViewportListenerCount()).toBe(1);
    b.unmount();
    expect(_keyboardViewportListenerCount()).toBe(0);
  });

  it("publishes nothing after unmount, so a late transition cannot touch a gone surface", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result, unmount } = renderHook(() => useMobileKeyboard());
    mountEditor();
    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });
    const last = result.current;
    unmount();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 300 });

    expect(result.current.keyboardOverlap).toBe(last.keyboardOverlap);
  });

  it("stays closed with no visual viewport API and reports no invented geometry", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    harness.removeVisualViewport();
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    expect(result.current.keyboardOpen).toBe(false);
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.visibleBottom).toBe(844);
  });

  it("is inert on a pointer-fine desktop viewport", () => {
    harness = installMobileKeyboardViewport(
      { layoutHeight: 900, visualHeight: 900, visualWidth: 1280 },
      { touch: false },
    );
    const { result } = renderHook(() => useMobileKeyboard());
    mountEditor();

    harness.set({ layoutHeight: 900, visualHeight: 600, visualWidth: 1280 });

    expect(result.current.keyboardOpen).toBe(false);
    expect(result.current.keyboardOverlap).toBe(0);
  });

  it("tracks a tablet-width host when the caller opts in explicitly", () => {
    harness = installMobileKeyboardViewport({ layoutHeight: 1024, visualHeight: 1024, visualWidth: 900 });
    const { result } = renderHook(() => useMobileKeyboard({ allowNonMobileViewport: true }));
    mountEditor();

    harness.set({ layoutHeight: 1024, visualHeight: 700, visualWidth: 900 });

    expect(result.current.keyboardOpen).toBe(true);
    expect(result.current.keyboardOverlap).toBe(324);
  });

  it("publishes no geometry while disabled", () => {
    harness = installMobileKeyboardViewport(PHONE_PORTRAIT);
    const { result } = renderHook(() => useMobileKeyboard({ enabled: false }));
    mountEditor();

    harness.set({ ...PHONE_PORTRAIT, visualHeight: 500 });

    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.visibleBottom).toBeNull();
    expect(_keyboardViewportListenerCount()).toBe(0);
  });
});
