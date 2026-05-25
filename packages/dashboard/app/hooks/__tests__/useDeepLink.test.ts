import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, createElement, type PropsWithChildren } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { useDeepLink } from "../useDeepLink";
import * as api from "../../api";
import type { ProjectInfo } from "../../api";

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
}));

const mockFetchTaskDetail = vi.mocked(api.fetchTaskDetail);

describe("useDeepLink", () => {
  const originalLocation = window.location;
  const originalReplaceState = window.history.replaceState;

  const defaultProject: ProjectInfo = {
    id: "proj_123",
    name: "Project 123",
    path: "/repo-123",
    status: "active",
    isolationMode: "in-process",
    createdAt: "",
    updatedAt: "",
  };

  const otherProject: ProjectInfo = {
    id: "proj_456",
    name: "Project 456",
    path: "/repo-456",
    status: "active",
    isolationMode: "in-process",
    createdAt: "",
    updatedAt: "",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState = vi.fn((_state, _unused, url) => {
      if (typeof url === "string" && url.length > 0) {
        Object.defineProperty(window, "location", {
          configurable: true,
          value: new URL(url, "http://localhost:3000"),
        });
      }
    }) as typeof window.history.replaceState;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/"),
    });

    mockFetchTaskDetail.mockResolvedValue({ id: "FN-123" } as never);
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    window.history.replaceState = originalReplaceState;
  });

  function renderUseDeepLink(overrides: Partial<Parameters<typeof useDeepLink>[0]> = {}) {
    const openTaskDetail = vi.fn();
    const closeTaskDetail = vi.fn();
    const setCurrentProject = vi.fn();
    const addToast = vi.fn();

    const options: Parameters<typeof useDeepLink>[0] = {
      projectId: defaultProject.id,
      projects: [defaultProject, otherProject],
      projectsLoading: false,
      currentProject: defaultProject,
      setCurrentProject,
      addToast,
      openTaskDetail,
      closeTaskDetail,
      ...overrides,
    };

    const hook = renderHook(() => useDeepLink(options));
    return { ...hook, options, openTaskDetail, closeTaskDetail, setCurrentProject, addToast };
  }

  it("does nothing when no task param is present", async () => {
    renderUseDeepLink();

    await waitFor(() => {
      expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    });
  });

  it("rewrites /tasks/:id path and opens detail", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/tasks/FN-9999"),
    });

    const { openTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalledWith(expect.anything(), "", "/?task=FN-9999");
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-9999", "proj_123");
      expect(openTaskDetail).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves project query when rewriting /tasks/:id path", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/tasks/FN-9999?project=proj_456"),
    });

    const { setCurrentProject } = renderUseDeepLink();

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalledWith(expect.anything(), "", "/?project=proj_456&task=FN-9999");
      expect(setCurrentProject).toHaveBeenCalledWith(otherProject);
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-9999", "proj_456");
    });
  });

  it("ignores invalid /tasks/:id path", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/tasks/not-a-task-id"),
    });

    renderUseDeepLink();

    await waitFor(() => {
      expect(window.history.replaceState).not.toHaveBeenCalled();
      expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    });
  });

  it("fetches and opens task detail for existing ?task deep-link without path rewrite", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-123"),
    });

    const { openTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
      expect(openTaskDetail).toHaveBeenCalledTimes(1);
    });

    expect(window.history.replaceState).not.toHaveBeenCalledWith(expect.anything(), "", "/?task=FN-123");
  });

  it("switches project for project-only deep links without opening task detail", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456"),
    });

    const { setCurrentProject, openTaskDetail, addToast } = renderUseDeepLink();

    await waitFor(() => {
      expect(setCurrentProject).toHaveBeenCalledTimes(1);
      expect(setCurrentProject).toHaveBeenCalledWith(otherProject);
    });

    expect(openTaskDetail).not.toHaveBeenCalled();
    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("shows unknown project toast only once under StrictMode", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=missing"),
    });

    const addToast = vi.fn();
    const strictWrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children);

    renderHook(() => useDeepLink({
      projectId: defaultProject.id,
      projects: [defaultProject, otherProject],
      projectsLoading: false,
      currentProject: defaultProject,
      setCurrentProject: vi.fn(),
      addToast,
      openTaskDetail: vi.fn(),
      closeTaskDetail: vi.fn(),
    }), { wrapper: strictWrapper });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("Project 'missing' not found", "error");
    });

    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
  });

  it("switches project and uses project param for task fetch", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-999"),
    });

    const { setCurrentProject, openTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(setCurrentProject).toHaveBeenCalledTimes(1);
      expect(setCurrentProject).toHaveBeenCalledWith(otherProject);
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-999", "proj_456");
      expect(openTaskDetail).toHaveBeenCalledTimes(1);
    });
  });

  it("shows toast and skips fetch for unknown project param", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=missing&task=FN-123"),
    });

    const { addToast, setCurrentProject } = renderUseDeepLink();

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Project 'missing' not found", "error");
    });

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(setCurrentProject).not.toHaveBeenCalled();
    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
  });

  it("keeps task-only deep-link behavior and strips task on detail close", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?task=FN-9999"),
    });

    const { result, setCurrentProject, closeTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-9999", "proj_123");
    });

    expect(setCurrentProject).not.toHaveBeenCalled();

    result.current.handleDetailClose();
    expect(window.history.replaceState).toHaveBeenCalledWith(expect.anything(), "", "/");
    expect(closeTaskDetail).toHaveBeenCalledTimes(1);
  });

  it("leaves mailbox view deep-link params intact after project switch", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&view=mailbox&mailbox-message=msg-1#message-msg-1"),
    });

    const { setCurrentProject, openTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(setCurrentProject).toHaveBeenCalledTimes(1);
      expect(setCurrentProject).toHaveBeenCalledWith(otherProject);
    });

    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    expect(openTaskDetail).not.toHaveBeenCalled();
    expect(window.location.search).toContain("view=mailbox");
    expect(window.location.search).toContain("mailbox-message=msg-1");
  });

  it("switches project for rooms view deep links without consuming room params", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&view=rooms&room=room-1"),
    });

    const { setCurrentProject, openTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(setCurrentProject).toHaveBeenCalledTimes(1);
      expect(setCurrentProject).toHaveBeenCalledWith(otherProject);
    });

    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    expect(openTaskDetail).not.toHaveBeenCalled();
    expect(window.location.search).toContain("view=rooms");
    expect(window.location.search).toContain("room=room-1");
  });

  it("waits for projects to load before resolving deep links", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-123"),
    });

    renderUseDeepLink({
      projectsLoading: true,
      currentProject: null,
    });

    await waitFor(() => {
      expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    });
  });

  it("cleans task query param when deep-linked modal closes and preserves history state", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_123&task=FN-123"),
    });
    const replaceStateMock = window.history.replaceState as ReturnType<typeof vi.fn>;
    window.history.replaceState = originalReplaceState;
    window.history.replaceState({ navIndex: 2, existing: "value" }, "");
    window.history.replaceState = replaceStateMock;

    const { result, closeTaskDetail } = renderUseDeepLink();

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-123", "proj_123");
    });

    result.current.handleDetailClose();

    expect(window.history.replaceState).toHaveBeenCalledWith(
      { navIndex: 2, existing: "value" },
      "",
      "/?project=proj_123",
    );
    expect(closeTaskDetail).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate fetches when rerendering after project switch", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("http://localhost:3000/?project=proj_456&task=FN-777"),
    });

    const addToast = vi.fn();
    const setCurrentProject = vi.fn();
    const openTaskDetail = vi.fn();
    const closeTaskDetail = vi.fn();

    const { rerender } = renderHook(
      (props: Parameters<typeof useDeepLink>[0]) => useDeepLink(props),
      {
        initialProps: {
          projectId: defaultProject.id,
          projects: [defaultProject, otherProject],
          projectsLoading: false,
          currentProject: defaultProject,
          setCurrentProject,
          addToast,
          openTaskDetail,
          closeTaskDetail,
        },
      },
    );

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);
    });

    rerender({
      projectId: otherProject.id,
      projects: [defaultProject, otherProject],
      projectsLoading: false,
      currentProject: otherProject,
      setCurrentProject,
      addToast,
      openTaskDetail,
      closeTaskDetail,
    });

    await waitFor(() => {
      expect(mockFetchTaskDetail).toHaveBeenCalledTimes(1);
    });
  });
});
