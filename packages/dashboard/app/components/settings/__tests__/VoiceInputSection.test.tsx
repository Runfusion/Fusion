import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { VoiceInputSection, VOICE_STATUS_POLL_INTERVAL_MS } from "../sections/VoiceInputSection";
import type { SettingsFormState } from "../sections/context";
import { settingsSearchEntriesForSection } from "../search/entries";
import { rankSettingsSearchResults } from "../search/match";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const available = (status: string, extras: Record<string, unknown> = {}) => ({ model: { status, ...extras }, runtime: { status: "available" } });

function renderSection(status: unknown, formOverrides: Partial<Settings> = {}) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(status)));
  vi.stubGlobal("fetch", fetchMock);
  let form = { ...formOverrides } as SettingsFormState;
  const setForm = vi.fn((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => { form = typeof updater === "function" ? updater(form) : updater; });
  const view = render(<VoiceInputSection form={form} setForm={setForm} />);
  return { ...view, fetchMock, setForm, getForm: () => form };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("VoiceInputSection", () => {
  it("persists the opt-in toggle through the project Settings form without clobbering model fields", async () => {
    const { setForm, getForm } = renderSection(available("installed"), { voiceInput: { model: "parakeet-v3", language: "en" } });
    const toggle = await screen.findByLabelText("Enable voice input");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(setForm).toHaveBeenCalledOnce();
    expect(getForm().voiceInput).toEqual({ model: "parakeet-v3", language: "en", enabled: true });
  });

  it("keeps the toggle disabled until the locally managed model is installed", async () => {
    renderSection(available("not-installed"));
    const toggle = await screen.findByLabelText("Enable voice input");
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("voice-input-runtime-unavailable")).toHaveTextContent("Download the Parakeet model");
  });

  it.each([
    ["not-installed", "Download", undefined],
    ["installed", "Remove", undefined],
    ["error", "Download", "network"],
  ])("renders %s model affordances", async (modelStatus, action, errorReason) => {
    renderSection(available(modelStatus, errorReason ? { errorReason } : {}));
    await screen.findByTestId("voice-input-model-status");
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: action === "Download" ? "Remove" : "Download" })).not.toBeInTheDocument();
  });

  it("renders downloading progress without action shells", async () => {
    renderSection(available("downloading", { progress: 0.6 }));
    expect(await screen.findByText("Downloading: 60%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download|Remove/ })).not.toBeInTheDocument();
  });

  it.each(["runtime-incompatible", "runtime-platform-load-failed", "runtime-module-missing"])('renders a re-check action for an installed %s runtime', async (unavailableReason) => {
    renderSection({ model: { status: "installed" }, runtime: { status: "unavailable", unavailableReason } });
    expect(await screen.findByRole("button", { name: "Re-check runtime" })).toBeInTheDocument();
  });

  it("hides runtime re-check when the model, status, or runtime is not actionable", async () => {
    const cases = [
      available("installed"),
      { model: { status: "not-installed" }, runtime: { status: "unavailable", unavailableReason: "model-not-installed" } },
      {},
    ];
    for (const status of cases) {
      const view = renderSection(status);
      await screen.findByLabelText("Enable voice input");
      expect(screen.queryByRole("button", { name: /Re-check runtime/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("re-checks the runtime and refreshes Settings status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ model: { status: "installed" }, runtime: { status: "unavailable", unavailableReason: "runtime-incompatible" } }))
      .mockResolvedValueOnce(response({ model: { status: "installed" }, runtime: { status: "available" } }))
      .mockResolvedValueOnce(response(available("installed")));
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceInputSection form={{} as SettingsFormState} setForm={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Re-check runtime" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/voice/runtime/recheck", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByLabelText("Enable voice input")).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores the re-check action after a rejected request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ model: { status: "installed" }, runtime: { status: "unavailable", unavailableReason: "runtime-module-missing" } }))
      .mockRejectedValueOnce(new Error("recheck failed"))
      .mockResolvedValueOnce(response({ model: { status: "installed" }, runtime: { status: "unavailable", unavailableReason: "runtime-module-missing" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceInputSection form={{} as SettingsFormState} setForm={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Re-check runtime" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-check runtime" })).toBeEnabled());
    expect(screen.getByTestId("voice-input-runtime-unavailable")).toBeInTheDocument();
  });

  it("fails closed for unavailable runtime without rewriting a persisted preference", async () => {
    const { setForm } = renderSection({ model: { status: "installed" }, runtime: { status: "unavailable", unavailableReason: "runtime-module-missing" } }, { voiceInput: { enabled: true } });
    const toggle = await screen.findByLabelText("Enable voice input");
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle.closest("div[data-effective-enabled]")).toHaveAttribute("data-effective-enabled", "false");
    expect(screen.getByTestId("voice-input-runtime-unavailable")).toHaveTextContent("includes the optional voice runtime");
    expect(setForm).not.toHaveBeenCalled();
  });

  it("removes the unavailable alert when model management refreshes to an installed compatible runtime", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ model: { status: "not-installed" }, runtime: { status: "unavailable", unavailableReason: "runtime-module-missing" } }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(available("installed")));
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceInputSection form={{} as SettingsFormState} setForm={vi.fn()} />);

    await screen.findByTestId("voice-input-runtime-unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(screen.getByLabelText("Enable voice input")).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([undefined, { nonsense: true }])("fails closed when status cannot be parsed", async (body) => {
    const { setForm } = renderSection(body);
    const toggle = await screen.findByLabelText("Enable voice input");
    expect(toggle).toBeDisabled();
    expect(toggle.closest("div[data-effective-enabled]")).toHaveAttribute("data-effective-enabled", "false");
    expect(setForm).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-input-status-unavailable")).toHaveTextContent("status could not be determined");
    expect(screen.queryByRole("button", { name: /Download|Remove/ })).not.toBeInTheDocument();
  });

  it("fails closed when the status request rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const setForm = vi.fn();
    render(<VoiceInputSection form={{ voiceInput: { enabled: true } } as SettingsFormState} setForm={setForm} />);
    const toggle = await screen.findByLabelText("Enable voice input");
    expect(toggle).toBeDisabled();
    expect(toggle.closest("div[data-effective-enabled]")).toHaveAttribute("data-effective-enabled", "false");
    expect(setForm).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-input-status-unavailable")).toHaveTextContent("status could not be determined");
    expect(screen.queryByRole("button", { name: /Download|Remove/ })).not.toBeInTheDocument();
  });

  it("renders an indeterminate download without action shells", async () => {
    renderSection(available("downloading"));
    expect(await screen.findByText("Downloading model…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download|Remove/ })).not.toBeInTheDocument();
  });

  it("polls active downloads and stops after the installed transition", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(available("downloading", { progress: 0.1 })))
      .mockResolvedValueOnce(response(available("downloading", { progress: 0.6 })))
      .mockResolvedValueOnce(response(available("installed")));
    vi.stubGlobal("fetch", fetchMock);
    render(<VoiceInputSection form={{} as SettingsFormState} setForm={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Downloading: 10%")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_INTERVAL_MS); });
    expect(screen.getByText("Downloading: 60%")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_INTERVAL_MS); });
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_INTERVAL_MS * 2); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps voice and model terms reachable through the settings search index", () => {
    for (const query of ["voice", "dictation", "microphone", "parakeet", "speech to text"]) {
      expect(rankSettingsSearchResults(settingsSearchEntriesForSection("voice-input"), query, (_key, fallback) => fallback).some((entry) => entry.sectionId === "voice-input")).toBe(true);
    }
  });

  it("calls model management endpoints from SettingsFieldRow control slots", async () => {
    const { fetchMock, unmount } = renderSection(available("not-installed"));
    await screen.findByRole("button", { name: "Download" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/voice/model/download", expect.objectContaining({ method: "POST" })));
    expect(screen.getByTestId("voice-input-model-actions").closest(".settings-field-row")).not.toBeNull();
    unmount();

    const installed = renderSection(available("installed"));
    await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(installed.fetchMock).toHaveBeenCalledWith("/api/voice/model", expect.objectContaining({ method: "DELETE" })));
  });

  it("cleans up download polling after unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response(available("downloading", { progress: 0.1 })));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<VoiceInputSection form={{} as SettingsFormState} setForm={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_INTERVAL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
