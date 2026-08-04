import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { createRegisterVoiceRoutes } from "../../../src/routes/register-voice-routes";
import type { ApiRoutesContext } from "../../../src/routes/types";
import { useComposerDictation } from "../useComposerDictation";
import { useVoiceDictation } from "../useVoiceDictation";

import { __resetVoiceAvailabilityCache } from "../useVoiceAvailability";

const nativeFetch = globalThis.fetch.bind(globalThis);

function Harness({ projectId }: { projectId?: string }) {
  const voice = useVoiceDictation(projectId);
  return <>
    <output data-testid="voice">{JSON.stringify({ enabled: voice.enabled, supported: voice.supported, partialText: voice.partialText, finalText: voice.finalText })}</output>
    <button onClick={() => void voice.start()}>start</button>
    <button onClick={() => void voice.stop()}>stop</button>
  </>;
}

function ControlledComposer({ projectId }: { projectId: string }) {
  const [value, setValue] = useState("before-after");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { micProps } = useComposerDictation({ textareaRef, value, onChange: setValue, projectId });
  return <>
    <textarea aria-label="Voice composer" ref={textareaRef} value={value} onChange={(event) => setValue(event.target.value)} />
    <button aria-label="Start voice dictation" onClick={() => void micProps.start()}>start</button>
    <button aria-label="Stop voice dictation" onClick={() => void micProps.stop()}>stop</button>
  </>;
}

function availableResponses() {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
    if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
    if (url === "/api/voice/transcribe") return new Response(JSON.stringify({ text: "final transcript", final: true }));
    if (url === "/api/voice/session/session-1" && init?.method === "DELETE") return new Response("{}");
    throw new Error(`Unexpected request ${url}`);
  });
}

function installAudioCapture() {
  const tracks = [{ stop: vi.fn() }];
  const port = { onmessage: undefined as ((event: MessageEvent<ArrayBuffer>) => void) | undefined };
  class Context {
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal("AudioWorkletNode", class { port = port; disconnect = vi.fn(); });
  Object.defineProperty(window, "AudioContext", { configurable: true, value: Context });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }) } });
  return { tracks, port };
}

