import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  withRetryResult,
  computeBackoff,
  cancellableSleep,
  type JitterStrategy,
  type RetryOptions,
} from "../errors/retry-with-backoff.js";
import {
  EngineError,
  TransientError,
  NetworkError,
  ServiceUnavailableError,
  TimeoutError,
  PermanentError,
  ConfigurationError,
  ValidationError,
  RateLimitError,
  classifyThrownError,
  isRetryableError,
} from "../errors/engine-errors.js";

// ── engine-errors.ts tests ──────────────────────────────────────────────

describe("engine-errors", () => {
  describe("error hierarchy", () => {
    it("TransientError is retryable EngineError", () => {
      const err = new TransientError("blip");
      expect(err).toBeInstanceOf(EngineError);
      expect(err).toBeInstanceOf(TransientError);
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("TRANSIENT");
      expect(err.message).toBe("blip");
    });

    it("NetworkError is a TransientError", () => {
      const err = new NetworkError("ECONNREFUSED");
      expect(err).toBeInstanceOf(TransientError);
      expect(err).toBeInstanceOf(NetworkError);
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("NETWORK");
    });

    it("ServiceUnavailableError carries statusCode", () => {
      const err = new ServiceUnavailableError("overloaded", 503);
      expect(err).toBeInstanceOf(TransientError);
      expect(err.statusCode).toBe(503);
      expect(err.details?.statusCode).toBe(503);
    });

    it("TimeoutError carries timeoutMs", () => {
      const err = new TimeoutError("timed out", 5000);
      expect(err).toBeInstanceOf(TransientError);
      expect(err.timeoutMs).toBe(5000);
    });

    it("PermanentError is non-retryable", () => {
      const err = new PermanentError("bad code");
      expect(err).toBeInstanceOf(EngineError);
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("PERMANENT");
    });

    it("ConfigurationError is a PermanentError", () => {
      const err = new ConfigurationError("missing API key");
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.code).toBe("CONFIGURATION");
    });

    it("ValidationError is a PermanentError", () => {
      const err = new ValidationError("invalid input");
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.code).toBe("VALIDATION");
    });

    it("RateLimitError is non-retryable EngineError", () => {
      const err = new RateLimitError("429", 5000);
      expect(err).toBeInstanceOf(EngineError);
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.retryAfterMs).toBe(5000);
    });

    it("error cause chain is preserved", () => {
      const cause = new Error("root cause");
      const err = new NetworkError("wrapped", undefined, cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("classifyThrownError", () => {
    it("passes through existing EngineError instances", () => {
      const original = new NetworkError("existing");
      expect(classifyThrownError(original)).toBe(original);
    });

    it("classifies rate-limit errors", () => {
      const err = classifyThrownError(new Error("rate limit exceeded"));
      expect(err).toBeInstanceOf(RateLimitError);
    });

    it("classifies network errors", () => {
      const err = classifyThrownError(new Error("ECONNREFUSED 127.0.0.1:443"));
      expect(err).toBeInstanceOf(NetworkError);
    });

    it("classifies timeout errors", () => {
      const err = classifyThrownError(new Error("ETIMEDOUT connection timed out"));
      expect(err).toBeInstanceOf(TimeoutError);
    });

    it("classifies upstream service errors", () => {
      const err = classifyThrownError(new Error("upstream connect error"));
      expect(err).toBeInstanceOf(ServiceUnavailableError);
    });

    it("classifies server_error JSON payloads", () => {
      const err = classifyThrownError(new Error('{"type":"server_error","code":"server_error"}'));
      expect(err).toBeInstanceOf(ServiceUnavailableError);
    });

    it("classifies WebSocket errors as transient", () => {
      const err = classifyThrownError(new Error("WebSocket error"));
      expect(err).toBeInstanceOf(TransientError);
      expect(err.retryable).toBe(true);
    });

    it("classifies unknown errors as permanent", () => {
      const err = classifyThrownError(new Error("something unexpected"));
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.code).toBe("UNKNOWN");
    });

    it("handles string thrown values", () => {
      const err = classifyThrownError("plain string error");
      expect(err).toBeInstanceOf(PermanentError);
    });

    it("handles null/undefined thrown values", () => {
      const err = classifyThrownError(null);
      expect(err).toBeInstanceOf(PermanentError);
    });
  });

  describe("isRetryableError", () => {
    it("returns true for TransientError subclasses", () => {
      expect(isRetryableError(new NetworkError("net"))).toBe(true);
      expect(isRetryableError(new ServiceUnavailableError("svc"))).toBe(true);
      expect(isRetryableError(new TimeoutError("tmr"))).toBe(true);
      expect(isRetryableError(new TransientError("gen"))).toBe(true);
    });

    it("returns false for PermanentError", () => {
      expect(isRetryableError(new PermanentError("perm"))).toBe(false);
    });

    it("returns false for RateLimitError", () => {
      expect(isRetryableError(new RateLimitError("rl"))).toBe(false);
    });

    it("falls back to string detection for untyped errors", () => {
      expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
      expect(isRetryableError(new Error("socket hang up"))).toBe(true);
      expect(isRetryableError(new Error("bad code"))).toBe(false);
    });
  });
});

// ── retry-with-backoff.ts tests ─────────────────────────────────────────

describe("computeBackoff", () => {
  it("returns raw delay with jitter=none", () => {
    expect(computeBackoff(0, 1000, 30000, "none")).toBe(1000);
    expect(computeBackoff(1, 1000, 30000, "none")).toBe(2000);
    expect(computeBackoff(2, 1000, 30000, "none")).toBe(4000);
    expect(computeBackoff(3, 1000, 30000, "none")).toBe(8000);
  });

  it("caps delay at maxDelayMs", () => {
    expect(computeBackoff(10, 1000, 5000, "none")).toBe(5000);
  });

  it("full jitter returns value in [0, rawDelay]", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeBackoff(0, 1000, 30000, "full");
    expect(delay).toBe(500); // floor(0.5 * 1000)
    vi.restoreAllMocks();
  });

  it("equal jitter returns value in [rawDelay/2, rawDelay]", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeBackoff(0, 1000, 30000, "equal");
    expect(delay).toBe(750); // floor(500 + 0.5 * 500)
    vi.restoreAllMocks();
  });

  it("exponential growth is correct with no jitter", () => {
    const delays = [0, 1, 2, 3, 4].map((a) => computeBackoff(a, 500, 100000, "none"));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});

describe("cancellableSleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the specified delay", async () => {
    const promise = cancellableSleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects immediately if signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("Already done"));
    await expect(cancellableSleep(1000, ac.signal)).rejects.toThrow("Already done");
  });

  it("rejects when signal fires during sleep", async () => {
    const ac = new AbortController();
    const promise = cancellableSleep(10000, ac.signal);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort(new Error("Cancelled"));
    await expect(promise).rejects.toThrow("Cancelled");
  });
});

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the result when fn succeeds on first call", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on TransientError and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("ECONNREFUSED"))
      .mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withRetry(fn, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, 100, expect.any(NetworkError));
  });

  it("retries on raw transient error strings (untyped)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-retryable errors immediately without retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ENOENT: file not found"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, { baseDelayMs: 100, onRetry }),
    ).rejects.toThrow("ENOENT: file not found");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("re-throws PermanentError immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new PermanentError("bad config"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, { baseDelayMs: 100, onRetry }),
    ).rejects.toThrow("bad config");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("never retries rate-limit errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("rate limit exceeded"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, { baseDelayMs: 100, onRetry }),
    ).rejects.toThrow("rate limit exceeded");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("never retries RateLimitError instances", async () => {
    const fn = vi.fn().mockRejectedValue(new RateLimitError("429"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, { baseDelayMs: 100, onRetry }),
    ).rejects.toThrow("429");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not let a custom retry check override RateLimitError instances", async () => {
    const fn = vi.fn().mockRejectedValue(new RateLimitError("429"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, {
        baseDelayMs: 100,
        onRetry,
        isRetryable: () => true,
      }),
    ).rejects.toThrow("429");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("applies exponential backoff with increasing delays", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("net-1"))
      .mockRejectedValueOnce(new NetworkError("net-2"))
      .mockResolvedValueOnce("ok");

    const delays: number[] = [];
    const onRetry = (_attempt: number, delayMs: number) => delays.push(delayMs);

    const promise = withRetry(fn, {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      jitter: "none",
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1100);  // 1st delay: 1000ms
    await vi.advanceTimersByTimeAsync(2100);  // 2nd delay: 2000ms
    await promise;

    expect(delays).toEqual([1000, 2000]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps delay at maxDelayMs", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TimeoutError("slow"))
      .mockResolvedValueOnce("ok");

    const delays: number[] = [];
    const promise = withRetry(fn, {
      baseDelayMs: 100000,
      maxDelayMs: 5000,
      jitter: "none",
      onRetry: (_a, d) => delays.push(d),
    });

    await vi.advanceTimersByTimeAsync(6000);
    await promise;

    expect(delays[0]).toBe(5000);
  });

  it("throws after all retries are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("always fails"));
    const onRetry = vi.fn();

    const promise = withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
      onRetry,
    });

    const assertion = expect(promise).rejects.toThrow("always fails");

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("cancels backoff sleep when abort signal fires", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("net"));
    const ac = new AbortController();

    const promise = withRetry(fn, {
      baseDelayMs: 60000,
      maxDelayMs: 120000,
      jitter: "none",
      signal: ac.signal,
    });

    // Let first call fail and start sleeping
    await vi.advanceTimersByTimeAsync(10);
    ac.abort(new Error("Task paused"));

    await expect(promise).rejects.toThrow("Task paused");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry if abort signal is already aborted at start", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("net"));
    const ac = new AbortController();
    ac.abort(new Error("Already cancelled"));

    await expect(
      withRetry(fn, { signal: ac.signal }),
    ).rejects.toThrow("Aborted before first attempt");

    expect(fn).toHaveBeenCalledTimes(0); // never called — aborted before first attempt
  });

  it("supports custom isRetryable check", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("custom-retryable"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
      isRetryable: (err) => err instanceof Error && err.message === "custom-retryable",
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("custom isRetryable returning false prevents retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("custom-retryable"));
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, {
        baseDelayMs: 100,
        onRetry,
        isRetryable: () => false,
      }),
    ).rejects.toThrow("custom-retryable");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("handles simulated 5xx errors correctly", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ServiceUnavailableError("502 Bad Gateway", 502))
      .mockRejectedValueOnce(new ServiceUnavailableError("503 Service Unavailable", 503))
      .mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitter: "none",
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(200);   // 1st delay: 100ms
    await vi.advanceTimersByTimeAsync(400);   // 2nd delay: 200ms
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);

    // Verify the errors carry status codes
    const retryCalls = onRetry.mock.calls;
    expect((retryCalls[0][2] as ServiceUnavailableError).statusCode).toBe(502);
    expect((retryCalls[1][2] as ServiceUnavailableError).statusCode).toBe(503);
  });

  it("handles simulated timeout errors correctly", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TimeoutError("request timed out", 5000))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("non-retryable errors fail fast without blocking", async () => {
    const fn = vi.fn().mockRejectedValue(new ValidationError("invalid schema"));
    const onRetry = vi.fn();

    const start = Date.now();
    await expect(
      withRetry(fn, { baseDelayMs: 10000, onRetry }),
    ).rejects.toThrow("invalid schema");

    // Should resolve immediately — no sleep for non-retryable errors
    // (fake timers don't advance real Date.now, but fn call count proves it)
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("handles non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    const onRetry = vi.fn();

    await expect(
      withRetry(fn, { baseDelayMs: 100, onRetry }),
    ).rejects.toThrow("string error");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("uses default options when none provided", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("net"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn);
    // Default baseDelayMs=1000, jitter="full" → delay is random in [0,1000]
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("ok");
  });

  it("respects per-attempt timeout", async () => {
    // Simulate a slow operation that exceeds the per-attempt timeout.
    // On first call, fn returns a promise that never settles (simulating a hang).
    // On second call (after retry), fn resolves successfully.
    const fn = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise(() => {}), // hangs forever — triggers timeout
      )
      .mockResolvedValueOnce("recovered");

    const onRetry = vi.fn();
    const promise = withRetry(fn, {
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
      timeoutMs: 500,
      onRetry,
    });

    // Let first attempt timeout (500ms)
    await vi.advanceTimersByTimeAsync(600);
    // Let retry backoff pass (100ms)
    await vi.advanceTimersByTimeAsync(200);
    // Second attempt resolves immediately (fn is mockResolvedValueOnce)

    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Verify the retry was triggered by a timeout classification
    const retryErr = onRetry.mock.calls[0][2];
    expect(retryErr.code).toBe("TIMEOUT");
  });

  it("passes a per-attempt abort signal that is aborted on timeout", async () => {
    let attemptSignal: AbortSignal | undefined;
    const fn = vi.fn((signal?: AbortSignal) => {
      attemptSignal = signal;
      return new Promise(() => {});
    });

    const promise = withRetry(fn, {
      maxRetries: 0,
      timeoutMs: 500,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(600);

    await assertion;
    expect(attemptSignal).toBeInstanceOf(AbortSignal);
    expect(attemptSignal?.aborted).toBe(true);
    expect(attemptSignal?.reason).toBeInstanceOf(TimeoutError);
  });
});

describe("withRetryResult", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns metadata with retry count and elapsed time", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("net"))
      .mockResolvedValueOnce("ok");

    const promise = withRetryResult(fn, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: "none",
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result.value).toBe("ok");
    expect(result.retries).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reports 0 retries on first-attempt success", async () => {
    const fn = vi.fn().mockResolvedValue("instant");
    const result = await withRetryResult(fn);
    expect(result.value).toBe("instant");
    expect(result.retries).toBe(0);
  });
});
