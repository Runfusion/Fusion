import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineStatusBanner } from "../EngineStatusBanner";
import * as api from "../../api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) => {
      let text = fallback ?? _key;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.replace(`{{${key}}}`, value);
        }
      }
      return text;
    },
  }),
}));

vi.mock("../../api", () => ({
  fetchEngineStatus: vi.fn(),
  startEngine: vi.fn(),
}));

const mockFetchEngineStatus = vi.mocked(api.fetchEngineStatus);
const mockStartEngine = vi.mocked(api.startEngine);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EngineStatusBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchEngineStatus.mockReset();
    mockStartEngine.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders no banner, button, or aria-live shell when the engine is connected", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: true, starting: false, canStart: true, projectId: "project-a" });

    const { queryByTestId, container } = render(<EngineStatusBanner projectId="project-a" />);
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId("engine-status-banner")).toBeNull();
    expect(queryByTestId("engine-status-start-button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("shows an enabled Start engine button when disconnected and startable", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    const button = screen.getByTestId("engine-status-start-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Start engine");
    expect(screen.getByText("Project engine is not connected")).toBeInTheDocument();
  });

  it("clicking Start engine calls startEngine and refetches status", async () => {
    mockFetchEngineStatus
      .mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" })
      .mockResolvedValueOnce({ connected: true, starting: false, canStart: true, projectId: "project-a" });
    mockStartEngine.mockResolvedValueOnce({ connected: false, starting: true, canStart: true, projectId: "project-a" });

    const { queryByTestId, container } = render(<EngineStatusBanner projectId="project-a" />);
    const button = await screen.findByTestId("engine-status-start-button");

    await act(async () => {
      fireEvent.click(button);
      await flushPromises();
    });

    expect(mockStartEngine).toHaveBeenCalledWith("project-a");
    expect(mockFetchEngineStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(queryByTestId("engine-status-banner")).toBeNull());
    expect(queryByTestId("engine-status-start-button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("disables the Start engine button while the engine is starting", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: true, canStart: true, projectId: "project-a" });

    render(<EngineStatusBanner projectId="project-a" />);

    const button = await screen.findByTestId("engine-status-start-button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Starting…");
  });

  it("shows dashboard-only guidance with no start button when the server cannot start engines", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: false, reason: "dashboard-only", projectId: "project-a" });

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-status-start-button")).toBeNull();
    expect(screen.getByText("fn serve")).toBeInTheDocument();
  });

  it("treats unreachable status probes as disconnected guidance without an enabled action", async () => {
    mockFetchEngineStatus.mockRejectedValueOnce(new Error("offline"));

    render(<EngineStatusBanner projectId="project-a" />);

    expect(await screen.findByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-status-start-button")).toBeNull();
    expect(screen.getByText("fn serve")).toBeInTheDocument();
  });

  it("renders retryable start errors inline", async () => {
    mockFetchEngineStatus.mockResolvedValueOnce({ connected: false, starting: false, canStart: true, projectId: "project-a" });
    mockStartEngine.mockRejectedValueOnce(new Error("engine failed"));

    render(<EngineStatusBanner projectId="project-a" />);
    const button = await screen.findByTestId("engine-status-start-button");

    await act(async () => {
      fireEvent.click(button);
      await flushPromises();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Start failed: engine failed");
    expect(screen.getByTestId("engine-status-start-button")).toBeEnabled();
  });

  it("ships responsive mobile scaffolding for the banner stack", () => {
    const css = readFileSync(resolve(__dirname, "..", "EngineStatusBanner.css"), "utf8");

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".engine-status-banner__start");
    expect(css).toContain("width: 100%");
  });
});
