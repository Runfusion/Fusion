/**
 * Per-model HTTP idle/first-byte timeout for custom providers (`timeoutSeconds`).
 *
 * Two layers, two seams:
 *
 * Layer 1 — OpenAI SDK per-request first-byte timer (per session):
 *   - `buildCustomProviderModels` converts persisted `timeoutSeconds` to pi `Model.timeoutMs`:
 *     omitted/invalid -> field absent; N seconds -> N*1000 ms; 0 -> 2147483647 ("disabled",
 *     because the OpenAI SDK aborts immediately on a literal 0 timeout).
 *   - `buildSessionRetrySettings` turns the resolved model's `timeoutMs` into the per-session
 *     pi SettingsManager `retry.provider.timeoutMs`; pi's streamFn resolves the SDK timeout as
 *     `options?.timeoutMs ?? settingsManager.getProviderRetrySettings().timeoutMs ??
 *     getHttpIdleTimeoutMs()` (300s default). The SDK timer is cleared when response headers
 *     arrive, so this bounds first-byte silence, not total generation time.
 *
 * Layer 2 — undici body/headers idle timeouts (process-global, per origin):
 *   - `buildHttpIdleTimeoutMap` collapses per-model timeouts per origin (most permissive wins,
 *     disabled/0 beats positive, invalid baseUrls ignored).
 *   - `applyHttpIdleTimeouts` installs the global undici dispatcher carrying those per-origin
 *     `bodyTimeout`/`headersTimeout` values; unlisted origins keep the 300s default.
 *   - The dispatcher is re-installed on startup and after every custom-provider settings save.
 *
 * Semantics (operator requirement): local slow/buffered models must not be stopped by the
 * classic "Request timed out." (openai APIConnectionTimeoutError) at the 5-minute mark.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as undici from "undici";
import type { CustomProvider } from "@fusion/core";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildCustomProviderModels } from "../auth/custom-provider-registry.js";
import {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  applyHttpIdleTimeouts,
  buildHttpIdleDispatcher,
  buildHttpIdleTimeoutMap,
} from "../auth/http-idle-timeouts.js";
import { buildSessionRetrySettings } from "../pi.js";

function makeProvider(models: NonNullable<CustomProvider["models"]>, baseUrl = "https://slow-model.local:8080/v1"): CustomProvider {
  return {
    id: "timeout-test",
    name: "Timeout Test",
    apiType: "openai-compatible",
    baseUrl,
    models,
  };
}

describe("buildCustomProviderModels per-model timeoutSeconds -> timeoutMs", () => {
  it("omits timeoutMs when timeoutSeconds is absent, invalid, negative, or NaN", () => {
    const models = buildCustomProviderModels(
      makeProvider([
        { id: "no-timeout" },
        { id: "negative", timeoutSeconds: -1 },
        { id: "nan", timeoutSeconds: Number.NaN },
      ]),
      "openai-completions",
    );
    for (const model of models) {
      expect("timeoutMs" in model).toBe(false);
    }
  });

  it("converts positive seconds to milliseconds", () => {
    const models = buildCustomProviderModels(
      makeProvider([{ id: "five-min", timeoutSeconds: 300 }, { id: "hour", timeoutSeconds: 3600 }]),
      "openai-completions",
    );
    expect(models[0].timeoutMs).toBe(300_000);
    expect(models[1].timeoutMs).toBe(3_600_000);
  });

  it("converts 0 (disabled) to 2147483647 because the SDK aborts immediately on literal 0", () => {
    const models = buildCustomProviderModels(makeProvider([{ id: "never-timeout", timeoutSeconds: 0 }]), "openai-completions");
    expect(models[0].timeoutMs).toBe(2_147_483_647);
  });

  it("keeps the existing per-model windows alongside the new timeout field", () => {
    const models = buildCustomProviderModels(
      makeProvider([{ id: "windows", contextWindow: 32768, maxTokens: 4096, timeoutSeconds: 1200 }]),
      "openai-completions",
    );
    expect(models[0].contextWindow).toBe(32768);
    expect(models[0].maxTokens).toBe(4096);
    expect(models[0].timeoutMs).toBe(1_200_000);
  });
});

describe("buildSessionRetrySettings (Layer 1 per-session SettingsManager seam)", () => {
  it("keeps the previous settings shape exactly for models without a timeout", () => {
    expect(buildSessionRetrySettings(undefined)).toEqual({ enabled: true, maxRetries: 3 });
  });

  it("injects retry.provider.timeoutMs from the model's timeoutMs", () => {
    expect(buildSessionRetrySettings(3_600_000)).toEqual({
      enabled: true,
      maxRetries: 3,
      provider: { timeoutMs: 3_600_000 },
    });
  });

  it("pi contract: getProviderRetrySettings() surfaces the injected provider timeoutMs", () => {
    // Pins the upstream pi seam the engine relies on: streamFn resolves the OpenAI SDK
    // per-request timeout from getProviderRetrySettings().timeoutMs before the 300s default.
    const settingsManager = SettingsManager.inMemory({ retry: buildSessionRetrySettings(3_600_000) });
    expect(settingsManager.getProviderRetrySettings().timeoutMs).toBe(3_600_000);
  });

  it("a disabled (0s) model reaches the SDK as 2147483647, never literal 0", () => {
    const disabledModel = buildCustomProviderModels(makeProvider([{ id: "off", timeoutSeconds: 0 }]), "openai-completions");
    const settingsManager = SettingsManager.inMemory({ retry: buildSessionRetrySettings(disabledModel[0].timeoutMs) });
    expect(settingsManager.getProviderRetrySettings().timeoutMs).toBe(2_147_483_647);
    expect(settingsManager.getProviderRetrySettings().timeoutMs).not.toBe(0);
  });
});

describe("buildHttpIdleTimeoutMap (Layer 2 per-origin collapse)", () => {
  it("returns an empty map for no providers or unusable entries", () => {
    expect(buildHttpIdleTimeoutMap(undefined).size).toBe(0);
    expect(buildHttpIdleTimeoutMap([]).size).toBe(0);
    expect(buildHttpIdleTimeoutMap([{ id: "bad", baseUrl: "not-a-url", models: [{ id: "m", timeoutSeconds: 300 }] }] as never).size).toBe(0);
    expect(
      buildHttpIdleTimeoutMap([{ id: "ws", baseUrl: "ws://example.com", models: [{ id: "m", timeoutSeconds: 300 }] }] as never).size,
    ).toBe(0);
  });

  it("maps each http(s) origin to the positive timeout in milliseconds", () => {
    const map = buildHttpIdleTimeoutMap([
      { id: "a", baseUrl: "http://localhost:11434", models: [{ id: "m", timeoutSeconds: 900 }] },
    ]);
    expect(map.get("http://localhost:11434")).toBe(900_000);
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it("on a shared origin the most permissive positive value wins", () => {
    const map = buildHttpIdleTimeoutMap([
      { id: "a", baseUrl: "http://localhost:11434/v1", models: [{ id: "m", timeoutSeconds: 900 }] },
      { id: "b", baseUrl: "http://localhost:11434", models: [{ id: "m", timeoutSeconds: 600 }] },
    ]);
    // Same origin (host:port) despite the /v1 path difference.
    expect(map.size).toBe(1);
    expect(map.get("http://localhost:11434")).toBe(900_000);
  });

  it("0 (disabled) wins over positive values on the same origin", () => {
    const map = buildHttpIdleTimeoutMap([
      { id: "a", baseUrl: "http://localhost:11434", models: [{ id: "m", timeoutSeconds: 900 }] },
      { id: "b", baseUrl: "http://localhost:11434", models: [{ id: "m", timeoutSeconds: 0 }] },
    ]);
    expect(map.get("http://localhost:11434")).toBe(0);
  });

  it("ignores invalid (negative, non-finite, non-numeric) timeoutSeconds", () => {
    const map = buildHttpIdleTimeoutMap([
      { id: "a", baseUrl: "https://example.com/v1", models: [{ id: "m", timeoutSeconds: -5 }] },
      { id: "b", baseUrl: "https://example.com/v1", models: [{ id: "m", timeoutSeconds: Number.NaN }] },
      { id: "c", baseUrl: "https://example.com/v1", models: [{ id: "m", timeoutSeconds: "long" as never }] },
    ]);
    expect(map.size).toBe(0);
  });
});

describe("applyHttpIdleTimeouts (dispatcher install)", () => {
  it("replaces the global undici dispatcher and restores cleanly", () => {
    const prior = undici.getGlobalDispatcher();
    try {
      applyHttpIdleTimeouts(new Map([["http://localhost:11434", 900_000]]));
      const installed = undici.getGlobalDispatcher();
      expect(installed).not.toBe(prior);
      // EnvHttpProxyAgent is a DispatcherBase wrapping an inner undici.Agent for direct
      // connections (verified in undici 8.9.0 source) — not a subclass of undici.Agent.
      expect(installed).toBeInstanceOf(undici.EnvHttpProxyAgent);
    } finally {
      undici.setGlobalDispatcher(prior);
    }
  });
});

/**
 * Integration: the per-origin dispatcher genuinely changes undici's idle behavior.
 * Uses a real local HTTP server and an EXPLICIT { dispatcher } (no global mutation):
 *   1. delayed headers succeed when the origin's headersTimeout is generous,
 *   2. the same delay fails with UND_ERR_HEADERS_TIMEOUT under a tight headersTimeout,
 *   3. a header-only response followed by silence fails with UND_ERR_BODY_TIMEOUT.
 */
