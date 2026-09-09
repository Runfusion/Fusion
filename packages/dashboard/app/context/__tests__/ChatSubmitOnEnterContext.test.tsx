import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ChatSubmitOnEnterProvider,
  normalizeChatSubmitOnEnterMode,
  resolveChatEnterSubmits,
  useChatEnterSubmits,
  useChatSubmitOnEnterMode,
} from "../ChatSubmitOnEnterContext";
import { COARSE_POINTER_MEDIA_QUERY } from "../../hooks/useCoarsePointer";

function ModeProbe() {
  return <div data-testid="mode">{useChatSubmitOnEnterMode()}</div>;
}

function ResolutionProbe() {
  return <div data-testid="submits">{String(useChatEnterSubmits())}</div>;
}

const defaultMatchMedia = window.matchMedia;

function installPointerMedia(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === COARSE_POINTER_MEDIA_QUERY ? coarse : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: defaultMatchMedia,
  });
});

describe("ChatSubmitOnEnterContext", () => {
  it.each([
    ["auto", false, true],
    ["auto", true, false],
    ["always", false, true],
    ["always", true, true],
    ["never", false, false],
    ["never", true, false],
  ] as const)("resolves %s with softKeyboard=%s to %s", (mode, softKeyboard, expected) => {
    expect(resolveChatEnterSubmits(mode, { softKeyboard })).toBe(expected);
  });

  it.each([
    [undefined, "auto"],
    [null, "auto"],
    ["auto", "auto"],
    ["always", "always"],
    ["never", "never"],
    ["unknown", "auto"],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeChatSubmitOnEnterMode(value)).toBe(expected);
  });

  it("defaults unwrapped consumers to auto", () => {
    render(<ModeProbe />);
    expect(screen.getByTestId("mode")).toHaveTextContent("auto");
  });

  it("does not submit automatically for a coarse primary pointer", () => {
    installPointerMedia(true);
    render(
      <ChatSubmitOnEnterProvider value="auto">
        <ResolutionProbe />
      </ChatSubmitOnEnterProvider>,
    );
    expect(screen.getByTestId("submits")).toHaveTextContent("false");
  });

  it("submits automatically under the default fine-pointer test environment", () => {
    render(
      <ChatSubmitOnEnterProvider value={normalizeChatSubmitOnEnterMode(undefined)}>
        <ResolutionProbe />
      </ChatSubmitOnEnterProvider>,
    );
    expect(screen.getByTestId("submits")).toHaveTextContent("true");
  });
});