describe("useVoiceDictation", () => {
  beforeEach(() => {
    __resetVoiceAvailabilityCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.useRealTimers());

  it("drives the selected-project composer through the real route and recognizer seams", async () => {
    const { port, tracks } = installAudioCapture();
    const app = express();
    const router = express.Router();
    const close = vi.fn();
    const acceptChunk = vi.fn((_audio: Buffer, options: { final: boolean }) => options.final
      ? { text: "final transcript" }
      : { partial: "partial transcript" });
    const requests: string[] = [];
    let clientSessionId: string | undefined;
    const clientSessionIds: string[] = [];
    app.use((req, res, next) => {
      requests.push(`${req.method} ${req.originalUrl}`);
      const json = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (req.method === "POST" && req.path === "/voice/session") {
          clientSessionId = (body as { sessionId?: string }).sessionId;
          if (clientSessionId) clientSessionIds.push(clientSessionId);
        }
        return json(body);
      }) as typeof res.json;
      next();
    });
    app.use("/api", router);
    createRegisterVoiceRoutes({
      manager: { getState: async () => ({ status: "installed" as const, installedPath: "/model" }), peekState: () => ({ status: "installed" as const, installedPath: "/model" }), scheduleDownload: () => ({ accepted: false as const, state: { status: "error" as const } }), remove: async () => {}, download: async () => ({ status: "installed" as const }), subscribe: () => () => {} },
      service: { getRuntimeStatus: async () => ({ status: "available" as const }), createSession: async () => ({ acceptChunk, finish: () => ({ text: "unused" }), close }) },
    })({ router, getScopedStore: async () => ({ getSettings: async () => ({ voiceInput: { enabled: true } }), getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }) }), getProjectIdFromRequest: (request) => typeof request.query.projectId === "string" ? request.query.projectId : undefined } as unknown as ApiRoutesContext);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.mocked(fetch).mockImplementation((input, init) => nativeFetch(`${origin}${String(input)}`, init));

    /*
     * FNXC:VoiceInput 2026-08-04-07:49:
     * The regression must cross the real controlled-composer, browser-capture, and Express
     * registrar seams. A response-only fetch mock cannot prove selected-project session ownership.
     */
    const view = render(<ControlledComposer projectId="voice-project" />);
    await waitFor(() => expect(requests).toContain("GET /api/voice/status?projectId=voice-project"));
    const textarea = screen.getByLabelText("Voice composer") as HTMLTextAreaElement;
    textarea.setSelectionRange("before".length, "before".length);
    fireEvent.click(screen.getByRole("button", { name: "Start voice dictation" }));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await waitFor(() => expect(requests).toContain("POST /api/voice/session?projectId=voice-project"));
    await waitFor(() => expect(clientSessionId).toBeDefined());
    const foreign = await nativeFetch(`${origin}/api/voice/transcribe?projectId=other-project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: clientSessionId, audio: "AAA=", sequence: 0, final: false }) });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "unknown-session" });

    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(textarea).toHaveValue("beforepartial transcript-after"));
    fireEvent.click(screen.getByRole("button", { name: "Stop voice dictation" }));
    await waitFor(() => expect(textarea).toHaveValue("beforefinal transcript-after"));
    await waitFor(() => expect(requests.filter((request) => request.startsWith("DELETE /api/voice/session/") && request.endsWith("?projectId=voice-project"))).toHaveLength(1));
    expect(requests).toEqual(expect.arrayContaining([
      "GET /api/voice/status?projectId=voice-project",
      "POST /api/voice/session?projectId=voice-project",
      "POST /api/voice/transcribe?projectId=voice-project",
    ]));
    expect(acceptChunk).toHaveBeenNthCalledWith(1, expect.any(Buffer), { final: false });
    expect(acceptChunk).toHaveBeenNthCalledWith(2, expect.any(Buffer), { final: true });
    expect(close).toHaveBeenCalledOnce();
    expect(tracks[0].stop).toHaveBeenCalledOnce();

    // Start a distinct real registrar session, then unmount while capture is active rather than
    // after stop has already finalized it. This proves unmount owns exactly one scoped cleanup.
    fireEvent.click(screen.getByRole("button", { name: "Start voice dictation" }));
    await waitFor(() => expect(clientSessionIds).toHaveLength(2));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    const activeSessionId = clientSessionIds[1];
    view.unmount();
    await waitFor(() => expect(requests.filter((request) => request === `DELETE /api/voice/session/${activeSessionId}?projectId=voice-project`)).toHaveLength(1));
    expect(close).toHaveBeenCalledTimes(2);
    expect(tracks[0].stop).toHaveBeenCalledTimes(2);
    expect(requests.filter((request) => request.startsWith("DELETE /api/voice/session/"))).toHaveLength(2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails closed while status is pending or fails", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(<Harness />);
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/voice/status"));
    expect(screen.getByTestId("voice").textContent).toContain('"enabled":false');
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("keeps capture unavailable while voice status is disabled", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enabled: false, runtime: { status: "available" }, model: { status: "installed" } })));
    render(<Harness />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/voice/status"));
    expect(screen.getByTestId("voice").textContent).toContain('"enabled":false');
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("fails closed when AudioWorkletNode is unavailable", async () => {
    installAudioCapture();
    vi.stubGlobal("AudioWorkletNode", undefined);
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"enabled":true'));
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("keeps every session request in the selected project's scope", async () => {
    const { port } = installAudioCapture();
    const projectId = "voice project/&";
    const scope = "?projectId=voice%20project%2F%26";
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/api/voice/status${scope}`) return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === `/api/voice/session${scope}`) return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
      if (url === `/api/voice/transcribe${scope}`) return new Response(JSON.stringify({ partial: "partial", final: false }));
      if (url === `/api/voice/session/session-1${scope}` && init?.method === "DELETE") return new Response("{}");
      throw new Error(`Unexpected request ${url}`);
    });
    const view = render(<Harness projectId={projectId} />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"partialText":"partial"'));
    view.unmount();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === `/api/voice/session/session-1${scope}` && init?.method === "DELETE")).toBe(true));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      `/api/voice/status${scope}`,
      `/api/voice/session${scope}`,
      `/api/voice/transcribe${scope}`,
      `/api/voice/session/session-1${scope}`,
    ]));
  });

  it("deletes the old scoped session when the selected project changes", async () => {
    const { port, tracks } = installAudioCapture();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/voice/status")) return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === "/api/voice/session?projectId=project-a") return new Response(JSON.stringify({ sessionId: "session-a" }), { status: 201 });
      if (url === "/api/voice/session/session-a?projectId=project-a" && init?.method === "DELETE") return new Response("{}");
      throw new Error(`Unexpected request ${url}`);
    });
    const view = render(<Harness projectId="project-a" />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    view.rerender(<Harness projectId="project-b" />);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/voice/session/session-a?projectId=project-a" && init?.method === "DELETE")).toBe(true));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(screen.getByTestId("voice").textContent).not.toContain('"partialText":"partial"');
  });

  it("serializes buffered worklet frames and sends a bounded finalization", async () => {
    const { tracks, port } = installAudioCapture();
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => {
      // A full 200ms batch starts one ordered request; the remaining frame flushes on stop.
      port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>);
      port.onmessage?.({ data: new ArrayBuffer(256) } as MessageEvent<ArrayBuffer>);
    });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe").length).toBe(1));
    fireEvent.click(screen.getByText("stop"));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe").length).toBe(2));
    const requests = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe");
    expect(JSON.parse(String(requests.at(-1)?.[1]?.body))).toMatchObject({ final: true, sequence: 1 });
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"finalText":"final transcript"'));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });

  it("releases microphone tracks immediately when an in-flight transcription never settles", async () => {
    const { tracks, port } = installAudioCapture();
      vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
      if (url === "/api/voice/transcribe" && !JSON.parse(String(init?.body)).final) return await new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ text: "", final: true }));
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/voice/transcribe")).toBe(true));
    fireEvent.click(screen.getByText("stop"));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    // A request already in flight may have reached the server, so stop releases the track but
    // waits for that original sequence instead of replaying PCM as a second request.
    await act(async () => undefined);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe")).toHaveLength(1);
  });

  it("bounds a stalled pre-stop flush, aborts its request, and deletes only that session", async () => {
    const { port } = installAudioCapture();
    let stalledSignal: AbortSignal | undefined;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
      if (url === "/api/voice/transcribe") {
        stalledSignal = init?.signal as AbortSignal;
        return await new Promise<Response>(() => undefined);
      }
      if (url === "/api/voice/session/session-1" && init?.method === "DELETE") return new Response("{}");
      throw new Error(`Unexpected request ${url}`);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(stalledSignal).toBeDefined());
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("stop"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(stalledSignal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/voice/session/session-1" && init?.method === "DELETE")).toBe(true);
  });

  it("prevents a rapid double-start from creating multiple captures", async () => {
    const { port } = installAudioCapture();
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/session").length).toBe(1);
  });
});