/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-16:20:
 * undici's headers/body idle timeouts run on its "fast timer" (lib/util/timers.js), which is
 * quantized to TICK_MS=499ms / RESOLUTION_MS=1000ms ticks — a sub-~1s delay still fires only
 * after ~2 ticks (≈1000ms). Verified empirically on undici 8.9.0: a raw Client with
 * `headersTimeout: 150` against a silent server rejects at ≈1003ms, and the fetch-visible error
 * is a `TypeError` ("fetch failed" / "terminated") whose REAL code lives on `err.cause` (an
 * `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` UndiciError), NOT on `err.code`. So these
 * integration tests assert on `err.cause.code` and configure the "tight" timeout well below the
 * server's silence so the quantized timer still wins; they never assert exact timing (the 6000ms
 * vitest timeout is only a hang guard).
 */
describe("per-origin dispatcher idle behavior (integration)", () => {
  type Listener = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

  function listen(handler: Listener): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }

  /** Real undici error code carried by a fetch failure: the cause's `code`, else the top-level `code`. */
  function undiciErrorCode(err: unknown): string | undefined {
    const e = err as { code?: string; cause?: { code?: string } } | undefined;
    return e?.cause?.code ?? e?.code;
  }

  it("succeeds when headers arrive inside the permissive origin headersTimeout", async () => {
    const delayed = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }, 200);
    });
    try {
      // Generous per-origin window: headers arrive at 200ms, well inside 5000ms.
      const response = await undici.fetch(`${delayed.url}/`, {
        dispatcher: buildHttpIdleTimeoutsForTest(delayed.url, 5000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await delayed.close();
    }
  }, 6000);

  it("fails with UND_ERR_HEADERS_TIMEOUT when a tight origin headersTimeout fires before headers", async () => {
    // Server never sends headers. Configured 500ms -> quantized to ~1000ms by the fast timer,
    // which still fires long before the (nonexistent) headers, so the request is aborted.
    const silent = await listen((_req, _res) => {
      // Never respond: the headers idle timer must fire.
    });
    try {
      let caught: unknown;
      try {
        await undici.fetch(`${silent.url}/`, { dispatcher: buildHttpIdleTimeoutsForTest(silent.url, 500) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(undiciErrorCode(caught)).toBe("UND_ERR_HEADERS_TIMEOUT");
    } finally {
      await silent.close();
    }
  }, 6000);

  it("fails with UND_ERR_BODY_TIMEOUT when the body goes silent after headers", async () => {
    // Headers + a partial body arrive immediately, then the body goes silent (never ends).
    // The body idle timer (set when the body starts) fires and aborts the stream.
    const silentBody = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      // Deliberately never res.end(): the idle body timer must fire.
    });
    try {
      const response = await undici.fetch(`${silentBody.url}/`, {
        dispatcher: buildHttpIdleTimeoutsForTest(silentBody.url, 500),
      });
      let caught: unknown;
      try {
        await response.text();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(undiciErrorCode(caught)).toBe("UND_ERR_BODY_TIMEOUT");
    } finally {
      await silentBody.close();
    }
  }, 6000);
});

/** Builds the dispatcher for the test server's origin with a per-origin timeout. */
function buildHttpIdleTimeoutsForTest(origin: string, timeoutMs: number): ReturnType<typeof buildHttpIdleDispatcher> {
  return buildHttpIdleDispatcher(new Map([[origin, timeoutMs]]));
}
