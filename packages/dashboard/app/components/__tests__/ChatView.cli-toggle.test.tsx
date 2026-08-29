// CLI-backed chat surface tests (CLI Agent Executor, U12).
//
// Exercises the transcript ↔ terminal toggle, the terminal-owns-composer rule,
// the generic-tier terminal-only rendering, and the composer queued indicator.
// SessionTerminal is mocked (no xterm / no WS / no PTY / no port 4040) so these
// are pure component-behavior assertions.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Mock SessionTerminal — it lazy-loads xterm and opens a WS; we only need to
// assert presence/absence of the terminal surface.
vi.mock("../SessionTerminal", () => ({
  SessionTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-terminal" data-session-id={sessionId}>
      terminal
    </div>
  ),
}));

import { CliChatSurface } from "../CliChatSurface";

function renderSurface(overrides: Partial<React.ComponentProps<typeof CliChatSurface>> = {}) {
  return render(
    <CliChatSurface
      cliSessionId="cli-1"
      tier="hybrid"
      projectId="proj-1"
      renderTranscript={() => <div data-testid="transcript">transcript-rows</div>}
      renderComposer={() => <textarea data-testid="composer" />}
      {...overrides}
    />,
  );
}

describe("CliChatSurface — hybrid tier toggle", () => {
  it("defaults to the transcript view with the composer visible", () => {
    renderSurface();
    expect(screen.getByTestId("transcript")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(screen.queryByTestId("session-terminal")).toBeNull();
  });

  it("toggling to terminal swaps the message list for the terminal and HIDES the composer", () => {
    renderSurface();
    fireEvent.click(screen.getByRole("tab", { name: /terminal/i }));
    expect(screen.getByTestId("session-terminal")).toBeTruthy();
    // Message list replaced and composer hidden — the terminal owns input.
    expect(screen.queryByTestId("transcript")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
  });

  it("toggling back restores the transcript and composer (one underlying session)", () => {
    renderSurface();
    fireEvent.click(screen.getByRole("tab", { name: /terminal/i }));
    const term = screen.getByTestId("session-terminal");
    expect(term.getAttribute("data-session-id")).toBe("cli-1");
    fireEvent.click(screen.getByRole("tab", { name: /transcript/i }));
    expect(screen.getByTestId("transcript")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(screen.queryByTestId("session-terminal")).toBeNull();
  });

  it("the terminal attaches to the same cli session id as the toggle reflects", () => {
    renderSurface({ cliSessionId: "cli-shared" });
    fireEvent.click(screen.getByRole("tab", { name: /terminal/i }));
    expect(screen.getByTestId("session-terminal").getAttribute("data-session-id")).toBe(
      "cli-shared",
    );
  });
});

describe("CliChatSurface — generic tier", () => {
  it("renders the terminal only: no toggle, no transcript pane, no composer", () => {
    renderSurface({ tier: "generic" });
    expect(screen.getByTestId("session-terminal")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("transcript")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
  });
});

describe("CliChatSurface — composer queue indicator", () => {
  it("shows a queued indicator when messages are queued behind a busy session", () => {
    renderSurface({ queuedCount: 2 });
    expect(screen.getByRole("status").textContent).toMatch(/queued/i);
  });

  it("hides the queued indicator when nothing is queued", () => {
    renderSurface({ queuedCount: 0 });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not render the queued indicator in raw-terminal mode (composer hidden)", () => {
    renderSurface({ queuedCount: 3 });
    fireEvent.click(screen.getByRole("tab", { name: /terminal/i }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
