// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@fusion/dashboard/app/components/ViewHeader", () => ({
  ViewHeader: ({ title, actions }: { title: string; actions?: ReactNode }) => (
    <header><h1>{title}</h1>{actions}</header>
  ),
}));

const { artifactMediaUrlWithToken } = vi.hoisted(() => ({
  artifactMediaUrlWithToken: vi.fn((id: string, projectId?: string) => `/tokenized/${id}?projectId=${projectId}`),
}));
vi.mock("@fusion/dashboard/app/api/task-content", () => ({ artifactMediaUrlWithToken }));

import { QualityDashboardView, isVerificationVideo } from "../dashboard-view";

const executorVideo = {
  id: "artifact-executor",
  type: "video" as const,
  title: "Feature video: Executor task",
  taskId: "FN-8357",
  authorType: "system",
  authorId: "executor",
};
const operatorVideo = {
  id: "artifact-operator",
  type: "video" as const,
  title: "Feature video: Operator upload",
  taskId: "FN-8358",
  authorType: "user",
  authorId: "operator",
};

function response(body: unknown, ok = true): Response {
  return { ok, statusText: ok ? "OK" : "Request failed", json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) } as Response;
}

function mockFetch({ reviewArtifacts = "on", artifacts = [executorVideo], settingsOk = true, artifactsOk = true }: {
  reviewArtifacts?: "off" | "user-facing" | "on";
  artifacts?: typeof executorVideo[];
  settingsOk?: boolean;
  artifactsOk?: boolean;
} = {}) {
  globalThis.fetch = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/settings/scopes")) return Promise.resolve(response({ global: { reviewArtifacts }, project: {} }, settingsOk));
    if (url.startsWith("/api/artifacts?type=video")) return Promise.resolve(response(artifacts, artifactsOk));
    if (url.startsWith("/api/plugins/fusion-plugin-quality/runs")) return Promise.resolve(response({ runs: [] }));
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
}

function renderView(overrides: Partial<React.ComponentProps<typeof QualityDashboardView>["context"]> = {}) {
  const openTaskDetail = vi.fn();
  render(<QualityDashboardView context={{ projectId: "project-a", tasks: [{ id: "FN-8357" }] as never[], openTaskDetail, ...overrides }} />);
  return { openTaskDetail };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QualityDashboardView verification videos", () => {
  it("identifies only executor-produced system videos, not title-matched uploads", () => {
    expect(isVerificationVideo(executorVideo)).toBe(true);
    expect(isVerificationVideo(operatorVideo)).toBe(false);
  });

  it("shows only a disabled note when review artifacts are off", async () => {
    mockFetch({ reviewArtifacts: "off" });
    renderView();
    expect(await screen.findByTestId("quality-verification-videos-disabled")).toBeTruthy();
    expect(screen.queryByTestId("quality-verification-videos")).toBeNull();
  });

  it.each(["user-facing", "on"] as const)("renders executor videos when review artifacts is %s", async (reviewArtifacts) => {
    mockFetch({ reviewArtifacts, artifacts: [executorVideo, operatorVideo as typeof executorVideo] });
    renderView();
    expect(await screen.findByTestId("quality-verification-videos")).toBeTruthy();
    expect(screen.getAllByTestId("quality-verification-video-row")).toHaveLength(1);
    expect(screen.getByText(executorVideo.title)).toBeTruthy();
    expect(screen.queryByText(operatorVideo.title)).toBeNull();
    expect(document.querySelector("video")?.getAttribute("src")).toBe("/tokenized/artifact-executor?projectId=project-a");
  });

  it("shows an empty state and lists multiple videos when available", async () => {
    mockFetch({ artifacts: [] });
    const { rerender } = render(<QualityDashboardView context={{ projectId: "project-a", tasks: [], openTaskDetail: vi.fn() }} />);
    expect(await screen.findByTestId("quality-verification-videos-empty")).toBeTruthy();

    mockFetch({ artifacts: [executorVideo, { ...executorVideo, id: "artifact-second", title: "Feature video: Second task" }] });
    rerender(<QualityDashboardView context={{ projectId: "project-b", tasks: [], openTaskDetail: vi.fn() }} />);
    await waitFor(() => expect(screen.getAllByTestId("quality-verification-video-row")).toHaveLength(2));
  });

  it.each([
    ["settings", { settingsOk: false }],
    ["artifacts", { artifactsOk: false }],
  ] as const)("surfaces %s fetch failures", async (_source, result) => {
    mockFetch(result);
    renderView();
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
  });

  it("opens the matching source task through the context contract", async () => {
    mockFetch();
    const { openTaskDetail } = renderView();
    fireEvent.click(await screen.findByTestId("quality-verification-video-open-task"));
    expect(openTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-8357" }));
  });

  it("does not render the section without a selected project", () => {
    render(<QualityDashboardView context={{ tasks: [], openTaskDetail: vi.fn() }} />);
    expect(screen.getByTestId("quality-hub")).toBeTruthy();
    expect(screen.queryByTestId("quality-verification-videos")).toBeNull();
    expect(screen.queryByTestId("quality-verification-videos-disabled")).toBeNull();
  });

  it("constrains video cards and media at the canonical mobile breakpoint", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard-view.css"), "utf8");
    const mobileCss = css.slice(css.indexOf("@media (max-width: 768px), (max-height: 480px)"));
    expect(mobileCss).toMatch(/\.quality-verification-videos-card,[\s\S]*?max-width\s*:\s*100%\s*;/);
    expect(mobileCss).toMatch(/\.quality-verification-video-row__media[\s\S]*?max-width\s*:\s*100%\s*;/);
  });
});
