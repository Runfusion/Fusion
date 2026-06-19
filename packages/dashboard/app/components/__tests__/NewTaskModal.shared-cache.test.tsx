import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewTaskModal } from "../NewTaskModal";
import { useAgentsMapCache } from "../../hooks/useAgentsMapCache";
import { writeCache, SWR_CACHE_KEYS } from "../../utils/swrCache";

const mockFetchAgents = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
    uploadAttachment: vi.fn().mockResolvedValue({ attachment: null }),
  };
});

vi.mock("../../hooks/useSetupReadiness", () => ({ useSetupReadiness: vi.fn(() => ({ hasAiProvider: true, hasGithub: true, loading: false })) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: vi.fn(() => ({ confirm: vi.fn().mockResolvedValue(true) })) }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
}));
vi.mock("../../hooks/useNodes", () => ({ useNodes: vi.fn(() => ({ nodes: [] })) }));
vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn(() => "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    useViewportMode,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("NewTaskModal shared cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchAgents.mockResolvedValue([]);
  });

  const baseProps = {
    isOpen: true,
    projectId: "p1",
    tasks: [],
    onCreateTask: vi.fn(),
    addToast: vi.fn(),
    onClose: vi.fn(),
  };

  it("shows cached agents without cold fetch", () => {
    writeCache(`${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}p1`, [
      { id: "agent-1", name: "Agent One", role: "executor", state: "active" },
      { id: "agent-2", name: "Agent Two", role: "reviewer", state: "active" },
    ], { maxBytes: 500_000 });

    render(<NewTaskModal {...baseProps} />);
    fireEvent.click(screen.getByTestId("new-task-agent-button"));

    expect(screen.getByText("Agent One")).toBeInTheDocument();
    expect(screen.getByText("Agent Two")).toBeInTheDocument();
  });

  it("reuses warm cache across remounts", () => {
    writeCache(`${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}p1`, [
      { id: "agent-1", name: "Agent One", role: "executor", state: "active" },
    ], { maxBytes: 500_000 });

    const first = render(<NewTaskModal {...baseProps} />);
    first.unmount();
    render(<NewTaskModal {...baseProps} />);

    expect(mockFetchAgents.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("dedups agent fetch with another useAgentsMapCache consumer", () => {
    const request = deferred<Array<{ id: string; name: string; role: string; state: string }>>();
    mockFetchAgents.mockReturnValue(request.promise);

    function AgentsConsumer() {
      useAgentsMapCache("p1");
      return null;
    }

    render(
      <>
        <NewTaskModal {...baseProps} />
        <AgentsConsumer />
      </>,
    );

    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
    request.resolve([]);
  });

  it("opens picker synchronously on cache hit", () => {
    writeCache(`${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}p1`, [
      { id: "agent-1", name: "Agent One", role: "executor", state: "active" },
    ], { maxBytes: 500_000 });

    render(<NewTaskModal {...baseProps} />);
    fireEvent.click(screen.getByTestId("new-task-agent-button"));

    expect(screen.getByText("Select agent")).toBeInTheDocument();
    expect(screen.queryByText("Loading agents...")).toBeNull();
  });
});
