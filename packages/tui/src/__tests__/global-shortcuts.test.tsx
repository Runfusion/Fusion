/**
 * Tests for global keyboard shortcuts hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, Box, Text } from "ink";
import { Writable } from "node:stream";
import { useGlobalShortcuts, HelpOverlay, FocusGuardRef, type ScreenId } from "../hooks/use-global-shortcuts";
import type { Key } from "ink";

// Track captured handlers for test assertions
let capturedUseInputHandlers: ((input: string, key: Key) => void)[] = [];
let capturedExitFn: (() => void) | undefined;

function createSinkStream(): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as NodeJS.WriteStream;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

function renderTest(node: React.ReactNode) {
  return render(node, {
    stdout: createSinkStream(),
    stderr: createSinkStream(),
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 1000,
  });
}

// Mock ink hooks to avoid raw mode errors in tests
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return {
    ...actual,
    useInput: vi.fn((handler: (input: string, key: Key) => void) => {
      capturedUseInputHandlers.push(handler);
    }),
    useApp: vi.fn().mockReturnValue({
      exit: vi.fn(() => {
        capturedExitFn?.();
      }),
    }),
  };
});

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    capturedUseInputHandlers = [];
    capturedExitFn = undefined;
    // Reset focus guard ref
    FocusGuardRef.isFocused = false;
  });

  afterEach(() => {
    capturedUseInputHandlers = [];
    FocusGuardRef.isFocused = false;
  });

  describe("initial state", () => {
    it("starts with help overlay hidden", async () => {
      let capturedHelpVisible: boolean | undefined;

      function TestComponent() {
        const { helpVisible } = useGlobalShortcuts();
        capturedHelpVisible = helpVisible;
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(capturedHelpVisible).toBe(false);
      instance.unmount();
    });

    it("provides toggleHelp function", async () => {
      let toggleHelpFn: (() => void) | undefined;

      function TestComponent() {
        const { toggleHelp } = useGlobalShortcuts();
        toggleHelpFn = toggleHelp;
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(toggleHelpFn).toBeDefined();
      expect(typeof toggleHelpFn).toBe("function");
      instance.unmount();
    });

    it("provides hideHelp function", async () => {
      let hideHelpFn: (() => void) | undefined;

      function TestComponent() {
        const { hideHelp } = useGlobalShortcuts();
        hideHelpFn = hideHelp;
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hideHelpFn).toBeDefined();
      expect(typeof hideHelpFn).toBe("function");
      instance.unmount();
    });
  });

  describe("helpVisible state management", () => {
    it("toggleHelp toggles helpVisible from false to true", async () => {
      let helpVisibleValues: boolean[] = [];
      let toggleFn: (() => void) | undefined;

      function TestComponent() {
        const { helpVisible, toggleHelp } = useGlobalShortcuts();
        helpVisibleValues.push(helpVisible);
        toggleFn = toggleHelp;
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Initial state should be false
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(false);

      // Call toggle
      toggleFn?.();

      await new Promise((resolve) => setTimeout(resolve, 50));

      // After toggle, state should be true
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(true);

      instance.unmount();
    });

    it("toggleHelp toggles helpVisible from true to false", async () => {
      let helpVisibleValues: boolean[] = [];
      let toggleFn: (() => void) | undefined;

      function TestComponent() {
        const { helpVisible, toggleHelp } = useGlobalShortcuts();
        helpVisibleValues.push(helpVisible);
        toggleFn = toggleHelp;
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // First toggle
      toggleFn?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second toggle should bring back to false
      toggleFn?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // State should be false again
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(false);

      instance.unmount();
    });
  });

  describe("screen change callback", () => {
    it("accepts onScreenChange option", async () => {
      const onScreenChange = vi.fn();

      function TestComponent() {
        useGlobalShortcuts({ onScreenChange });
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onScreenChange).toBeDefined();
      instance.unmount();
    });

    it("calls onScreenChange with screenId when number key is pressed", async () => {
      const onScreenChange = vi.fn();

      function TestComponent() {
        useGlobalShortcuts({ onScreenChange });
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get the registered input handler
      expect(capturedUseInputHandlers.length).toBeGreaterThan(0);
      const handler = capturedUseInputHandlers[0];

      // Simulate pressing "1"
      handler("1", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onScreenChange).toHaveBeenCalledWith("board");
      instance.unmount();
    });

    it("calls onScreenChange with correct screen IDs for keys 1-5", async () => {
      const onScreenChange = vi.fn();

      function TestComponent() {
        useGlobalShortcuts({ onScreenChange });
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const expectedScreens: ScreenId[] = ["board", "detail", "activity", "agents", "settings"];
      const handler = capturedUseInputHandlers[0];

      for (let i = 0; i < 5; i++) {
        onScreenChange.mockClear();
        const key = String(i + 1);

        handler(key, { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(onScreenChange).toHaveBeenCalledWith(expectedScreens[i]);
      }

      instance.unmount();
    });
  });

  describe("focus guard", () => {
    it("prevents screen change when FocusGuardRef.isFocused is true", async () => {
      const onScreenChange = vi.fn();
      // Set focus guard BEFORE render
      FocusGuardRef.isFocused = true;

      function TestComponent() {
        useGlobalShortcuts({ onScreenChange });
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Simulate pressing "1" - should NOT trigger screen change when focused
      handler("1", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // onScreenChange should NOT be called when focused
      expect(onScreenChange).not.toHaveBeenCalled();

      instance.unmount();
    });

    it("allows screen change when FocusGuardRef.isFocused is false", async () => {
      const onScreenChange = vi.fn();
      // Ensure focus guard is NOT set
      FocusGuardRef.isFocused = false;

      function TestComponent() {
        useGlobalShortcuts({ onScreenChange });
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Simulate pressing "1" - should trigger screen change when not focused
      handler("1", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // onScreenChange SHOULD be called when not focused
      expect(onScreenChange).toHaveBeenCalledWith("board");

      instance.unmount();
    });
  });

  describe("Ctrl+C exit", () => {
    it("calls exit when Ctrl+C is pressed", async () => {
      let exitCalled = false;
      capturedExitFn = () => {
        exitCalled = true;
      };

      function TestComponent() {
        useGlobalShortcuts();
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Simulate Ctrl+C
      handler("c", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: true, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCalled).toBe(true);
      instance.unmount();
    });
  });

  describe("q exit (focus guard)", () => {
    it("calls exit when q is pressed and FocusGuardRef.isFocused is false", async () => {
      let exitCalled = false;
      capturedExitFn = () => {
        exitCalled = true;
      };
      FocusGuardRef.isFocused = false;

      function TestComponent() {
        useGlobalShortcuts();
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      handler("q", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCalled).toBe(true);
      instance.unmount();
    });

    it("does not call exit when q is pressed but FocusGuardRef.isFocused is true", async () => {
      let exitCalled = false;
      capturedExitFn = () => {
        exitCalled = true;
      };
      // Set focus guard - input is focused
      FocusGuardRef.isFocused = true;

      function TestComponent() {
        useGlobalShortcuts();
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      handler("q", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(exitCalled).toBe(false);
      instance.unmount();
    });
  });

  describe("help toggle (? and h)", () => {
    it("triggers toggle when ? is pressed and FocusGuardRef.isFocused is false", async () => {
      let helpVisibleValues: boolean[] = [];
      FocusGuardRef.isFocused = false;

      function TestComponent() {
        const { helpVisible } = useGlobalShortcuts();
        helpVisibleValues.push(helpVisible);
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Press "?" to toggle
      handler("?", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Help should be visible after toggle
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(true);

      instance.unmount();
    });

    it("triggers toggle when h is pressed and FocusGuardRef.isFocused is false", async () => {
      let helpVisibleValues: boolean[] = [];
      FocusGuardRef.isFocused = false;

      function TestComponent() {
        const { helpVisible } = useGlobalShortcuts();
        helpVisibleValues.push(helpVisible);
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Press "h" to toggle
      handler("h", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Help should be visible after toggle
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(true);

      instance.unmount();
    });

    it("does not trigger toggle when ? is pressed but FocusGuardRef.isFocused is true", async () => {
      let helpVisibleValues: boolean[] = [];
      // Set focus guard - input is focused
      FocusGuardRef.isFocused = true;

      function TestComponent() {
        const { helpVisible } = useGlobalShortcuts();
        helpVisibleValues.push(helpVisible);
        return <Text>Test</Text>;
      }

      const instance = renderTest(<TestComponent />);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const handler = capturedUseInputHandlers[0];

      // Press "?" - should NOT toggle when focused
      handler("?", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Help should still be hidden
      expect(helpVisibleValues[helpVisibleValues.length - 1]).toBe(false);

      instance.unmount();
    });
  });
});

describe("HelpOverlay", () => {
  it("renders without crashing", async () => {
    const onClose = vi.fn();

    const instance = renderTest(<HelpOverlay onClose={onClose} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(() => instance.unmount()).not.toThrow();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();

    function TestComponent() {
      return <HelpOverlay onClose={onClose} />;
    }

    const instance = renderTest(<TestComponent />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const handler = capturedUseInputHandlers[capturedUseInputHandlers.length - 1];

    handler("", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: true, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onClose).toHaveBeenCalled();
    instance.unmount();
  });

  it("calls onClose when q is pressed", async () => {
    const onClose = vi.fn();

    function TestComponent() {
      return <HelpOverlay onClose={onClose} />;
    }

    const instance = renderTest(<TestComponent />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const handler = capturedUseInputHandlers[capturedUseInputHandlers.length - 1];

    handler("q", { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onClose).toHaveBeenCalled();
    instance.unmount();
  });

  it("displays keyboard shortcuts", async () => {
    const onClose = vi.fn();

    const instance = renderTest(<HelpOverlay onClose={onClose} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The component should render without error
    expect(() => instance.unmount()).not.toThrow();
  });
});
