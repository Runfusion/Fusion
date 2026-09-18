import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";
import { copyTextToClipboard } from "../../utils/copyToClipboard";
import {
  checkVersion,
  consumeVersionUpdateFlag,
  MIN_CHECK_INTERVAL_MS,
  _resetCheckState,
} from "../../versionCheck";

vi.mock("../../utils/copyToClipboard", () => ({ copyTextToClipboard: vi.fn(async () => true) }));
const mockCopy = vi.mocked(copyTextToClipboard);
import {
  ErrorBoundary,
  PageErrorBoundary,
  ModalErrorBoundary,
  RootErrorBoundary,
} from "../ErrorBoundary";

/** Matches what `resolveBuildVersion()` reads, so a check can report "unchanged". */
const BUILD_VERSION = "test-build-abc123";
vi.stubGlobal("__BUILD_VERSION__", BUILD_VERSION);

// Suppress console.error noise from React error boundary logging
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ---- Throwing child helper ----

function ThrowingChild({ shouldThrow }: { shouldThrow?: boolean }) {
  if (shouldThrow !== false) {
    throw new Error("Test render error");
  }
  return <div data-testid="child-ok">OK</div>;
}

// ---- Tests ----

describe("ErrorBoundary", () => {
  it("catches child render error and shows default fallback", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test render error")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Reload page")).toBeInTheDocument();
  });

  it("calls onError callback", () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom</div>}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("custom")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    // Default fallback should NOT appear
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("resetErrorBoundary recovers from error", () => {
    let shouldThrow = true;

    function ConditionalChild() {
      if (shouldThrow) {
        throw new Error("Test render error");
      }
      return <div data-testid="child-ok">OK</div>;
    }

    render(
      <ErrorBoundary>
        <ConditionalChild />
      </ErrorBoundary>,
    );

    // Error fallback should be visible
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByTestId("child-ok")).not.toBeInTheDocument();

    // Fix the error source before retrying
    shouldThrow = false;

    // Click Retry button
    act(() => {
      fireEvent.click(screen.getByText("Retry"));
    });

    // Child should now render successfully
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it('level prop applies correct CSS class for "page"', () => {
    render(
      <ErrorBoundary level="page">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--page");
  });

  it('level prop applies correct CSS class for "modal"', () => {
    render(
      <ErrorBoundary level="modal">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("This section encountered an error").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--modal");
  });

  it('level prop applies correct CSS class for "root"', () => {
    render(
      <ErrorBoundary level="root">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--root");
  });

  it("renders children normally when no error occurs", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});

describe("PageErrorBoundary", () => {
  it("renders with page level", () => {
    render(
      <PageErrorBoundary>
        <ThrowingChild />
      </PageErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--page");
  });
});

describe("ModalErrorBoundary", () => {
  it("renders with modal level", () => {
    render(
      <ModalErrorBoundary>
        <ThrowingChild />
      </ModalErrorBoundary>,
    );

    const container = screen.getByText("This section encountered an error").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--modal");
  });
});

describe("RootErrorBoundary", () => {
  it("renders with root level", () => {
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--root");
  });
});

/*
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: the operator hit the minified overlay on a phone with no console, so the fallback must expose
its own bounded diagnostic. These cases mount the REAL boundary with NO application provider — the
fallback has to work after everything else died — and cover every boundary level, a normal error, a
minified #185 error, copy success/refusal, a late copy answer, Retry, Reload, and the untouched custom
fallback priority.
*/
describe("ErrorBoundary diagnostics", () => {
  beforeEach(() => {
    mockCopy.mockReset();
    mockCopy.mockResolvedValue(true);
  });

  function ThrowSpecific({ error }: { error: unknown }): never {
    throw error as Error;
  }

  function reportText(): string {
    return screen.getByTestId("error-boundary-report").textContent ?? "";
  }

  it.each(["root", "page", "modal"] as const)("exposes collapsible details for the %s level", (level) => {
    render(
      <ErrorBoundary level={level}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(reportText()).toContain(`Boundary level: ${level}`);
    expect(reportText()).toContain("Test render error");
    expect(reportText()).toContain("Component stack:");
  });

  it("explains a minified React #185 error and links its documentation", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("Minified React error #185; visit https://react.dev/errors/185 for the full message")} />
      </RootErrorBoundary>,
    );

    expect(screen.getByText(/React stopped a render loop/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://react.dev/errors/185" }))
      .toHaveAttribute("href", "https://react.dev/errors/185");
    expect(reportText()).toContain("#185");
  });

  it("does not explain an unrelated error as a render loop", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("Cannot read properties of null")} />
      </RootErrorBoundary>,
    );

    expect(screen.queryByText(/React stopped a render loop/)).toBeNull();
  });

  it("survives a thrown value with no stack", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={Object.assign(new Error("No stack here"), { stack: undefined })} />
      </RootErrorBoundary>,
    );

    expect(reportText()).toContain("JavaScript stack:\n(unavailable)");
  });

  it("copies exactly the displayed report and reports success", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );
    const displayed = reportText();

    await user.click(screen.getByRole("button", { name: "Copy details" }));

    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockCopy.mock.calls[0][0]).toBe(displayed);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("keeps the report selectable and explains a refused copy", async () => {
    mockCopy.mockResolvedValue(false);
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Copy details" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Copy failed/ })).toBeInTheDocument());
    expect(reportText()).toContain("Test render error");
  });

  it("details and copy are reachable by keyboard", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;

    const summary = screen.getByText("Technical details") as HTMLElement;

    // A native <summary> is focusable and is the disclosure control itself.
    summary.focus();
    expect(document.activeElement).toBe(summary);
    expect(summary.tagName).toBe("SUMMARY");

    // jsdom does not synthesize summary activation from a key press, so activate it and then prove
    // the copy action is a real keyboard-reachable button rather than a pointer-only affordance.
    await user.click(summary);
    expect(details.open).toBe(true);

    const copy = screen.getByRole("button", { name: "Copy details" });
    copy.focus();
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{Enter}");
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });

  it("a copy answer arriving after Retry does not restore a stale diagnostic", async () => {
    let resolveCopy: ((value: boolean) => void) | null = null;
    mockCopy.mockImplementation(() => new Promise<boolean>((resolve) => { resolveCopy = resolve; }));
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error("First failure");
      return <div data-testid="child-ok">OK</div>;
    }
    render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    shouldThrow = false;
    act(() => { fireEvent.click(screen.getByText("Retry")); });
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();

    await act(async () => { resolveCopy?.(true); });

    // The recovered subtree stays recovered; no diagnostic returns.
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();
  });

  it("Retry clears the diagnostic and a fresh error produces a fresh one", () => {
    let message = "First failure";
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error(message);
      return <div data-testid="child-ok">OK</div>;
    }
    const view = render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );
    expect(reportText()).toContain("First failure");

    shouldThrow = false;
    act(() => { fireEvent.click(screen.getByText("Retry")); });
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();

    message = "Second failure";
    shouldThrow = true;
    view.unmount();
    render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );

    expect(reportText()).toContain("Second failure");
    expect(reportText()).not.toContain("First failure");
  });

  it("Reload page still reloads", () => {
    const reload = vi.fn();
    const previous = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...previous, reload } });
    try {
      render(
        <RootErrorBoundary>
          <ThrowingChild />
        </RootErrorBoundary>,
      );
      fireEvent.click(screen.getByText("Reload page"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: previous });
    }
  });

  it("a custom fallback keeps priority and receives no diagnostic controls", () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom</div>}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("custom")).toBeInTheDocument();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();
  });

  it("does not leak synthetic secret markers into the report or the copied text", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("POST https://user:FN515_SECRET_PW@api.test/tasks?token=FN515_SECRET_QS failed with Bearer FN515_SECRET_BEARER")} />
      </RootErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Copy details" }));
    const copied = mockCopy.mock.calls[0][0];

    for (const marker of ["FN515_SECRET_PW", "FN515_SECRET_QS", "FN515_SECRET_BEARER"]) {
      expect(reportText()).not.toContain(marker);
      expect(copied).not.toContain(marker);
    }
    expect(reportText()).toContain("api.test/tasks");
  });

  it("the fallback itself does not loop: one caught error renders one diagnostic", () => {
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    expect(screen.getAllByTestId("error-boundary-report")).toHaveLength(1);
    const logged = consoleSpy.mock.calls
      .map((call) => call.map((part) => (part instanceof Error ? part.message : String(part))).join(" "))
      .join("\n");
    expect(logged).not.toMatch(/Maximum update depth exceeded/i);
  });
});

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516: a failed dynamic import used to reload the page on the strength of the error message alone,
which is one of the ways a perfectly current page refreshed itself. The boundary now keeps the error,
its diagnostics, and its manual actions unless a bounded check proves a different live build. These
cases mount the real boundary levels at phone and desktop widths and observe `location.reload`.
*/
describe("ErrorBoundary chunk-load recovery", () => {
  const reloadSpy = vi.fn();
  let originalLocation: Location;
  let originalInnerWidth: number;

  function ThrowSpecific({ error }: { error: unknown }): never {
    throw error as Error;
  }

  function versionResponse(version: string) {
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version }),
    };
  }

  function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  }

  beforeEach(() => {
    originalLocation = window.location;
    originalInnerWidth = window.innerWidth;
    reloadSpy.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
    window.sessionStorage.clear();
    _resetCheckState();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetCheckState();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    vi.unstubAllGlobals();
    vi.stubGlobal("__BUILD_VERSION__", BUILD_VERSION);
  });

  const chunkError = new Error("Failed to fetch dynamically imported module: /assets/AgentsView-BrlYt0xn.js");

  it.each([
    ["root", 1280],
    ["page", 1280],
    ["modal", 1280],
    ["root", 390],
    ["page", 390],
    ["modal", 390],
  ] as const)(
    "keeps the %s boundary usable at %ipx when the served build is unchanged",
    async (level, width) => {
      const fetchSpy = vi.fn().mockResolvedValue(versionResponse(BUILD_VERSION));
      vi.stubGlobal("fetch", fetchSpy);
      setViewportWidth(width);

      render(
        <ErrorBoundary level={level}>
          <ThrowSpecific error={chunkError} />
        </ErrorBoundary>,
      );

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      expect(reloadSpy).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
      expect(
        screen.getByText(
          level === "modal" ? "This section encountered an error" : "Something went wrong",
        ),
      ).toBeInTheDocument();
      expect(screen.getByTestId("error-boundary-report")).toBeInTheDocument();
      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Reload page")).toBeInTheDocument();
    },
  );

  it("does not reload when the version read is unavailable", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <RootErrorBoundary>
        <ThrowSpecific error={chunkError} />
      </RootErrorBoundary>,
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-boundary-report")).toBeInTheDocument();
  });

  it("keeps Retry and Reload page working after a chunk error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse(BUILD_VERSION));
    vi.stubGlobal("fetch", fetchSpy);

    function Recoverable({ broken }: { broken: boolean }) {
      if (broken) throw chunkError;
      return <div data-testid="recovered">Recovered</div>;
    }

    function Host() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          level="page"
          onError={() => {
            /* the child is repaired before Retry is pressed */
          }}
        >
          <Recoverable broken={broken} />
          <button type="button" data-testid="repair" onClick={() => setBroken(false)}>
            repair
          </button>
        </ErrorBoundary>
      );
    }

    const { rerender } = render(<Host />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(reloadSpy).not.toHaveBeenCalled();

    // Reload page stays an explicit, working user action.
    fireEvent.click(screen.getByText("Reload page"));
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Retry re-renders the subtree; with a repaired child it recovers in place.
    rerender(<Host />);
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("still recovers automatically once a different build is confirmed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <RootErrorBoundary>
        <ThrowSpecific error={chunkError} />
      </RootErrorBoundary>,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(reloadSpy).not.toHaveBeenCalled();

    // A second, independent observation of the same different build confirms the deployment.
    vi.setSystemTime(Date.now() + MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(consumeVersionUpdateFlag()).toBe(true);
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  it("leaves an ordinary error untouched and performs no version read", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <PageErrorBoundary>
        <ThrowSpecific error={new Error("Cannot read properties of null")} />
      </PageErrorBoundary>,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Cannot read properties of null")).toBeInTheDocument();
  });
});
