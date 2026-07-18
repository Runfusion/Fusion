import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingWindow } from "../FloatingWindow";

interface QuickChatHarnessProps {
  projectId?: string;
  onChatMount: () => void;
}

/*
FNXC:ChatModal 2026-07-18-00:00:
This focused App-shaped harness retains the production lifecycle boundary: Quick Chat lazily mounts
only after the first open, then passes `hidden={!open}` to FloatingWindow. Keeping the test at this
seam proves the user-visible close/reopen symptom without loading App's unrelated dashboard data.
*/
function QuickChatHarness({ projectId, onChatMount }: QuickChatHarnessProps) {
  const [open, setOpen] = useState(false);
  const [everOpenedProjectId, setEverOpenedProjectId] = useState<string | null>(null);
  const trackedProjectId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (trackedProjectId.current !== projectId) {
      trackedProjectId.current = projectId;
      setEverOpenedProjectId(open && projectId ? projectId : null);
      return;
    }
    if (open && projectId) setEverOpenedProjectId(projectId);
  }, [open, projectId]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open Quick Chat</button>
      <button type="button" onClick={() => setOpen(false)}>Close Quick Chat</button>
      {projectId && everOpenedProjectId === projectId && (
        <FloatingWindow key={projectId} windowKey="quick-chat-persist" title="Chat" hidden={!open} onClose={() => setOpen(false)} className="floating-window--chat" suspendGeometryPersistenceOnMobile>
          <RetainedChatProbe projectId={projectId} onMount={onChatMount} />
        </FloatingWindow>
      )}
    </>
  );
}

function RetainedChatProbe({ projectId, onMount }: { projectId: string; onMount: () => void }) {
  const [session, setSession] = useState("Session one");
  useEffect(() => onMount(), [onMount]);
  return (
    <div data-testid="quick-chat-body" data-project-id={projectId}>
      <span data-testid="quick-chat-session">{session}</span>
      <button type="button" onClick={() => setSession("Session two")}>Change session</button>
      <div data-testid="quick-chat-scroll" />
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Quick Chat persistent close/reopen lifecycle", () => {
  it("does not mount ChatView before Quick Chat has ever opened", () => {
    render(<QuickChatHarness projectId="project-a" onChatMount={() => {}} />);

    expect(screen.queryByTestId("quick-chat-body")).toBeNull();
  });

  it("retains the same chat instance, session, and scroll position across close and reopen", async () => {
    const onChatMount = vi.fn();
    render(<QuickChatHarness projectId="project-a" onChatMount={onChatMount} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Quick Chat" }));
    const chatBody = await screen.findByTestId("quick-chat-body");
    const scroll = screen.getByTestId("quick-chat-scroll");
    Object.defineProperty(scroll, "scrollTop", { configurable: true, value: 143, writable: true });
    fireEvent.click(screen.getByRole("button", { name: "Change session" }));
    expect(screen.getByTestId("quick-chat-session")).toHaveTextContent("Session two");
    expect(onChatMount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close Quick Chat" }));
    expect(screen.getByTestId("quick-chat-body")).toBe(chatBody);
    expect(screen.getByTestId("floating-window-overlay-quick-chat-persist")).toHaveClass("floating-window-overlay--hidden");

    fireEvent.click(screen.getByRole("button", { name: "Open Quick Chat" }));
    expect(screen.getByTestId("quick-chat-body")).toBe(chatBody);
    expect(screen.getByTestId("quick-chat-scroll")).toHaveProperty("scrollTop", 143);
    expect(screen.getByTestId("quick-chat-session")).toHaveTextContent("Session two");
    expect(onChatMount).toHaveBeenCalledTimes(1);
  });

  it("hides the retained desktop window and the mobile full-screen sheet", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 768px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(<QuickChatHarness projectId="project-a" onChatMount={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Quick Chat" }));
    await screen.findByTestId("quick-chat-body");
    fireEvent.click(screen.getByRole("button", { name: "Close Quick Chat" }));

    const overlay = screen.getByTestId("floating-window-overlay-quick-chat-persist");
    expect(overlay).toHaveClass("floating-window-overlay--hidden");
    expect(screen.getByTestId("quick-chat-body")).toBeTruthy();
  });

  it("unmounts the old project's retained chat instead of leaking it into the next project", async () => {
    const onChatMount = vi.fn();
    const { rerender } = render(<QuickChatHarness projectId="project-a" onChatMount={onChatMount} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Quick Chat" }));
    await screen.findByTestId("quick-chat-body");
    expect(screen.getByTestId("quick-chat-body")).toHaveAttribute("data-project-id", "project-a");

    rerender(<QuickChatHarness projectId="project-b" onChatMount={onChatMount} />);
    await waitFor(() => expect(screen.getByTestId("quick-chat-body")).toHaveAttribute("data-project-id", "project-b"));
    expect(onChatMount).toHaveBeenCalledTimes(2);
  });
});
